import { NextRequest } from "next/server";

/** Methods that cannot change state, so a cross-site origin on them is not a CSRF concern. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects state-changing requests that a browser tells us came from another site.
 *
 * `sameSite: "lax"` on the session cookie (#94) already stops the classic cross-site POST, but it
 * is a *cookie* policy: it depends on the browser implementing it, and it says nothing about a
 * request that carries credentials some other way. This is the second layer, and it is the one
 * that holds on a browser whose defaults we do not control.
 *
 * Two independent signals, because neither is universal:
 *
 * - `Sec-Fetch-Site` is set by the browser and cannot be forged by page JavaScript. It is the
 *   better signal where it exists (Chrome, Edge, Firefox, Safari 16.4+).
 * - `Origin` is sent on every CORS request and on all state-changing form posts. It is the
 *   fallback for anything that does not send Sec-Fetch-Site.
 *
 * A request with **neither** header is allowed through. That is deliberate: server-to-server
 * callers (the SumUp webhook, the Notion webhook, cron) send no Origin, and they authenticate by
 * their own means. Blocking them here would break integrations to defend against a browser
 * attack that requires a browser — which always sends at least one of these.
 */
export function isCrossSiteRequest(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    // "same-origin" and "same-site" are ours; "none" is a direct navigation or a typed URL.
    return secFetchSite === "cross-site";
  }

  const origin = request.headers.get("origin");
  if (!origin) return false; // no browser signal at all — see the note above

  try {
    // Compare against the Host the request actually arrived on rather than a configured base
    // URL, so this keeps working on staging, on a preview host and on localhost without extra
    // configuration to forget.
    const host = request.headers.get("host");
    return new URL(origin).host !== host;
  } catch {
    return true; // an unparseable Origin is not something to give the benefit of the doubt
  }
}
