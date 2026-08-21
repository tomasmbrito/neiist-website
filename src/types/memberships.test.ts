import { describe, expect, it } from "vitest";
import { Membership, groupMembershipsByMember } from "@/types/memberships";

/**
 * #8 — a member holding more than one position appeared once per position in every list that
 * rendered `get_all_memberships()` directly: same photo, same name, same email, differing only
 * in Departamento/Cargo.
 */
const membership = (over: Partial<Membership>): Membership => ({
  id: "x",
  userNumber: "ist100000",
  userName: "Ana",
  departmentName: "Dev-Team",
  roleName: "Membro",
  startDate: "2026-01-01",
  isActive: true,
  userEmail: "ana@tecnico.ulisboa.pt",
  userPhoto: "/photo.png",
  ...over,
});

describe("groupMembershipsByMember", () => {
  it("collapses several positions held by one person into a single entry", () => {
    const rows = [
      membership({ id: "1", roleName: "Coordenador" }),
      membership({ id: "2", roleName: "Programadora" }),
      membership({ id: "3", departmentName: "Divulgação", roleName: "Membro" }),
    ];

    const grouped = groupMembershipsByMember(rows);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].userNumber).toBe("ist100000");
    expect(grouped[0].positions).toHaveLength(3);
    expect(grouped[0].positions.map((p) => p.roleName)).toEqual([
      "Coordenador",
      "Programadora",
      "Membro",
    ]);
  });

  it("keeps different people separate", () => {
    const grouped = groupMembershipsByMember([
      membership({ id: "1", userNumber: "ist1", userName: "Ana" }),
      membership({ id: "2", userNumber: "ist2", userName: "Bruno" }),
    ]);
    expect(grouped.map((m) => m.userNumber)).toEqual(["ist1", "ist2"]);
  });

  it("preserves order of first appearance, so an alphabetical query stays alphabetical", () => {
    const grouped = groupMembershipsByMember([
      membership({ id: "1", userNumber: "ist2", userName: "Bruno" }),
      membership({ id: "2", userNumber: "ist1", userName: "Ana" }),
      membership({ id: "3", userNumber: "ist2", userName: "Bruno", roleName: "Outro" }),
    ]);
    expect(grouped.map((m) => m.userName)).toEqual(["Bruno", "Ana"]);
  });

  /** A member with one current and one ended position is still a current member. */
  it("treats a person as active when any single position is active", () => {
    const grouped = groupMembershipsByMember([
      membership({ id: "1", isActive: false, endDate: "2026-01-02" }),
      membership({ id: "2", isActive: true, roleName: "Coordenador" }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].isActive).toBe(true);
  });

  it("returns nothing for no rows", () => {
    expect(groupMembershipsByMember([])).toEqual([]);
  });
});
