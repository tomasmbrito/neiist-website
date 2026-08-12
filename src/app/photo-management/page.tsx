import { getAllMemberships, getAllDepartments } from "@/utils/db/userQueries";
import { Membership } from "@/types/memberships";
import PhotoTeamMembers from "@/components/photo-management/PhotoTeamMembers";
import { requireRoles } from "@/utils/permissionUtils";
import { UserRole } from "@/types/user";
import styles from "@/styles/components/photo-management/PhotoTeamMembers.module.css";

// Reads live membership data on every request; prerendering froze it into the build output and
// made a reachable database a build-time requirement.
export const dynamic = "force-dynamic";

export default async function PhotoTeamMembersPage() {
  // Mirrors the coordinator rule in middleware. Enforced here too, because middleware is one
  // routing bug away from being bypassed and does not run for every rendering path.
  await requireRoles([UserRole._ADMIN, UserRole._COORDINATOR]);

  const memberships = await getAllMemberships();
  const departments = await getAllDepartments();

  const activeMemberships: Membership[] = memberships.filter((membership) => membership.isActive);

  const membersByDepartment: Record<string, Membership[]> = {};
  activeMemberships.forEach((membership) => {
    if (!membersByDepartment[membership.departmentName]) {
      membersByDepartment[membership.departmentName] = [];
    }
    membersByDepartment[membership.departmentName].push(membership);
  });

  return (
    <>
      <h1 className={styles.title}>Gestão de Fotos dos Membros</h1>
      <PhotoTeamMembers membersByDepartment={membersByDepartment} departments={departments} />
    </>
  );
}
