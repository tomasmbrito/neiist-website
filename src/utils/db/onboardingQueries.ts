import { db_query } from "@/utils/db/dbClient";

/**
 * Onboarding an accepted candidate, and the team's own links (#224, #225).
 *
 * **Nothing in this file creates a membership, a user, or a role.** That is not an omission — it
 * is the decision from #134, restated here because the temptation to "just add one line" lands
 * exactly on this module: the page these functions serve is reachable by a person who is *not* a
 * member, holding a token, and a self-service page reachable by a non-member that creates
 * authority is the shape of #193. `add_team_member` stays the single path, run by a human.
 */

export type PendingOnboarding = {
  applicationId: number;
  fullName: string;
  preferredName: string;
  email: string;
  phone: string | null;
  istid: string;
  submittedAt: string;
  /** What #213 would give them as an @neiist.pt address. Previewed, not assigned. */
  suggestedEmail: string;
};

/**
 * Spend the onboarding token and record the answers, atomically, returning the team's link.
 *
 * Atomic in SQL rather than here on purpose: consuming the token and then inserting would, on a
 * crash between the two, burn the candidate's only link and record nothing — locking them out of
 * their own onboarding with no way back except somebody noticing.
 */
export const completeOnboarding = async (
  tokenHash: string,
  preferredName: string,
  phone?: string | null
): Promise<{ team: string; inviteUrl: string | null }> => {
  const { rows } = await db_query<{ team: string; invite_url: string | null }>(
    "SELECT * FROM neiist.complete_onboarding($1::TEXT, $2::TEXT, $3::TEXT)",
    [tokenHash, preferredName, phone ?? null]
  );
  return { team: rows[0].team, inviteUrl: rows[0].invite_url };
};

export const getPendingOnboarding = async (
  departmentName: string
): Promise<PendingOnboarding[]> => {
  const { rows } = await db_query<{
    application_id: number;
    full_name: string;
    preferred_name: string;
    email: string;
    phone: string | null;
    istid: string;
    submitted_at: string;
    suggested_email: string;
  }>("SELECT * FROM neiist.get_pending_onboarding($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    applicationId: row.application_id,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    email: row.email,
    phone: row.phone,
    istid: row.istid,
    submittedAt: row.submitted_at,
    suggestedEmail: row.suggested_email,
  }));
};

/** Records only — it does NOT add the member. See the note at the top of this file. */
export const markOnboardingComplete = async (
  applicationId: number,
  departmentName: string,
  actorIstid: string
): Promise<void> => {
  await db_query(
    "SELECT neiist.mark_onboarding_complete($1::INT, $2::VARCHAR(30), $3::VARCHAR(50))",
    [applicationId, departmentName, actorIstid]
  );
};

export const getTeamLink = async (
  departmentName: string
): Promise<{
  whatsappUrl: string | null;
  updatedAt: string;
  updatedByName: string | null;
} | null> => {
  const { rows } = await db_query<{
    whatsapp_url: string | null;
    updated_at: string;
    updated_by_name: string | null;
  }>("SELECT * FROM neiist.get_team_link($1::VARCHAR(30))", [departmentName]);
  const row = rows[0];
  return row
    ? {
        whatsappUrl: row.whatsapp_url,
        updatedAt: row.updated_at,
        updatedByName: row.updated_by_name,
      }
    : null;
};

/** The URL shape is validated in SQL, so every caller inherits the same rule. */
export const setTeamLink = async (
  departmentName: string,
  url: string | null,
  actorIstid: string
): Promise<void> => {
  await db_query("SELECT neiist.set_team_link($1::VARCHAR(30), $2::TEXT, $3::VARCHAR(50))", [
    departmentName,
    url,
    actorIstid,
  ]);
};
