# Plan: Bind SumUp payment confirmation to the order (#73)

## Goal

After this change, no order can reach `paid` unless a payment that SumUp itself confirms,
for the right amount, against the right order reference, has occurred exactly once.

Today an unauthenticated attacker can mark any order paid, and a single genuine €1 payment
can finalize unlimited future orders.

## Context — all verified against source, not relayed

### Bug 1: reader callback is unauthenticated and trusts the body
`src/app/api/shop/sumup/readers/callback/route.ts` — no auth, no signature, no shared secret.

- `:25` reads `status` straight from `body.payload.status`
- `:38` the SumUp transaction lookup only runs `if (clientTransactionId && SUMUP_MERCHANT_CODE && …)`
- `:51` its failure is a bare `console.warn` — it gates nothing
- `:56` `finalizePaidOrder` is called purely on the body-supplied status

```
POST /api/shop/sumup/readers/callback?orderId=123
{"payload":{"status":"successful"}}
```
→ order 123 paid, confirmation email sent, and for jantar-de-curso items the buyer is
auto-registered for the event. Order IDs are sequential, so every pending order is walkable.

### Bug 2: no checkout is ever bound to its order
`src/app/api/shop/sumup/verify/route.ts` — `order.total_amount` is used at `:45`/`:55` only to
**create** a checkout. Nothing compares the *returned* checkout's `amount` or
`checkout_reference` to the order before `finalizePaidOrder` at `:94`.

`src/app/api/shop/sumup/callback/route.ts:101` has the only binding check —
`if (order.payment_reference && order.payment_reference !== checkoutId)` — which is **skipped
entirely when `payment_reference` is empty**, i.e. every order that never started a SumUp
checkout (in-person, MB Way).

`orders.payment_reference` has no UNIQUE constraint (`docker/schema.sql:255-290`), so one
checkout ID can be replayed indefinitely.

### Interaction with #79
`finalizePaidOrder` (`src/utils/shop/orderFinalization.ts:30-54`) is itself a three-round-trip
check-then-act with no lock (#79). This plan does **not** fix that — but it must not make it
worse, and the validation added here belongs *before* finalization regardless.

## Approach

Add one shared guard used by all three entry points, rather than patching each route.

New `src/utils/shop/paymentVerification.ts`:

```ts
verifySumUpPaymentForOrder({ order, checkoutId?, clientTransactionId? })
  -> { ok: true, paymentReference } | { ok: false, reason }
```

It must, server-side and unconditionally:
1. Fetch the transaction/checkout from SumUp. **A lookup failure is a rejection, not a warning.**
2. Require the remote status to be paid/successful — never read status from the request body.
3. Require `checkout.checkout_reference === order.order_number`.
4. Require the amount to equal `order.total_amount` (compare in integer cents; see the
   `Number()` float round-trip noted in #85).
5. Return the SumUp-issued `transaction_code` as the payment reference.

Rejected alternative: verifying inside each route. Three copies of a money check drift — the
existing divergence between `callback` and `verify` is exactly that failure already.

For the **reader callback** specifically, the body is attacker-controlled, so it may only be
used as a *hint* about which transaction to look up. Additionally gate the endpoint with a
shared secret in the callback URL path (SumUp reader callbacks take a configurable URL), so
unauthenticated traffic never reaches order logic at all.

## Steps

1. [ ] `src/utils/shop/paymentVerification.ts` — new module implementing the guard above.
2. [ ] `src/app/api/shop/sumup/readers/callback/route.ts` — add the URL-secret gate; replace the
       body-status branch with the guard; delete the `console.warn` swallow at `:51`.
3. [ ] `src/app/api/shop/sumup/verify/route.ts` — call the guard before `finalizePaidOrder` (`:94`).
4. [ ] `src/app/api/shop/sumup/callback/route.ts` — replace the conditional check at `:101`
       with the guard; the `payment_reference`-is-empty hole disappears with it.
5. [ ] `docker/migrations/` — `UNIQUE` index on `orders.payment_reference` (NULLs allowed) as
       replay protection. **Requires human approval (schema change).**
6. [ ] `.env.example` — document the new reader-callback secret.

Steps 1–4 are independently verifiable and leave the tree compiling. Step 5 is separable if
approval is slow — ship 1–4 first.

## Out of scope

- The `finalizePaidOrder` race and double-email (#79) — related but distinct, and fixing it
  properly means a locking SQL function.
- The Apple Pay `validationUrl` SSRF (audit finding M7).
- Migrating these routes to `apiErrorHandler` (#81 area).

## Risks

- **Breaking real payments is worse than the vulnerability.** If `checkout_reference` is not
  actually set to `order_number` at creation time, step 3 rejects genuine payments. **Verify
  what `sumup/new/route.ts` sends before enforcing**, and log-only for one deploy if unsure.
- Amount comparison must tolerate SumUp returning minor-unit vs decimal representations.
- Orders paid by MB Way / in person must not be caught by the new checks — they never have a
  SumUp checkout. Confirm the guard is only reached on SumUp paths.

## Verification

Gates, plus manually against a SumUp sandbox:
- forged reader callback with `status: successful` → order unchanged
- replay a used checkout ID against a second order → rejected
- checkout amount ≠ order total → rejected and logged
- **a genuine end-to-end card payment still completes** — this is the one that matters most

## Approvals needed

- **Schema** (step 5, UNIQUE index) — human approval required.
- **Payments** — this is payment code; per `CLAUDE.md` §2 the whole change needs sign-off, and
  it should not be merged without a sandbox test.
