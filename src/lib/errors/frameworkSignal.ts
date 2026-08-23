/**
 * Next signals control flow by **throwing**, not by returning.
 *
 * `cookies()` outside a request scope throws `DynamicServerError` to mark the route dynamic;
 * `redirect()` throws `NEXT_REDIRECT`; `notFound()` throws `NEXT_NOT_FOUND`. Every one of them
 * carries a string `digest`.
 *
 * A blanket `catch` therefore does not merely log an error — it **cancels the framework's control
 * flow**. These are not our errors to handle. Re-throw them, and only then fall back.
 *
 * Extracted from `permissionUtils.ts` when the identical defect turned up in `app/layout.tsx`
 * (#111, then #153). Two copies of a rule like this is how one of them gets fixed and the other
 * does not — which is precisely what happened between those two issues.
 */
export const isFrameworkSignal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "digest" in error &&
  typeof (error as { digest: unknown }).digest === "string";
