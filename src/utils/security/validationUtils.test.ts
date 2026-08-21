import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

/**
 * #147 — the wrapper validated the body *before* the handler ran its authorization, so every
 * wrapped route answered unauthenticated callers with Zod's field-by-field detail for an
 * endpoint they had no right to touch. Reproduced against a production build: an anonymous
 * POST /api/shop/discounts returned 400 describing bulkDiscountCodePayloadSchema, not 401.
 *
 * These assert the *ordering*, which is the whole fix: authorization runs first, and the body is
 * never even read when it fails.
 */

const serverCheckPermission = vi.hoisted(() => vi.fn());
const serverCheckRoles = vi.hoisted(() => vi.fn());

vi.mock("@/utils/permissionUtils", () => ({ serverCheckPermission, serverCheckRoles }));

const { withValidation } = await import("@/utils/security/validationUtils");

const schema = z.object({ name: z.string() });

const authorized = { isAuthorized: true, roles: [], user: { istid: "ist1" } };
const denied = {
  isAuthorized: false,
  error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
};

/** Tracks whether the body was read at all — an unauthorized caller's never should be. */
const makeRequest = (body: unknown) => {
  const json = vi.fn().mockResolvedValue(body);
  return { json, request: { json } as unknown as NextRequest };
};

beforeEach(() => {
  serverCheckPermission.mockReset();
  serverCheckRoles.mockReset();
});

describe("withValidation authorizes before it validates", () => {
  it("returns the auth error without reading the body when permission is missing", async () => {
    serverCheckPermission.mockResolvedValue(denied);
    const handler = vi.fn();
    const route = withValidation(schema, { permission: "shop.discounts.manage" }, handler);

    // A body that would FAIL validation: the old order returned 400 describing the schema.
    const { json, request } = makeRequest({});
    const response = await route(request, undefined);

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled(); // the payload is never even parsed
  });

  it("uses serverCheckRoles([]) for the authenticated-only case", async () => {
    serverCheckRoles.mockResolvedValue(denied);
    const route = withValidation(schema, { authenticated: true }, vi.fn());

    const { request } = makeRequest({});
    const response = await route(request, undefined);

    expect(response.status).toBe(401);
    expect(serverCheckRoles).toHaveBeenCalledWith([]);
    expect(serverCheckPermission).not.toHaveBeenCalled();
  });

  it("still returns validation detail to a caller who IS authorized", async () => {
    serverCheckPermission.mockResolvedValue(authorized);
    const route = withValidation(schema, { permission: "shop.discounts.manage" }, vi.fn());

    const { request } = makeRequest({});
    const response = await route(request, undefined);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Validation failed" });
  });

  it("passes the parsed body and the auth result to the handler", async () => {
    serverCheckPermission.mockResolvedValue(authorized);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const route = withValidation(schema, { permission: "shop.discounts.manage" }, handler);

    const { request } = makeRequest({ name: "ana" });
    const response = await route(request, { params: 1 });

    expect(response.status).toBe(200);
    // The auth result is handed down so the handler need not repeat the check — which also
    // avoids a second getUser round trip.
    expect(handler).toHaveBeenCalledWith(request, { name: "ana" }, { params: 1 }, authorized);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    serverCheckPermission.mockResolvedValue(authorized);
    const route = withValidation(schema, { permission: "shop.discounts.manage" }, vi.fn());

    const request = {
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    } as unknown as NextRequest;
    const response = await route(request, undefined);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON payload" });
  });
});
