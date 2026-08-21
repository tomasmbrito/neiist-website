import { NextRequest, NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { Permission } from "@/lib/auth/permissions";
import { serverCheckPermission, serverCheckRoles } from "@/utils/permissionUtils";

/**
 * How a wrapped route decides who may call it (#147).
 *
 * - `permission` — the caller must hold it.
 * - `authenticated` — any signed-in user, the `serverCheckRoles([])` case.
 *
 * Required, with no default, on purpose. The bug this fixes was authorization happening *after*
 * validation because the wrapper had no idea authorization existed; making a route state its
 * rule here means a new one cannot quietly inherit the old ordering.
 */
export type ValidationAuth = { permission: Permission } | { authenticated: true };

async function authorize(auth: ValidationAuth) {
  return "permission" in auth ? serverCheckPermission(auth.permission) : serverCheckRoles([]);
}

/** What `authorize` returns on success, handed to the handler so it need not check again. */
export type AuthorizedCaller = Awaited<ReturnType<typeof authorize>>;

/**
 * Authorize first, then parse the body.
 *
 * The order is the whole point. This wrapper used to `schema.parse(body)` before calling the
 * handler, and the handler was where `serverCheckRoles` lived — so every wrapped route answered
 * *unauthenticated* callers with Zod's field-by-field validation detail for an endpoint they had
 * no right to touch. Reproduced against a production build: an anonymous
 * `POST /api/shop/discounts` (an admin-only endpoint) returned 400 with the full shape of
 * `bulkDiscountCodePayloadSchema` instead of 401.
 *
 * It also wasted work: an unauthenticated request had its body read and validated before being
 * rejected.
 *
 * Fixing it in the wrapper rather than in each route is deliberate — the previous shape made the
 * wrong order the *default*, so every future route would have had to remember.
 */
export function withValidation<T, C>(
  schema: ZodSchema<T>,
  auth: ValidationAuth,
  handler: (
    _req: NextRequest,
    _parsedData: T,
    _context: C,
    /**
     * The authorization result the wrapper already computed. Passed down so a handler that needs
     * the caller's roles or user does not repeat the check — which also saves the `getUser`
     * round trip `serverCheckRoles` performs on every call.
     */
    _auth: AuthorizedCaller
  ) => Promise<NextResponse | Response | void | undefined>
) {
  return async (req: NextRequest, context: C) => {
    // Before req.json(), so an unauthorized caller learns nothing about the payload and we do
    // not read a body we are about to discard.
    const check = await authorize(auth);
    if (!check.isAuthorized) {
      // The success and failure shapes are not a discriminated union, so `error` is optional to
      // the compiler. The fallback keeps the wrapper's return type free of `undefined` rather
      // than pushing that uncertainty onto every caller.
      return check.error ?? NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    try {
      const body = await req.json();
      const parsedData = schema.parse(body);
      const result = await handler(req, parsedData, context, check);
      return result ?? NextResponse.json({ error: "No response" }, { status: 500 });
    } catch (error: unknown) {
      const err = error as Error & {
        name?: string;
        errors?: Array<{ path: Array<string | number>; message: string }>;
      };
      if (err?.name === "ZodError" || error instanceof ZodError) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: (err.errors || []).map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          },
          { status: 400 }
        );
      }
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
  };
}
