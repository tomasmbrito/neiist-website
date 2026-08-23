import { z } from "zod";
import { UserRole } from "@/types/user";

/**
 * Access levels a temporary grant may carry (#184).
 *
 * `_ADMIN` is absent on purpose and this is the third place it is refused — here, in the
 * `team_access_grants_never_admin` CHECK, and in `create_team_access_grant`. `_ADMIN` is
 * `ORGANISATION_WIDE`, so `canForTeam` short-circuits on it before it ever looks at the
 * department: a grant carrying admin would be a *global* grant wearing a team's name.
 */
export const grantableAccessSchema = z.enum([
  UserRole._MEMBER,
  UserRole._SHOP_MANAGER,
  UserRole._COORDINATOR,
]);

export const createGrantSchema = z.object({
  granteeIstid: z.string().trim().min(1, "Indique o membro."),
  departmentName: z.string().trim().min(1, "Indique a equipa."),
  access: grantableAccessSchema,
  // Bounded here too so the UI gets a friendly message, but the database is the authority: the
  // 90-day cap and the "must be in the future" rule are enforced in create_team_access_grant,
  // where no caller can skip them.
  expiresAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1, "Indique o motivo do acesso temporário."),
  /** Present when a coordinator is passing on a grant of their own rather than creating one. */
  parentGrantId: z.number().int().positive().nullable().optional(),
});

export const revokeGrantSchema = z.object({
  grantId: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});
