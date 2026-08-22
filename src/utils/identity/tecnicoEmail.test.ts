import { describe, expect, it } from "vitest";
import { isTecnicoEmail } from "@/utils/identity/tecnicoEmail";

/**
 * #124. This decides whether someone is sent to Fenix or allowed to create a second, parallel
 * account — so both directions of a mistake are expensive, and the boundary cases are the point.
 */
describe("isTecnicoEmail", () => {
  it("matches the exact Técnico domain", () => {
    expect(isTecnicoEmail("ana@tecnico.ulisboa.pt")).toBe(true);
  });

  /** The case that used to slip through `endsWith("@tecnico.ulisboa.pt")`. */
  it.each([
    "ana@dei.tecnico.ulisboa.pt",
    "ana@alunos.tecnico.ulisboa.pt",
    "ana@a.b.tecnico.ulisboa.pt",
  ])("matches the subdomain %s", (email) => {
    expect(isTecnicoEmail(email)).toBe(true);
  });

  it("is case-insensitive, because email domains are", () => {
    expect(isTecnicoEmail("Ana@TECNICO.ULISBOA.PT")).toBe(true);
    expect(isTecnicoEmail("ana@DEI.Tecnico.Ulisboa.PT")).toBe(true);
  });

  /**
   * The dot boundary matters. Without it, a domain somebody else can register — one that merely
   * ends with the same characters — would be treated as a Técnico identity and sent to Fenix,
   * where it would never authenticate.
   */
  it.each(["ana@eviltecnico.ulisboa.pt", "ana@nottecnico.ulisboa.pt"])(
    "does not match %s, which is a different domain",
    (email) => {
      expect(isTecnicoEmail(email)).toBe(false);
    }
  );

  /** The opposite mistake: a domain that merely *contains* ours must not match. */
  it.each(["ana@tecnico.ulisboa.pt.evil.com", "ana@evil.com", "ana@gmail.com"])(
    "does not match %s",
    (email) => {
      expect(isTecnicoEmail(email)).toBe(false);
    }
  );

  it("uses the last @, so a local part containing one cannot spoof the domain", () => {
    expect(isTecnicoEmail('"a@tecnico.ulisboa.pt"@gmail.com')).toBe(false);
    expect(isTecnicoEmail("a@b@tecnico.ulisboa.pt")).toBe(true);
  });

  it.each(["", "not-an-email", "ana@", "@tecnico.ulisboa.pt"])(
    "handles %s without throwing",
    (email) => {
      expect(() => isTecnicoEmail(email)).not.toThrow();
    }
  );

  it("treats an address with no domain as not Técnico", () => {
    expect(isTecnicoEmail("ana@")).toBe(false);
    expect(isTecnicoEmail("ana")).toBe(false);
  });
});
