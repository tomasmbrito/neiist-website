import { db_query } from "../connection";
import { Membership, DbMembership, mapDbMembershipToMembership } from "@/types/memberships";
import { UserRepository } from "./user.repository";

export class TeamRepository {
  static async addMember(id: string, department = "Members", role = "Member"): Promise<boolean> {
    try {
      try {
        await db_query("SELECT neiist.add_department($1)", [department]);
        await db_query("SELECT neiist.add_team($1, $2)", [department, "General membership team"]);
        await db_query("SELECT neiist.add_valid_department_role($1, $2, $3)", [
          department,
          role,
          "member",
        ]);
      } catch (err) {
        console.warn("Could not add team or role (may already exist):", err);
      }
      await db_query("SELECT neiist.add_team_member($1::UUID, $2, $3)", [id, department, role]);
      return true;
    } catch (error) {
      console.error("Error adding member:", error);
      return false;
    }
  }

  static async addCollaborator(id: string, teams: string[], position: string): Promise<boolean> {
    try {
      for (const team of teams) {
        try {
          await db_query("SELECT neiist.add_valid_department_role($1, $2, $3)", [
            team,
            position,
            "coordinator",
          ]);
        } catch (err) {
          console.warn("Could not add team or role (may already exist):", err);
        }
        await db_query("SELECT neiist.add_team_member($1::UUID, $2, $3)", [id, team, position]);
      }
      return true;
    } catch (error) {
      console.error("Error adding collaborator:", error);
      return false;
    }
  }

  static async removeRole(id: string, department: string, role: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_team_member($1::UUID, $2, $3)", [id, department, role]);
      return true;
    } catch (error) {
      console.error("Error removing role:", error);
      return false;
    }
  }

  static async getDepartmentRoles(
    departmentName: string
  ): Promise<Array<{ role_name: string; access: string; active: boolean }>> {
    try {
      const { rows } = await db_query<{
        role_name: string;
        access: string;
        active: boolean;
      }>("SELECT role_name, access, active FROM neiist.get_department_roles($1)", [departmentName]);
      return rows;
    } catch (error) {
      console.error("Error fetching department roles:", error);
      return [];
    }
  }

  static async addDepartment(name: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.add_department($1)", [name]);
      return true;
    } catch (error) {
      console.error("Error adding department:", error);
      return false;
    }
  }

  static async removeDepartment(name: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_department($1)", [name]);
      return true;
    } catch (error) {
      console.error("Error removing department:", error);
      return false;
    }
  }

  static async getAllDepartments(): Promise<
    Array<{ name: string; department_type: string; active: boolean }>
  > {
    try {
      const { rows } = await db_query<{ name: string; department_type: string; active: boolean }>(
        "SELECT * FROM neiist.get_all_departments()"
      );
      return rows;
    } catch (error) {
      console.error("Error fetching departments:", error);
      return [];
    }
  }

  static async addTeam(name: string, description: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.add_team($1, $2)", [name, description]);
      return true;
    } catch (error) {
      console.error("Error adding team:", error);
      return false;
    }
  }

  static async removeTeam(name: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_team($1)", [name]);
      return true;
    } catch (error) {
      console.error("Error removing team:", error);
      return false;
    }
  }

  static async getAllTeams(): Promise<
    Array<{ name: string; description: string; active: boolean }>
  > {
    try {
      const { rows } = await db_query<{
        name: string;
        description: string;
        active: boolean;
      }>("SELECT * FROM neiist.get_all_teams()");
      return rows;
    } catch (error) {
      console.error("Error fetching teams:", error);
      return [];
    }
  }

  static async addAdminBody(name: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.add_admin_body($1)", [name]);
      return true;
    } catch (error) {
      console.error("Error adding admin body:", error);
      return false;
    }
  }

  static async removeAdminBody(name: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_admin_body($1)", [name]);
      return true;
    } catch (error) {
      console.error("Error removing admin body:", error);
      return false;
    }
  }

  static async getAllAdminBodies(): Promise<Array<{ name: string; active: boolean }>> {
    try {
      const { rows } = await db_query<{ name: string; active: boolean }>(
        "SELECT * FROM neiist.get_all_admin_bodies()"
      );
      return rows;
    } catch (error) {
      console.error("Error fetching admin bodies:", error);
      return [];
    }
  }

  static async addValidDepartmentRole(
    departmentName: string,
    roleName: string,
    access: "admin" | "coordinator" | "member" = "member"
  ): Promise<boolean> {
    try {
      await db_query("SELECT neiist.add_valid_department_role($1, $2, $3)", [
        departmentName,
        roleName,
        access,
      ]);
      return true;
    } catch (error) {
      console.error("Error adding valid department role:", error);
      return false;
    }
  }

  static async removeValidDepartmentRole(
    departmentName: string,
    roleName: string
  ): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_valid_department_role($1, $2)", [
        departmentName,
        roleName,
      ]);
      return true;
    } catch (error) {
      console.error("Error removing valid department role:", error);
      return false;
    }
  }

  static async getAllValidDepartmentRoles(): Promise<
    Array<{
      department_name: string;
      role_name: string;
      access: string;
      active: boolean;
    }>
  > {
    try {
      const { rows } = await db_query<{
        department_name: string;
        role_name: string;
        access: string;
        active: boolean;
      }>("SELECT * FROM neiist.get_all_valid_department_roles()");
      return rows;
    } catch (error) {
      console.error("Error fetching valid department roles:", error);
      return [];
    }
  }

  static async addTeamMember(
    id: string,
    departmentName: string,
    roleName: string
  ): Promise<boolean> {
    try {
      await db_query("SELECT neiist.add_team_member($1::UUID, $2, $3)", [
        id,
        departmentName,
        roleName,
      ]);
      return true;
    } catch (error) {
      console.error("Error adding team member:", error);
      return false;
    }
  }

  static async removeTeamMember(
    id: string,
    departmentName: string,
    roleName: string
  ): Promise<boolean> {
    try {
      await db_query("SELECT neiist.remove_team_member($1::UUID, $2, $3)", [
        id,
        departmentName,
        roleName,
      ]);
      return true;
    } catch (error) {
      console.error("Error removing team member:", error);
      return false;
    }
  }

  static async getAllMemberships(): Promise<Membership[]> {
    try {
      const [dbMemberships, users] = await Promise.all([
        db_query<DbMembership>("SELECT * FROM neiist.get_all_memberships()").then(
          (res) => res.rows
        ),
        UserRepository.getAllUsers(),
      ]);
      return dbMemberships.map((raw, idx) => {
        const user = users.find((u) => u.istid === raw.user_istid);
        return mapDbMembershipToMembership(raw, user?.email || "", user?.photo || "", idx);
      });
    } catch (error) {
      console.error("Error fetching memberships:", error);
      return [];
    }
  }

  static async getDepartmentRoleOrder(
    departmentName: string
  ): Promise<Array<{ role_name: string; position: number }>> {
    try {
      const { rows } = await db_query<{ role_name: string; position: number }>(
        "SELECT * FROM neiist.get_department_role_order($1)",
        [departmentName]
      );
      return rows;
    } catch (error) {
      console.error("Error fetching department role order:", error);
      return [];
    }
  }

  static async setDepartmentRoleOrder(departmentName: string, roles: string[]): Promise<boolean> {
    try {
      await db_query("SELECT neiist.set_department_role_order($1, $2)", [departmentName, roles]);
      return true;
    } catch (error) {
      console.error("Error setting department role order:", error);
      return false;
    }
  }
}
