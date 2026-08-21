export interface Team {
  name: string;
  description: string;
  icon: string;
}

export interface Role {
  roleName: string;
  access: "guest" | "shop_manager" | "member" | "coordinator" | "admin";
}

export interface DbRole {
  roleName?: string;
  role_name?: string;
  access: string;
}

export interface Membership {
  id: string;
  userNumber: string;
  userName: string;
  departmentName: string;
  roleName: string;
  startDate: string;
  endDate?: string;
  isActive: boolean;
  userEmail: string;
  userPhoto: string;
}

export interface DbMembership {
  user_istid: string;
  user_name: string;
  department_name: string;
  role_name: string;
  from_date: string;
  to_date: string | null;
  active: boolean;
}

export function mapDbMembershipToMembership(
  raw: DbMembership,
  userEmail = "",
  userPhoto = "",
  index = 0
): Membership {
  return {
    id: `${raw.user_istid}-${raw.department_name}-${raw.role_name}-${index}`,
    userNumber: raw.user_istid,
    userName: raw.user_name,
    departmentName: raw.department_name,
    roleName: raw.role_name,
    startDate: raw.from_date,
    endDate: raw.to_date ?? undefined,
    isActive: raw.active,
    userEmail,
    userPhoto,
  };
}

/**
 * One person, with every position they hold — as opposed to `Membership`, which is one *row*
 * per position.
 *
 * `neiist.get_all_memberships()` returns a row per membership, so a member of two teams (or one
 * team in two roles) came back two or three times. Every list that rendered that array directly
 * showed them once per position: the same photo, name and email repeated, differing only in
 * Departamento/Cargo. Tracked as #8 since July.
 *
 * Grouping belongs here rather than in each component, because five different screens consume
 * the same flattened array and each was free to get it wrong separately.
 */
export interface MemberWithPositions {
  userNumber: string;
  userName: string;
  userEmail: string;
  userPhoto: string;
  /** Every position this person holds, in the order the query returned them. */
  positions: Membership[];
  /** True when at least one position is current. */
  isActive: boolean;
}

/**
 * Collapse membership rows into one entry per person, preserving order of first appearance so
 * an alphabetical query stays alphabetical.
 */
export function groupMembershipsByMember(memberships: Membership[]): MemberWithPositions[] {
  const byMember = new Map<string, MemberWithPositions>();

  for (const membership of memberships) {
    const existing = byMember.get(membership.userNumber);
    if (existing) {
      existing.positions.push(membership);
      existing.isActive = existing.isActive || membership.isActive;
      continue;
    }
    byMember.set(membership.userNumber, {
      userNumber: membership.userNumber,
      userName: membership.userName,
      userEmail: membership.userEmail,
      userPhoto: membership.userPhoto,
      positions: [membership],
      isActive: membership.isActive,
    });
  }

  return [...byMember.values()];
}
