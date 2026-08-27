/**
 * Import the NEIIST Notion events database into `neiist.internal_events` (#210, #126 Phase 1).
 *
 * ## Why this is a script and not a sync
 *
 * This is a **one-way door**, run once (and then re-run as needed until it looks right), not a
 * recurring job. Phase 10 (#137) retires Notion as an operational system; until then the old
 * Notion -> `neiist.activities` sync keeps running for the public calendar, and this fills the
 * workspace. Afterwards, the website is the source of truth and nothing imports anything.
 *
 * ## The rules, and why each one is here
 *
 * - **`--dry-run` is the default.** Writing requires `--yes`, exactly like `db:migrate --baseline`.
 *   An import that misreads the `Public` checkbox publishes internal meetings to students, which
 *   is the failure #127 and #202 both hit from different directions. A human reads the plan first.
 * - **Idempotent.** Keyed on `notion_page_id`, unique. Re-running updates instead of duplicating,
 *   which also makes a half-finished run resumable by just running it again.
 * - **Fails closed.** No `Public` property, or an unreadable `Type`, imports as internal.
 * - **Refuses an unknown team** rather than guessing, and prints every one it refused so somebody
 *   can fix Notion or add the department.
 * - **Reports, never invents.** An attendee whose email matches no `neiist.users` row is listed
 *   and skipped; the event still imports.
 *
 * ## Usage
 *
 *   yarn import:notion                 dry run — prints the full plan, writes nothing
 *   yarn import:notion --yes           actually write
 *   yarn import:notion --event-team "X"    owner for untagged events   (default: Organização de Eventos)
 *   yarn import:notion --meeting-team "Y"  owner for untagged meetings (default: Direção)
 *
 * Needs `NOTION_API_KEY` and `NOTION_EVENTS_DATABASE_ID`, plus `MIGRATION_DATABASE_URL` (the owner
 * role — `DATABASE_URL` is the application role and `schema.sql:11-16` gives it no table
 * privileges by design).
 */
import { Client as Pg } from "pg";
import {
  DEFAULT_EVENT_TEAM,
  DEFAULT_MEETING_TEAM,
  mapNotionEvent,
  notionPageId,
  type MappedEvent,
  type MappingFailure,
  type NotionEventRow,
} from "../src/utils/notion/eventImportMapping.ts";

/**
 * Two API generations, because NEIIST's events database is **multi-source**.
 *
 * `Databases` in Notion holds seven data sources — Events/Meetings, Tasks, Members, Contacts,
 * Businesses, Inflows and Outflows, Requirements. The 2022-06-28 API predates that model: it has
 * no concept of a data source, so a multi-source database is not addressable through
 * `/v1/databases/{id}/query` and does not even appear in `/v1/search`. That produces a 404 whose
 * message says "make sure the database is shared with your integration" — which sends you off
 * checking permissions that were already correct. It cost an hour; hence this comment.
 *
 * `2025-09-03` introduced `/v1/data_sources/{id}/query`, which is what actually reaches
 * Events/Meetings. The old path is kept as a fallback so the script still works against a plain
 * single-source database, and so it does not break if NEIIST restructures Notion later.
 */
const NOTION_DATA_SOURCE_VERSION = "2025-09-03";
const NOTION_LEGACY_VERSION = "2022-06-28";
/** Stable across both generations. */
const NOTION_USERS_VERSION = NOTION_LEGACY_VERSION;

type NotionPage = { id: string; properties: Record<string, unknown>; url?: string };

/** Read one Notion property into the flat shape `mapNotionEvent` expects. */
function flatten(page: NotionPage): NotionEventRow {
  const props = page.properties as Record<string, any>;
  const title = props.Name?.title?.map((t: any) => t.plain_text).join("") ?? null;
  const date = props.Date?.date ?? null;

  return {
    url: page.url ?? `https://app.notion.com/p/${page.id}`,
    Name: title,
    Type: props.Type?.select?.name ?? null,
    Team: props.Team?.select?.name ?? null,
    // The checkbox is `undefined` only when the PROPERTY is absent — renamed or deleted. That is
    // the case that must fail closed, so it is preserved as null rather than coerced to false.
    Public:
      props.Public === undefined ? null : props.Public?.checkbox === true ? "__YES__" : "__NO__",
    Location: JSON.stringify(
      (props.Location?.multi_select ?? []).map((option: any) => option.name)
    ),
    Attendees: JSON.stringify((props.Attendees?.people ?? []).map((person: any) => person.id)),
    "date:Date:start": date?.start ?? null,
    "date:Date:end": date?.end ?? null,
    "date:Date:is_datetime": date?.start?.includes("T") ? 1 : 0,
  };
}

type QueryRoute = { label: string; version: string; path: (id: string) => string };

/**
 * Newest first. The data-source route is the one that reaches a multi-source database; the legacy
 * route is kept so a plain single-source database still works.
 */
const QUERY_ROUTES: QueryRoute[] = [
  {
    label: "data_sources (2025-09-03)",
    version: NOTION_DATA_SOURCE_VERSION,
    path: (id) => `https://api.notion.com/v1/data_sources/${id}/query`,
  },
  {
    label: "databases (2022-06-28)",
    version: NOTION_LEGACY_VERSION,
    path: (id) => `https://api.notion.com/v1/databases/${id}/query`,
  },
];

/** One page of results, or the HTTP status so the caller can decide whether to try another route. */
async function queryOnce(
  route: QueryRoute,
  id: string,
  apiKey: string,
  cursor?: string
): Promise<
  | { ok: true; results: NotionPage[]; next: string | undefined }
  | { ok: false; status: number; body: string }
> {
  const response = await fetch(route.path(id), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": route.version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  const body = (await response.json()) as {
    results: NotionPage[];
    next_cursor: string | null;
    has_more: boolean;
  };
  return {
    ok: true,
    results: body.results,
    next: body.has_more ? (body.next_cursor ?? undefined) : undefined,
  };
}

/**
 * Read every page, trying each API generation until one answers.
 *
 * Only 400 and 404 fall through to the next route — those mean "this endpoint does not know about
 * this id". A 401 is a bad key and a 403 is a real permission problem; retrying those on another
 * version would turn one clear error into two confusing ones.
 */
async function notionQuery(databaseId: string, apiKey: string): Promise<NotionPage[]> {
  const failures: string[] = [];

  for (const route of QUERY_ROUTES) {
    const first = await queryOnce(route, databaseId, apiKey);

    if (!first.ok) {
      if (first.status === 404 || first.status === 400) {
        failures.push(`  ${route.label}: ${first.status}`);
        continue;
      }
      throw new Error(`Notion returned ${first.status}: ${first.body}`);
    }

    console.log(`  (via ${route.label})`);
    const pages = [...first.results];
    let cursor = first.next;
    while (cursor) {
      const next = await queryOnce(route, databaseId, apiKey, cursor);
      if (!next.ok) throw new Error(`Notion returned ${next.status}: ${next.body}`);
      pages.push(...next.results);
      cursor = next.next;
    }
    return pages;
  }

  throw new Error(
    `Nenhuma rota da API do Notion encontrou "${databaseId}":\n${failures.join("\n")}\n\n` +
      "Verifica que:\n" +
      "  1. a integração tem acesso a este conteúdo (Conexões -> Content access), e\n" +
      "  2. o ID é o da DATA SOURCE Events/Meetings, não o da página que a contém.\n" +
      "     O ID aparece no URL quando abres a base de dados no Notion."
  );
}

/** Notion person id -> our istid, by email. Unmatched people are reported, never invented. */
async function resolvePeople(
  pg: Pg,
  apiKey: string,
  personIds: Set<string>
): Promise<{ byNotionId: Map<string, string>; unmatched: string[] }> {
  const byNotionId = new Map<string, string>();
  const unmatched: string[] = [];

  for (const id of personIds) {
    const response = await fetch(`https://api.notion.com/v1/users/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Notion-Version": NOTION_USERS_VERSION },
    });
    if (!response.ok) {
      unmatched.push(`${id} (não foi possível ler do Notion)`);
      continue;
    }
    const user = (await response.json()) as { name?: string; person?: { email?: string } };
    const email = user.person?.email;
    if (!email) {
      unmatched.push(`${user.name ?? id} (sem email no Notion)`);
      continue;
    }

    const { rows } = await pg.query<{ istid: string }>(
      "SELECT istid FROM neiist.users WHERE lower(email) = lower($1) LIMIT 1",
      [email]
    );
    if (rows[0]) byNotionId.set(id, rows[0].istid);
    else unmatched.push(`${user.name ?? id} <${email}> (sem conta no site)`);
  }

  return { byNotionId, unmatched };
}

async function main() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };

  const write = has("--yes");
  const eventTeam = valueOf("--event-team");
  const meetingTeam = valueOf("--meeting-team");

  const apiKey = process.env.NOTION_API_KEY;
  const databaseId = process.env.NOTION_EVENTS_DATABASE_ID ?? process.env.DATABASE_ID;
  if (!apiKey || !databaseId) {
    console.error(
      "NOTION_API_KEY and NOTION_EVENTS_DATABASE_ID must be set, and the events data source has " +
        "to be shared with the integration in Notion."
    );
    process.exit(1);
  }

  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set. The import writes tables, so it " +
        "needs the owner role — DATABASE_URL is the application role and has no table privileges."
    );
    process.exit(1);
  }

  const pg = new Pg({ connectionString });
  await pg.connect();

  try {
    const departments = await pg.query<{ name: string; department_type: string }>(
      "SELECT name, department_type FROM neiist.departments WHERE active"
    );
    const known = departments.rows.map((d) => d.name);
    const teams = departments.rows.filter((d) => d.department_type === "team").map((d) => d.name);

    // The importer records itself as the creator. It must be a real user, so it borrows the first
    // active Direção admin rather than inventing an account — the same rule as everywhere else in
    // this pipeline: nothing mints an identity as a side effect.
    const author = await pg.query<{ istid: string }>(
      `SELECT m.user_istid AS istid
       FROM neiist.membership m
       JOIN neiist.valid_department_roles v
         ON v.department_name = m.department_name AND v.role_name = m.role_name
       WHERE v.board_member AND v.active AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
       ORDER BY m.from_date LIMIT 1`
    );
    if (!author.rows[0]) {
      console.error(
        "No board member found to record as the importer. Add one first — the import does not " +
          "create a user to satisfy a foreign key."
      );
      process.exit(1);
    }
    const createdBy = author.rows[0].istid;

    console.log(`\nA ler o Notion (${databaseId})…`);
    const pages = await notionQuery(databaseId, apiKey);
    console.log(`  ${pages.length} páginas.\n`);

    const mapped: MappedEvent[] = [];
    const failures: MappingFailure[] = [];
    const personIds = new Set<string>();

    for (const page of pages) {
      const flat = flatten(page);
      const already = await pg.query<{ activity_exists: boolean }>(
        "SELECT neiist.activity_exists($1::TEXT)",
        [notionPageId(flat.url)]
      );
      const result = mapNotionEvent(flat, known, teams, already.rows[0].activity_exists, {
        eventTeam,
        meetingTeam,
      });
      if (result.ok) {
        mapped.push(result.event);
        result.event.notionAttendeeIds.forEach((id) => personIds.add(id));
      } else {
        failures.push(result.failure);
      }
    }

    const { byNotionId, unmatched } = await resolvePeople(pg, apiKey, personIds);

    // ----- the plan -------------------------------------------------------------------------
    console.log("PLANO");
    console.log("─".repeat(72));
    console.log(`  Equipa por omissão para eventos sem Team:   ${eventTeam ?? DEFAULT_EVENT_TEAM}`);
    console.log(
      `  Equipa por omissão para reuniões sem Team:  ${meetingTeam ?? DEFAULT_MEETING_TEAM}`
    );
    console.log();

    const byVisibility = mapped.reduce<Record<string, number>>((acc, event) => {
      acc[event.visibility] = (acc[event.visibility] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  ${mapped.length} a importar:`);
    for (const [visibility, count] of Object.entries(byVisibility)) {
      console.log(`     ${String(count).padStart(3)}  ${visibility}`);
    }
    console.log();

    for (const event of mapped) {
      const when = event.startsAt.slice(0, 10);
      console.log(
        `  ${when}  ${event.kind.padEnd(7)}  ${event.visibility.padEnd(7)}  ` +
          `${event.departmentName.padEnd(24)}  ${event.name}`
      );
      for (const note of event.notes) console.log(`              ↳ ${note}`);
    }

    if (failures.length > 0) {
      console.log(`\n  ${failures.length} RECUSADAS (nada é importado destas):`);
      for (const failure of failures) console.log(`     ${failure.name} — ${failure.reason}`);
    }

    if (unmatched.length > 0) {
      console.log(`\n  ${unmatched.length} participantes sem correspondência (ignorados):`);
      for (const person of unmatched) console.log(`     ${person}`);
    }

    if (!write) {
      console.log(
        "\n─ DRY RUN — nada foi escrito. Corre outra vez com --yes depois de leres o plano.\n"
      );
      // Non-zero when something was refused, so a CI or a careless operator notices.
      process.exit(failures.length > 0 ? 1 : 0);
    }

    // ----- the write ------------------------------------------------------------------------
    console.log("\nA importar…");
    let imported = 0;
    for (const event of mapped) {
      const attendees = event.notionAttendeeIds
        .map((id) => byNotionId.get(id))
        .filter((istid): istid is string => Boolean(istid));

      await pg.query(
        `SELECT neiist.import_internal_event(
           $1::TEXT, $2::TEXT, $3::TEXT, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ,
           $6::neiist.event_visibility_enum, $7::VARCHAR(30), $8::VARCHAR(50),
           $9::TEXT[], $10::VARCHAR(50)[], $11::VARCHAR(30)[])`,
        [
          event.notionPageId,
          event.kind,
          event.name,
          event.startsAt,
          event.endsAt,
          event.visibility,
          event.departmentName,
          createdBy,
          event.locations,
          attendees,
          event.collaborators,
        ]
      );
      imported += 1;
    }

    console.log(`\n✓ ${imported} importadas. Re-correr não duplica.\n`);
    if (failures.length > 0) process.exit(1);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
