import { User, mapRoleToUserRole, mapdbUserToUser } from "@/types/user";
import { db_query } from "../connection";
import { dbMembership, Membership, mapdbMembershipToMembership } from "@/types/memberships";

export class UserRepository {
  static async createUser(user: Partial<User>): Promise<User | null> {
    if (!user.name || !user.email) return null;
    try {
      const {
        rows: [newUser],
      } = await db_query<User>(
        `SELECT * FROM neiist.add_user($1::VARCHAR(10), $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::TEXT, $7::TEXT[])`,
        [
          user.istid || null, // null for external users
          user.name,
          user.email,
          user.alternativeEmail,
          user.phone,
          user.photo,
          user.courses,
        ]
      );
      if (!newUser) return null;
      newUser.roles = newUser.roles?.map(mapRoleToUserRole);
      return newUser ? mapdbUserToUser(newUser) : null;
    } catch (error) {
      console.error("Error creating user:", error);
      return null;
    }
  }

  static async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    try {
      const {
        rows: [updatedUser],
      } = await db_query<User>("SELECT * FROM neiist.update_user($1::UUID, $2::JSONB)", [
        id,
        JSON.stringify(updates),
      ]);
      if (!updatedUser) return null;
      updatedUser.roles = updatedUser.roles?.map(mapRoleToUserRole);
      return updatedUser ? mapdbUserToUser(updatedUser) : null;
    } catch (error) {
      console.error("Error updating user:", error);
      return null;
    }
  }

  static async updateUserPhoto(id: string, photoData: string): Promise<boolean> {
    try {
      await db_query("SELECT neiist.update_user_photo($1::UUID, $2::TEXT)", [id, photoData]);
      return true;
    } catch (error) {
      console.error("Error updating user photo:", error);
      return false;
    }
  }

  static async getUser(id: string): Promise<User | null> {
    try {
      const {
        rows: [user],
      } = await db_query<User>("SELECT * FROM neiist.get_user($1::UUID)", [id]);
      if (!user) return null;

      const dbMemberships = (
        await db_query<dbMembership>(
          "SELECT * FROM neiist.get_all_memberships() WHERE user_id = $1 AND active = TRUE",
          [id]
        )
      ).rows;

      const memberships: Membership[] = dbMemberships.map((raw, idx) =>
        mapdbMembershipToMembership(raw, user.email, user.photo, idx)
      );
      let highest: { roleName: string; position: number } | null = null;
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim();

      const uniqueDepts = Array.from(new Set(memberships.map((m) => m.departmentName)));
      const roleOrders = await Promise.all(
        uniqueDepts.map((dept) =>
          db_query<{ role_name: string; position: number }>(
            "SELECT role_name, position FROM neiist.get_department_role_order($1)",
            [dept]
          ).then((res) => ({ dept, rows: res.rows }))
        )
      );
      const roleOrderMap = new Map(roleOrders.map((ro) => [ro.dept, ro.rows]));

      for (const membership of memberships) {
        const roleOrder = roleOrderMap.get(membership.departmentName) ?? [];
        const found = roleOrder.find(
          (r) => normalize(r.role_name) === normalize(membership.roleName)
        );
        if (found) {
          if (!highest || found.position < highest.position) {
            highest = { roleName: membership.roleName, position: found.position };
          }
        }
      }

      const positionName = highest?.roleName ?? memberships[0]?.roleName ?? null;

      return {
        ...mapdbUserToUser(user),
        positionName,
      };
    } catch (error) {
      console.error("Error fetching user:", error);
      return null;
    }
  }

  static async getUserByIstid(istid: string): Promise<User | null> {
    try {
      const {
        rows: [user],
      } = await db_query<User>("SELECT * FROM neiist.get_user_by_istid($1::VARCHAR(10))", [istid]);
      if (!user) return null;
      // We recursively call getUser using the found id to get the full resolved user with roles/teams
      return this.getUser(user.istid);
    } catch (error) {
      console.error("Error fetching user by istid:", error);
      return null;
    }
  }

  static async getAllUsers(): Promise<User[]> {
    try {
      const { rows } = await db_query<User>("SELECT * FROM neiist.get_all_users()");
      return rows.map(mapdbUserToUser);
    } catch (error) {
      console.error("Error fetching all users:", error);
      return [];
    }
  }

  static async getUsersByAccess(access: string): Promise<User[]> {
    try {
      const { rows } = await db_query<User>(
        "SELECT id, istid, name, email, phone, courses, campus, photo_path as photo FROM neiist.get_users_by_access($1)",
        [access]
      );
      return rows.map(mapdbUserToUser);
    } catch (error) {
      console.error("Error fetching users by access:", error);
      return [];
    }
  }

  static async addEmailVerification(
    istid: string,
    email: string,
    token: string,
    expiresAt: string
  ): Promise<void> {
    try {
      await db_query(
        "SELECT neiist.add_email_verification((SELECT id FROM neiist.users WHERE istid = $1::VARCHAR(10)), $2, $3, $4)",
        [istid, email, token, expiresAt]
      );
    } catch (error) {
      console.error("Error adding email verification:", error);
      throw error;
    }
  }

  static async getEmailVerification(
    token: string
  ): Promise<{ user_id: string; email: string; expires_at: string } | null> {
    try {
      const {
        rows: [row],
      } = await db_query<{ user_id: string; email: string; expires_at: string }>(
        "SELECT * FROM neiist.get_email_verification($1)",
        [token]
      );
      return row ?? null;
    } catch (error) {
      console.error("Error fetching email verification:", error);
      return null;
    }
  }

  static async deleteEmailVerification(token: string): Promise<void> {
    try {
      await db_query("SELECT neiist.delete_email_verification($1)", [token]);
    } catch (error) {
      console.error("Error deleting email verification:", error);
      throw error;
    }
  }

  static async getEmailVerificationByUser(
    id: string
  ): Promise<{ email: string; expires_at: string } | null> {
    try {
      const {
        rows: [row],
      } = await db_query<{ email: string; expires_at: string }>(
        "SELECT * FROM neiist.get_email_verification_by_user($1::UUID)",
        [id]
      );
      return row ?? null;
    } catch (error) {
      console.error("Error fetching pending alternative email:", error);
      return null;
    }
  }
}
