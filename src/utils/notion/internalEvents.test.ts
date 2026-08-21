import { describe, expect, it, vi, beforeEach } from "vitest";
import { UserRole } from "@/types/user";
import { can } from "@/lib/auth/permissions";

const fetchAllNotionEvents = vi.hoisted(() => vi.fn());
const isNotionConfigured = vi.hoisted(() => vi.fn());

vi.mock("@/utils/eventsUtils", () => ({ fetchAllNotionEvents, isNotionConfigured }));
// unstable_cache wraps the function; for a unit test we want the function itself.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));

const { getInternalNotionEvents } = await import("@/utils/notion/internalEvents");

const event = (over: Record<string, unknown>) => ({
  id: "1",
  title: "Reunião",
  date: "2026-09-01T18:00:00Z",
  end: null,
  url: "",
  location: [],
  type: "Meeting",
  teams: [],
  attendees: [],
  lastEditedTime: "2026-08-01T00:00:00Z",
  public: false,
  ...over,
});

beforeEach(() => {
  fetchAllNotionEvents.mockReset();
  isNotionConfigured.mockReset().mockReturnValue(true);
});

describe("getInternalNotionEvents", () => {
  it("returns only non-public events", async () => {
    fetchAllNotionEvents.mockResolvedValue([
      event({ id: "pub", public: true }),
      event({ id: "int", public: false }),
    ]);

    const result = await getInternalNotionEvents();

    expect(result.map((e) => e.id)).toEqual(["int"]);
  });

  /**
   * #118's rule, applied to the second Notion call: a third-party outage must not take
   * /activities down. The public half already survives this; the internal half must too.
   */
  it("returns an empty list rather than throwing when Notion fails", async () => {
    fetchAllNotionEvents.mockRejectedValue(new Error("Notion is down"));
    await expect(getInternalNotionEvents()).resolves.toEqual([]);
  });

  it("returns an empty list when Notion is not configured, without calling it", async () => {
    isNotionConfigured.mockReturnValue(false);
    await expect(getInternalNotionEvents()).resolves.toEqual([]);
    expect(fetchAllNotionEvents).not.toHaveBeenCalled();
  });
});

/**
 * The boundary that matters. These assert the permission itself rather than the component,
 * because the page decides *before* fetching — filtering in the component would already have
 * put internal events in the anonymous payload.
 */
describe("activities.viewInternal", () => {
  it("excludes an anonymous or external visitor", () => {
    expect(can([UserRole._GUEST], "activities.viewInternal")).toBe(false);
    expect(can([], "activities.viewInternal")).toBe(false);
    expect(can(undefined, "activities.viewInternal")).toBe(false);
  });

  it.each([UserRole._MEMBER, UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN])(
    "includes %s",
    (role) => {
      expect(can([role], "activities.viewInternal")).toBe(true);
    }
  );
});
