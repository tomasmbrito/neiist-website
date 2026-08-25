import { db_query } from "@/utils/db/dbClient";

/**
 * `@neiist.pt` address reservation (#213).
 *
 * **The domain lives here, not in the database.** Rows store `ana.silva`, not
 * `ana.silva@neiist.pt`, so a future domain change is a constant edit rather than a data
 * migration across every user.
 */
export const NEIIST_EMAIL_DOMAIN = "neiist.pt";

/** `ana.silva` → `ana.silva@neiist.pt`. Null in, null out — an unreserved user has no address. */
export const toNeiistEmail = (localPart: string | null | undefined): string | null =>
  localPart ? `${localPart}@${NEIIST_EMAIL_DOMAIN}` : null;

/**
 * What address this name *would* get, without reserving it.
 *
 * Deliberately separate from `assignNeiistEmail`: a preview that reserved would burn an address
 * every time somebody typed into the form and changed their mind.
 */
export const previewNeiistEmail = async (name: string): Promise<string | null> => {
  const { rows } = await db_query<{ preview_neiist_email: string | null }>(
    "SELECT neiist.preview_neiist_email($1::TEXT)",
    [name]
  );
  return toNeiistEmail(rows[0]?.preview_neiist_email);
};

/**
 * Reserve the address for a user, resolving collisions.
 *
 * **Idempotent**: an address already reserved comes back unchanged. Re-running this must never
 * silently change somebody's email address — which is the reason it is not simply an UPDATE.
 *
 * Errors throw (NEI18): a name that yields no usable address is a case for a human, not a
 * silently skipped row.
 */
export const assignNeiistEmail = async (istid: string): Promise<string> => {
  const { rows } = await db_query<{ assign_neiist_email: string }>(
    "SELECT neiist.assign_neiist_email($1::VARCHAR(50))",
    [istid]
  );
  return `${rows[0].assign_neiist_email}@${NEIIST_EMAIL_DOMAIN}`;
};
