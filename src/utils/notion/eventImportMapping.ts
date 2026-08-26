/**
 * Mapping Notion's events database onto `neiist.internal_events` (#210).
 *
 * Kept separate from the script so it can be tested against recorded payloads without a live
 * Notion API — the script is I/O, this is the decisions.
 *
 * Measured against the real data source on 2026-08-26 (52 rows):
 *
 * ```
 *   (no team)              Event    22   (16 public)
 *   (no team)              Meeting   2
 *   Coordenação/Direção    Meeting   3
 *   Dev-Team               Meeting  10
 *   Organização de Eventos Meeting  15
 * ```
 */

export type NotionEventRow = {
  url: string;
  Name: string | null;
  Type: "Meeting" | "Event" | null;
  Team: string | null;
  Public: "__YES__" | "__NO__" | null;
  Location: string | null;
  Attendees: string | null;
  "date:Date:start": string | null;
  "date:Date:end": string | null;
  "date:Date:is_datetime": number | null;
};

/**
 * Notion team names that do not match `neiist.departments.name`.
 *
 * **Declared, never fuzzy-matched.** A normaliser that stripped accents and punctuation would turn
 * "Controlo e Qualidade" into "Controlo & Qualidade" by luck, and would just as happily turn a
 * genuine typo into the wrong team. Two names differ; both are written down.
 *
 * `Coordenação/Direção` is the interesting one. Tomás: *"when we say Coordenação/Direção it means
 * that both coordinators and board members have access to that."* It names two groups, so it maps
 * to Direção as owner **plus every team as collaborators** (#219) — which is what collaborating
 * teams are for, and is better than silently picking one of the two.
 */
export const TEAM_ALIASES: Readonly<Record<string, string>> = {
  "Controlo e Qualidade": "Controlo & Qualidade",
  "Coordenação/Direção": "Direção",
};

/** The Notion value that means "both the coordinators and the board". */
export const COORDINATION_AND_BOARD = "Coordenação/Direção";

/**
 * Where a row with **no Team** goes.
 *
 * 24 of the 52 rows have none, so refusing them outright would import less than half the data and
 * leave the rest to be typed by hand. Guessing silently would be worse. So: a declared default
 * that the dry run prints, overridable with `--event-team` / `--meeting-team`.
 *
 * The defaults come from how NEIIST actually works, in Tomás's words: *"The events are managed by
 * the Organização de Eventos team… this team that starts in the organização de eventos (or
 * directly at the board for some more important events)"*. So an untagged **event** belongs to
 * Organização de Eventos, and an untagged **meeting** — there are two — to the Direção.
 */
export const DEFAULT_EVENT_TEAM = "Organização de Eventos";
export const DEFAULT_MEETING_TEAM = "Direção";

export type MappedEvent = {
  notionPageId: string;
  kind: "event" | "meeting";
  name: string;
  startsAt: string;
  endsAt: string | null;
  /** `public` only when Notion says so AND the row is not already on /activities. */
  visibility: "public" | "members" | "teams" | "owner";
  departmentName: string;
  locations: string[];
  /** Notion person ids; the caller resolves them to istids and reports what it cannot. */
  notionAttendeeIds: string[];
  collaborators: string[];
  /** Anything a human should look at, even though the row imported. */
  notes: string[];
};

export type MappingFailure = { notionPageId: string; name: string; reason: string };

const parseJsonArray = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/** The page id is the last path segment of the Notion URL, without dashes. */
export const notionPageId = (url: string): string =>
  (url.split("/").pop() ?? url).split("?")[0].replace(/-/g, "");

/**
 * Turn one Notion row into something importable, or say why it cannot be.
 *
 * @param knownDepartments     names from `neiist.departments`, so an unknown team fails here
 *                             rather than at the foreign key
 * @param allTeams             team-type departments, for expanding "Coordenação/Direção"
 * @param alreadyOnActivities  the page is already published by the old Notion sync
 */
export function mapNotionEvent(
  row: NotionEventRow,
  knownDepartments: readonly string[],
  allTeams: readonly string[],
  alreadyOnActivities: boolean,
  overrides: { eventTeam?: string; meetingTeam?: string } = {}
): { ok: true; event: MappedEvent } | { ok: false; failure: MappingFailure } {
  const id = notionPageId(row.url);
  const name = (row.Name ?? "").trim();

  if (!name) {
    return { ok: false, failure: { notionPageId: id, name: "(sem nome)", reason: "sem título" } };
  }
  if (!row["date:Date:start"]) {
    return { ok: false, failure: { notionPageId: id, name, reason: "sem data" } };
  }

  // Notion's Type is `Meeting|Event`. An absent Type is treated as a MEETING: meetings are the
  // internal, invisible kind, so an unreadable row fails towards less exposure, not more — the
  // same direction as the `Public` rule below and the #127 decision behind it.
  const kind: "event" | "meeting" = row.Type === "Event" ? "event" : "meeting";

  const rawTeam = row.Team?.trim() || null;
  const isCoordination = rawTeam === COORDINATION_AND_BOARD;
  const resolvedTeam = rawTeam
    ? (TEAM_ALIASES[rawTeam] ?? rawTeam)
    : kind === "event"
      ? (overrides.eventTeam ?? DEFAULT_EVENT_TEAM)
      : (overrides.meetingTeam ?? DEFAULT_MEETING_TEAM);

  if (!knownDepartments.includes(resolvedTeam)) {
    return {
      ok: false,
      failure: {
        notionPageId: id,
        name,
        reason: `equipa desconhecida: "${rawTeam ?? "(nenhuma)"}" -> "${resolvedTeam}"`,
      },
    };
  }

  const notes: string[] = [];

  // `Public` fails CLOSED. The checkbox is present on every page once the property exists, so the
  // null branch is only reached when the property itself is missing — i.e. somebody renamed or
  // deleted it. #127 decided that at that moment every event must NOT silently become public.
  const isPublic = row.Public === "__YES__";
  if (row.Public === null) notes.push("sem propriedade Public — importado como interno");

  let visibility: MappedEvent["visibility"];
  if (!isPublic) {
    visibility = "teams";
  } else if (alreadyOnActivities) {
    // The old Notion -> activities sync still publishes this page. Importing it as `public` too
    // would show it TWICE on the students' calendar. Members-only for now; #137 retires the sync
    // and flips these. Reported rather than done quietly.
    visibility = "members";
    notes.push("já aparece em /activities pela sync do Notion — importado como members (#137)");
  } else {
    visibility = "public";
  }

  // "Coordenação/Direção" means both the board and the coordinators: the event is owned by the
  // Direção and every team collaborates, rather than picking one and losing the other half.
  const collaborators = isCoordination ? [...allTeams] : [];
  if (isCoordination) notes.push("Coordenação/Direção — Direção como dona, equipas a colaborar");

  return {
    ok: true,
    event: {
      notionPageId: id,
      kind,
      name,
      startsAt: row["date:Date:start"],
      endsAt: row["date:Date:end"] || null,
      visibility,
      departmentName: resolvedTeam,
      locations: parseJsonArray(row.Location),
      notionAttendeeIds: parseJsonArray(row.Attendees),
      collaborators,
      notes,
    },
  };
}
