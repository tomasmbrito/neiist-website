import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_TEAM,
  DEFAULT_MEETING_TEAM,
  mapNotionEvent,
  notionPageId,
  type NotionEventRow,
} from "@/utils/notion/eventImportMapping";

/**
 * #210 — the Notion -> workspace mapping.
 *
 * Tested against **recorded payloads in the real shape**, not a live API: the SQLite projection
 * Notion exposes, taken from the actual data source on 2026-08-26. A test that hit the live
 * database would fail whenever somebody edited an event, and would need credentials to run in CI.
 *
 * The properties that matter here are the ones where a mistake is not recoverable by re-running:
 * publishing something internal, and attaching an event to the wrong team.
 */
const DEPARTMENTS = [
  "Direção",
  "Conselho Fiscal",
  "Mesa da Assembleia Geral",
  "Contacto",
  "Controlo & Qualidade",
  "Dev-Team",
  "Divulgação",
  "Fotografia",
  "Organização de Eventos",
  "Visuais",
];
const TEAMS = [
  "Contacto",
  "Controlo & Qualidade",
  "Dev-Team",
  "Divulgação",
  "Fotografia",
  "Organização de Eventos",
  "Visuais",
];

const row = (over: Partial<NotionEventRow> = {}): NotionEventRow => ({
  url: "https://app.notion.com/p/24b4ecf9fdeb80bfa15fdebc1f45480c",
  Name: "Reunião semanal",
  Type: "Meeting",
  Team: "Dev-Team",
  Public: "__NO__",
  Location: '["Alameda"]',
  Attendees: "[]",
  "date:Date:start": "2026-09-01T18:00:00.000+01:00",
  "date:Date:end": null,
  "date:Date:is_datetime": 1,
  ...over,
});

const map = (
  r: NotionEventRow,
  alreadyOnActivities = false,
  overrides: { eventTeam?: string; meetingTeam?: string } = {}
) => mapNotionEvent(r, DEPARTMENTS, TEAMS, alreadyOnActivities, overrides);

describe("identity", () => {
  it("takes the page id from the URL, without dashes", () => {
    expect(notionPageId("https://app.notion.com/p/24a4-ecf9-fdeb")).toBe("24a4ecf9fdeb");
  });

  it("ignores a query string", () => {
    // Notion URLs carry ?pvs=204 and friends; a page id with that glued on would defeat the
    // unique index and import the same event twice.
    expect(notionPageId("https://app.notion.com/p/abc123?pvs=204")).toBe("abc123");
  });
});

describe("the Public checkbox fails CLOSED", () => {
  it("imports an unchecked event as team-internal", () => {
    const result = map(row({ Type: "Event", Public: "__NO__" }));
    expect(result.ok && result.event.visibility).toBe("teams");
  });

  it("imports an event with NO Public property as internal, and says so", () => {
    // The null branch is only reached when the property itself is gone — renamed or deleted. #127
    // decided that at that moment every event must not silently become public.
    const result = map(row({ Type: "Event", Public: null }));
    expect(result.ok && result.event.visibility).toBe("teams");
    expect(result.ok && result.event.notes.join(" ")).toContain("sem propriedade Public");
  });

  it("publishes a checked event that is not already on /activities", () => {
    const result = map(row({ Type: "Event", Public: "__YES__" }), false);
    expect(result.ok && result.event.visibility).toBe("public");
  });

  it("treats an unreadable Type as a MEETING, not an event", () => {
    // Fails towards less exposure: meetings are the internal kind.
    const result = map(row({ Type: null }));
    expect(result.ok && result.event.kind).toBe("meeting");
  });
});

describe("not publishing the same thing twice", () => {
  it("imports a public event that /activities already shows as members-only", () => {
    // 16 of the 52 are public and already reach students through the old Notion sync. Importing
    // them as `public` too would put every one of them on the calendar twice.
    const result = map(row({ Type: "Event", Public: "__YES__" }), true);
    expect(result.ok && result.event.visibility).toBe("members");
    expect(result.ok && result.event.notes.join(" ")).toContain("#137");
  });

  it("still publishes it once the page is no longer synced", () => {
    const result = map(row({ Type: "Event", Public: "__YES__" }), false);
    expect(result.ok && result.event.visibility).toBe("public");
  });
});

describe("team names", () => {
  it("maps 'Controlo e Qualidade' onto 'Controlo & Qualidade'", () => {
    const result = map(row({ Team: "Controlo e Qualidade" }));
    expect(result.ok && result.event.departmentName).toBe("Controlo & Qualidade");
  });

  it("REFUSES an unknown team instead of dropping the event", () => {
    // Silently skipping is the failure mode this guards: the event vanishes and nobody notices.
    const result = map(row({ Team: "Equipa Que Não Existe" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toContain("equipa desconhecida");
  });

  it("does not invent a team by fuzzy matching", () => {
    // "Dev Team" without the hyphen is a typo, not an alias. Guessing here would attach somebody's
    // meeting to the wrong workspace.
    const result = map(row({ Team: "Dev Team" }));
    expect(result.ok).toBe(false);
  });

  it("expands Coordenação/Direção to Direção plus every team", () => {
    // It names two groups. Picking one loses the other half; collaborating teams (#219) express
    // exactly this, which is why #210 waited for it.
    const result = map(row({ Team: "Coordenação/Direção" }));
    expect(result.ok && result.event.departmentName).toBe("Direção");
    expect(result.ok && result.event.collaborators.sort()).toEqual([...TEAMS].sort());
  });

  it("gives a plain team no collaborators", () => {
    const result = map(row({ Team: "Dev-Team" }));
    expect(result.ok && result.event.collaborators).toEqual([]);
  });
});

describe("rows with no team at all — 24 of the 52", () => {
  it("sends an untagged EVENT to Organização de Eventos", () => {
    const result = map(row({ Type: "Event", Team: null }));
    expect(result.ok && result.event.departmentName).toBe(DEFAULT_EVENT_TEAM);
  });

  it("sends an untagged MEETING to the Direção", () => {
    const result = map(row({ Type: "Meeting", Team: null }));
    expect(result.ok && result.event.departmentName).toBe(DEFAULT_MEETING_TEAM);
  });

  it("lets the operator override both from the command line", () => {
    const result = map(row({ Type: "Event", Team: null }), false, { eventTeam: "Divulgação" });
    expect(result.ok && result.event.departmentName).toBe("Divulgação");
  });

  it("refuses an override naming a department that does not exist", () => {
    const result = map(row({ Type: "Event", Team: null }), false, { eventTeam: "Nope" });
    expect(result.ok).toBe(false);
  });
});

describe("rows that cannot be imported", () => {
  it("refuses a row with no title", () => {
    expect(map(row({ Name: "   " })).ok).toBe(false);
  });

  it("refuses a row with no date", () => {
    // `starts_at` is NOT NULL, and an event with no date is not an event.
    expect(map(row({ "date:Date:start": null })).ok).toBe(false);
  });
});

describe("the rest of the payload", () => {
  it("reads locations from the multi-select", () => {
    const result = map(row({ Location: '["Alameda","Online"]' }));
    expect(result.ok && result.event.locations).toEqual(["Alameda", "Online"]);
  });

  it("survives a malformed JSON array rather than losing the event", () => {
    // One unreadable property must not cost the whole row — the same judgement #129 made about
    // a stale attendee.
    const result = map(row({ Location: "{not json" }));
    expect(result.ok && result.event.locations).toEqual([]);
  });

  it("carries the end date through, and null when it is a single date", () => {
    expect(map(row({ "date:Date:end": "2026-09-01T20:00:00.000+01:00" })).ok).toBe(true);
    const single = map(row({ "date:Date:end": null }));
    expect(single.ok && single.event.endsAt).toBeNull();
  });

  it("passes Notion person ids through for the caller to resolve", () => {
    // Deliberately NOT resolved here: matching people to accounts needs the database, and an
    // unmatched person must be reported rather than invented.
    const result = map(row({ Attendees: '["user-1","user-2"]' }));
    expect(result.ok && result.event.notionAttendeeIds).toEqual(["user-1", "user-2"]);
  });
});
