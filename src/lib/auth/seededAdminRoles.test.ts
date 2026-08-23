import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #189. Which (department, role) pairs grant organisation-wide access is a **policy decision**,
 * and it is expressed as seed data rather than as code — deliberately, per the #185 decision, so
 * the President can change it through the roles screen without a deploy.
 *
 * Seed data has no type checker. `add_valid_department_role(..., 'admin')` is one word different
 * from `'coordinator'`, and the mistake is invisible: nothing fails, nothing warns, and the
 * consequence — `canForTeam` short-circuits `return true` for *every* team — only shows up as
 * someone quietly being able to read another team's workspace. That is exactly how the Mesa da
 * Assembleia Geral president came to hold blanket access.
 *
 * So the intended set is written out here. A new organisation-wide admin must be added to this
 * list in the same commit, which makes the decision visible in a diff instead of implicit in a
 * line of SQL. This is the same reasoning as the permission-equivalence table in
 * `permissions.test.ts`, applied to the half of the policy that lives in the database.
 *
 * Reading the file rather than the database on purpose: this asserts what a *fresh* environment
 * gets. A running database legitimately drifts from it the moment someone uses the roles screen,
 * which is the whole point of that screen.
 */
const INIT_SQL = resolve(process.cwd(), "docker/init.sql");

/** Every (department, role) seeded with an access level that is organisation-wide. */
const EXPECTED_ORGANISATION_WIDE: ReadonlyArray<[string, string]> = [
  // Direção. "The president and vice-president should both have access to everything."
  ["Direção", "Presidente"],
  ["Direção", "Vice-Presidente"],
  ["Direção", "Vogal"],
  // Decided 2026-08-22 (#189): the Dev-Team coordinator keeps organisation-wide access for now —
  // and only the coordinator. The team's other roles are `member`/`shop_manager`, which is what
  // makes this survivable; if Programadora or Membro were ever raised to `admin`, every developer
  // would read every team. That is the case this test exists to catch.
  ["Dev-Team", "Coordenador"],
];

function seededRoles(access: string): Array<[string, string]> {
  const sql = readFileSync(INIT_SQL, "utf8");
  // Deliberately tolerant of whitespace but not of the access value: only exact `'admin'` counts.
  const pattern = new RegExp(
    String.raw`add_valid_department_role\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'${access}'\s*\)`,
    "g"
  );
  return [...sql.matchAll(pattern)].map(([, department, role]) => [department, role]);
}

describe("seeded organisation-wide admin roles", () => {
  it("is exactly the intended set", () => {
    const actual = seededRoles("admin").sort();
    expect(actual).toEqual([...EXPECTED_ORGANISATION_WIDE].sort());
  });

  it("does not grant the Mesa da Assembleia Geral organisation-wide access", () => {
    // The #189 regression, named explicitly. The MAG oversees the núcleo but does not run it;
    // it gets what it is explicitly given, not every team's workspace by default.
    const mag = seededRoles("admin").filter(
      ([department]) => department === "Mesa da Assembleia Geral"
    );
    expect(mag).toEqual([]);
  });

  it("grants no Dev-Team role except the coordinator organisation-wide access", () => {
    const devTeam = seededRoles("admin")
      .filter(([department]) => department === "Dev-Team")
      .map(([, role]) => role);
    expect(devTeam).toEqual(["Coordenador"]);
  });

  it("finds the seed file at all", () => {
    // Guards the guard: a moved or renamed init.sql would otherwise make every test above pass
    // vacuously by matching nothing.
    expect(seededRoles("admin").length).toBeGreaterThan(0);
  });
});
