/**
 * Decoding a dynamic route segment, safely (#183 follow-up).
 *
 * `/workspace/[team]` 404'd for every team whose name needs percent-encoding — Organização de
 * Eventos, Divulgação, Direção, Controlo & Qualidade — while Visuais, Fotografia, Dev-Team and
 * Contacto worked. That split is the whole diagnosis: the four that worked are exactly the names
 * `encodeURIComponent` leaves untouched.
 *
 * The page assumed Next's App Router hands back a decoded param. It does not, so `team` arrived as
 * `Organiza%C3%A7%C3%A3o%20de%20Eventos`, matched no row in `departments`, and hit `notFound()`.
 *
 * The earlier code was right about one thing, which is why this is a function rather than a bare
 * `decodeURIComponent`: a segment containing a literal `%` is not valid encoding and throws
 * `URIError` — thrown *before* the authorization guard can run, which turns a bad URL into a
 * server error instead of a 404.
 *
 * Decoding is also idempotent for every name we actually have: none contains a `%`, so if a future
 * Next version starts decoding for us this stays correct rather than double-decoding.
 */
export function decodeRouteParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A literal "%" that is not part of an escape sequence. Use it verbatim and let the caller's
    // existence check reject it — a 404 is the right answer, a 500 is not.
    return raw;
  }
}
