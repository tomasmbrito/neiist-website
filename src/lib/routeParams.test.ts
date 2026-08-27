import { describe, expect, it } from "vitest";
import { decodeRouteParam } from "@/lib/routeParams";

/**
 * #183 follow-up — `/workspace/[team]` 404'd for four of the ten departments.
 *
 * The split was the diagnosis: Visuais, Fotografia, Dev-Team and Contacto worked; Organização de
 * Eventos, Divulgação, Direção and Controlo & Qualidade did not. The four that worked are exactly
 * the names `encodeURIComponent` leaves untouched — so the param was arriving encoded and matching
 * no row in `departments`.
 *
 * These are the real department names, so a future rename that reintroduces the problem fails here
 * rather than in somebody's browser.
 */
const DEPARTMENTS = [
  "Direção",
  "Conselho Fiscal",
  "Mesa da Assembleia Geral",
  "Contacto",
  "Controlo & Qualidade",
  "Dev-Team",
  "Divulgação",
  "Fotografia",
  "Organização de Eventos",
  "Visuais",
];

describe("decoding a dynamic route segment", () => {
  it("round-trips every real department name", () => {
    for (const name of DEPARTMENTS) {
      expect(decodeRouteParam(encodeURIComponent(name))).toBe(name);
    }
  });

  it("is idempotent, so it stays correct if Next starts decoding for us", () => {
    // None of the names contains a "%", so decoding an already-decoded name is a no-op. That is
    // what makes this safe against a future framework change rather than dependent on one.
    for (const name of DEPARTMENTS) {
      expect(decodeRouteParam(name)).toBe(name);
    }
  });

  it("survives a literal % instead of throwing", () => {
    // The reason the previous code avoided decoding altogether: URIError here is thrown BEFORE the
    // authorization guard runs, turning a bad URL into a 500. A 404 is the right answer.
    expect(decodeRouteParam("100%")).toBe("100%");
    expect(decodeRouteParam("%zz")).toBe("%zz");
    expect(decodeRouteParam("%")).toBe("%");
  });

  it("handles the four names that actually broke", () => {
    expect(decodeRouteParam("Organiza%C3%A7%C3%A3o%20de%20Eventos")).toBe("Organização de Eventos");
    expect(decodeRouteParam("Divulga%C3%A7%C3%A3o")).toBe("Divulgação");
    expect(decodeRouteParam("Dire%C3%A7%C3%A3o")).toBe("Direção");
    expect(decodeRouteParam("Controlo%20%26%20Qualidade")).toBe("Controlo & Qualidade");
  });

  it("leaves the four that always worked untouched", () => {
    for (const name of ["Visuais", "Fotografia", "Dev-Team", "Contacto"]) {
      expect(decodeRouteParam(name)).toBe(name);
    }
  });
});
