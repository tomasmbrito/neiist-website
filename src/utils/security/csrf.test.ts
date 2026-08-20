import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isCrossSiteRequest } from "@/utils/security/csrf";

/**
 * #94. These are cheap, but the function is the kind that is easy to get subtly wrong in a way
 * that either breaks the SumUp webhook or silently allows the attack it exists to stop.
 */
const makeRequest = (
  method: string,
  headers: Record<string, string> = {},
  url = "https://neiist.tecnico.ulisboa.pt/api/shop/uploads"
) => new NextRequest(new Request(url, { method, headers }));

describe("isCrossSiteRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("never blocks %s, which cannot change state", (method) => {
    expect(isCrossSiteRequest(makeRequest(method, { "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("blocks a state-changing request the browser labels cross-site", () => {
    expect(isCrossSiteRequest(makeRequest("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it.each(["same-origin", "same-site", "none"])("allows Sec-Fetch-Site: %s", (value) => {
    expect(isCrossSiteRequest(makeRequest("POST", { "sec-fetch-site": value }))).toBe(false);
  });

  it("prefers Sec-Fetch-Site over Origin, because page JavaScript cannot forge it", () => {
    // A hostile page can set neither header itself, but this pins the precedence so a future
    // edit cannot make the forgeable one win.
    expect(
      isCrossSiteRequest(
        makeRequest("POST", {
          "sec-fetch-site": "same-origin",
          origin: "https://evil.example",
        })
      )
    ).toBe(false);
  });

  it("falls back to Origin when Sec-Fetch-Site is absent", () => {
    expect(
      isCrossSiteRequest(
        makeRequest("POST", { origin: "https://evil.example", host: "neiist.tecnico.ulisboa.pt" })
      )
    ).toBe(true);
  });

  it("allows an Origin matching the host the request arrived on", () => {
    expect(
      isCrossSiteRequest(
        makeRequest("POST", {
          origin: "https://neiist.tecnico.ulisboa.pt",
          host: "neiist.tecnico.ulisboa.pt",
        })
      )
    ).toBe(false);
  });

  it("works on a non-production host without extra configuration", () => {
    expect(
      isCrossSiteRequest(
        makeRequest(
          "POST",
          { origin: "http://localhost:3000", host: "localhost:3000" },
          "http://localhost:3000/api/shop/orders"
        )
      )
    ).toBe(false);
  });

  /**
   * The SumUp and Notion webhooks. Blocking these would break payment confirmation to defend
   * against an attack that requires a browser — and a browser always sends one of the two.
   */
  it("allows a server-to-server request that sends neither header", () => {
    expect(isCrossSiteRequest(makeRequest("POST"))).toBe(false);
  });

  it("blocks an unparseable Origin rather than giving it the benefit of the doubt", () => {
    expect(isCrossSiteRequest(makeRequest("POST", { origin: "not a url" }))).toBe(true);
  });
});
