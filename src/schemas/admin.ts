import { z } from "zod";

/**
 * The access levels `neiist.user_access_enum` has.
 *
 * `shop_manager` was missing from the TypeScript union this replaces, so the admin UI could not
 * create a role granting it even though the enum, `UserRole` and every shop guard support it.
 */
export const departmentRoleAccessSchema = z.enum([
  "admin",
  "coordinator",
  "shop_manager",
  "member",
]);

export const updateDepartmentRoleSchema = z.object({
  departmentName: z.string().min(1, "Departamento obrigatório"),
  roleName: z.string().min(1, "Cargo obrigatório"),
  access: departmentRoleAccessSchema,
  /**
   * Does this role sit on the Direção? (#217)
   *
   * Optional so an ordinary access edit does not have to carry it — but note the consequence:
   * `undefined` means "leave it alone", never "false". A PATCH that omitted it and was read as
   * `false` would quietly remove people from the board every time somebody changed a role's
   * access level.
   */
  boardMember: z.boolean().optional(),
});
