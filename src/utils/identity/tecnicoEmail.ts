/**
 * Whether an address is a Técnico identity and must therefore go through Fenix (#124).
 *
 * The Google path rejects Técnico addresses so a student cannot end up with two accounts — one
 * from Fenix carrying their `istid`, roles and order history, and a second `ext_` one carrying
 * nothing. That is the duplicate-person problem of #8, but at the identity layer, where it is
 * far harder to undo: the two accounts have different primary keys and both may have data.
 *
 * The check used to be `email.endsWith("@tecnico.ulisboa.pt")`, which let every *subdomain*
 * through. A subdomain address is still a Técnico identity.
 *
 * Matching is on the domain part only, and is deliberately anchored:
 *
 *   ana@tecnico.ulisboa.pt          -> true   (exact)
 *   ana@dei.tecnico.ulisboa.pt      -> true   (subdomain — the case that used to slip)
 *   ana@eviltecnico.ulisboa.pt      -> false  (no dot boundary; a different domain)
 *   ana@tecnico.ulisboa.pt.evil.com -> false  (suffix, not the domain)
 */
const TECNICO_DOMAIN = "tecnico.ulisboa.pt";

export function isTecnicoEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (domain === "") return false;

  // The leading dot is what stops "eviltecnico.ulisboa.pt" matching: a subdomain must be
  // separated by a label boundary, not merely end with the same characters.
  return domain === TECNICO_DOMAIN || domain.endsWith(`.${TECNICO_DOMAIN}`);
}
