import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionEvent } from "@/types/events";

/**
 * #202 — internal meetings must never be written to a user's Google Calendar.
 *
 * These calendars are created with the Google Calendar API's **public** ACL scope
 * (`scope: { type: "default" }`), so anything written to one is world-readable. The route passed
 * every Notion event, internal meetings included, while the sibling sync path had always filtered
 * on `e.public`.
 *
 * The Google client is mocked, and the assertion is on **which events reach `events.insert`** —
 * that is the security property. This is not a test that a mock returns what it was told to: the
 * mock is the boundary being observed, and the filtering under test is entirely our own.
 */
const inserted: string[] = [];
const deleted: string[] = [];
/** Google ids already on the calendar, so the "clean up what leaked" path can be exercised. */
let existingOnCalendar: string[] = [];

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class {} },
    calendar: () => ({
      events: {
        list: async () => ({
          data: {
            items: existingOnCalendar.map((id) => ({
              id,
              extendedProperties: { private: { notionLastEdited: "2000-01-01T00:00:00.000Z" } },
            })),
          },
        }),
        insert: async ({ requestBody }: { requestBody: { summary: string } }) => {
          inserted.push(requestBody.summary);
          return { data: {} };
        },
        update: async ({ requestBody }: { requestBody: { summary: string } }) => {
          inserted.push(requestBody.summary);
          return { data: {} };
        },
        get: async () => {
          throw Object.assign(new Error("not found"), { code: 404 });
        },
        delete: async ({ eventId }: { eventId: string }) => {
          deleted.push(eventId);
          return { data: {} };
        },
      },
    }),
  },
}));

// The module reads a service-account file at import time in some paths; point it somewhere inert.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, default: { ...actual, readFileSync: () => "{}", existsSync: () => false } };
});

const event = (id: string, isPublic: boolean, title: string): NotionEvent =>
  ({
    id,
    title,
    date: "2026-09-01T10:00:00.000Z",
    endDate: "2026-09-01T12:00:00.000Z",
    location: [],
    teams: [],
    attendees: [],
    type: "Event",
    public: isPublic,
    url: "https://notion.so/x",
  }) as unknown as NotionEvent;

/**
 * Both batchers, deliberately. The first fix for #202 covered only
 * `syncEventsToCalendarBatched`, so this file passed while `syncAllEventsToCalendar` — the one
 * the Notion webhook drives across every user with a calendar — kept leaking. A test that guards
 * the half already fixed is worse than none, because it reads like coverage.
 */
describe("syncEventsToCalendarBatched only writes public events (#202)", () => {
  beforeEach(() => {
    inserted.length = 0;
    deleted.length = 0;
    existingOnCalendar = [];
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "{}");
  });

  it("writes public events and never internal ones", async () => {
    const { syncEventsToCalendarBatched } = await import("@/utils/googleCalendar");

    const synced = await syncEventsToCalendarBatched(
      "cal-1",
      [
        event("11111111-0000-0000-0000-000000000001", true, "Semana Informática"),
        event("22222222-0000-0000-0000-000000000002", false, "Reunião interna de coordenação"),
        event("33333333-0000-0000-0000-000000000003", true, "Sessão aberta"),
        event("44444444-0000-0000-0000-000000000004", false, "Reunião da direção"),
      ],
      "member@tecnico.ulisboa.pt"
    );

    // The two internal meetings must not appear anywhere in what was sent to Google.
    expect(inserted).not.toContain("Reunião interna de coordenação");
    expect(inserted).not.toContain("Reunião da direção");
    expect(inserted).toContain("Semana Informática");
    expect(inserted).toContain("Sessão aberta");

    // And the reported count reflects what was actually written, not what was offered — a caller
    // trusting `synced` should not be told 4.
    expect(synced).toBe(2);
  });

  it("writes nothing at all when every event is internal", async () => {
    const { syncEventsToCalendarBatched } = await import("@/utils/googleCalendar");

    const synced = await syncEventsToCalendarBatched(
      "cal-1",
      [
        event("55555555-0000-0000-0000-000000000005", false, "Interna A"),
        event("66666666-0000-0000-0000-000000000006", false, "Interna B"),
      ],
      "member@tecnico.ulisboa.pt"
    );

    expect(inserted).toEqual([]);
    expect(synced).toBe(0);
  });
});

describe("syncAllEventsToCalendar only writes public events (#202)", () => {
  beforeEach(() => {
    inserted.length = 0;
    deleted.length = 0;
    existingOnCalendar = [];
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "{}");
  });

  it("writes public events and never internal ones", async () => {
    // This is the path the Notion webhook uses, for EVERY user who has a NEIIST calendar — the
    // higher-volume sink, and the one the first #202 fix missed entirely.
    const { syncAllEventsToCalendar } = await import("@/utils/googleCalendar");

    await syncAllEventsToCalendar(
      "cal-1",
      [
        event("11111111-0000-0000-0000-000000000001", true, "Semana Informática"),
        event("22222222-0000-0000-0000-000000000002", false, "Reunião interna de coordenação"),
        event("33333333-0000-0000-0000-000000000003", false, "Reunião da direção"),
      ],
      "member@tecnico.ulisboa.pt"
    );

    expect(inserted).not.toContain("Reunião interna de coordenação");
    expect(inserted).not.toContain("Reunião da direção");
    expect(inserted).toContain("Semana Informática");
  });

  it("writes nothing when every event is internal", async () => {
    const { syncAllEventsToCalendar } = await import("@/utils/googleCalendar");

    await syncAllEventsToCalendar(
      "cal-1",
      [
        event("55555555-0000-0000-0000-000000000005", false, "Interna A"),
        event("66666666-0000-0000-0000-000000000006", false, "Interna B"),
      ],
      "member@tecnico.ulisboa.pt"
    );

    expect(inserted).toEqual([]);
  });
});

describe("cleaning up what earlier versions leaked (#202)", () => {
  beforeEach(() => {
    inserted.length = 0;
    deleted.length = 0;
    existingOnCalendar = [];
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_KEY", "{}");
  });

  it("REMOVES an internal event that is already on the calendar", async () => {
    // The property that makes this a remediation rather than only a fix. Both callers treat
    // "should not sync" as "delete if present", so the next sync after this ships takes the
    // internal meetings earlier versions wrote off every user's calendar.
    //
    // It is also the thing that distinguishes filtering in the shared `shouldSyncToCalendar`
    // from filtering only at the write point: if the pre-filter in syncAllEventsToCalendar does
    // not know about `public`, an internal event is queued as an update, silently refused at the
    // write, and never queued for deletion — so it stays on the calendar forever.
    const internalId = "22222222-0000-0000-0000-000000000002";
    const googleId = internalId.replace(/-/g, "").substring(0, 64);
    existingOnCalendar = [googleId];

    const { syncAllEventsToCalendar } = await import("@/utils/googleCalendar");
    await syncAllEventsToCalendar(
      "cal-1",
      [event(internalId, false, "Reunião interna já sincronizada")],
      "member@tecnico.ulisboa.pt"
    );

    expect(deleted).toContain(googleId);
    expect(inserted).toEqual([]);
  });
});
