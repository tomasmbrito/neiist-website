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
});
