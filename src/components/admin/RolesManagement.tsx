import { getAllDepartments, getDepartmentRoles } from "@/utils/db/userQueries";
import RolesSearchFilter from "@/components/admin/RolesSearchFilter";
import { serverCheckPermission } from "@/utils/permissionUtils";
import styles from "@/styles/components/admin/RolesManagement.module.css";

export default async function RolesManagement({
  initialDepartmentType,
}: {
  initialDepartmentType: string;
}) {
  const departments = (await getAllDepartments()).filter(
    (dept) => dept.department_type === initialDepartmentType
  );
  const initialDepartment = departments[0]?.name || "";
  const initialRoles = initialDepartment ? await getDepartmentRoles(initialDepartment) : [];

  // #193: only an admin may set a role to `admin`. Decided on the SERVER — the client component
  // below cannot be trusted with this, and the API and SQL both re-check it. This exists so the
  // option is not offered to someone who would only get a 403.
  const mayGrantAdmin = (await serverCheckPermission("members.roles.grantAdmin")).isAuthorized;

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Gestão de Cargos</h1>
      <RolesSearchFilter
        departments={departments}
        initialDepartment={initialDepartment}
        initialRoles={initialRoles}
        mayGrantAdmin={mayGrantAdmin}
      />
    </div>
  );
}
