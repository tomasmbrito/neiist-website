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

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class {} },
    calendar: () => ({
      events: {
        list: async () => ({ data: { items: [] } }),
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
        delete: async () => ({ data: {} }),
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

describe("syncEventsToCalendarBatched only writes public events (#202)", () => {
  beforeEach(() => {
    inserted.length = 0;
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
