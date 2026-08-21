-- 007: look up an account by its verified alternative email, for the Google login path (#124)
--
-- ⚠️ Replaces neiist.get_user_by_email. Production's schema is unmeasured — run
-- `yarn db:schema-diff` (#152) first.
--
-- ## The problem this addresses
--
-- get_user_by_email matches only `users.email`, the Fenix address. So a student whose Google
-- account is their *personal* address — which they have already recorded as their alternative
-- email — signs in with Google and gets a SECOND, separate `ext_` account: different primary
-- key, no roles, no order history. That is #124's stated problem.
--
-- ## Why this returns a flag instead of just widening the match
--
-- Widening get_user_by_email to include alternative emails would silently log the visitor into
-- the matched account. That is the wrong behaviour twice over:
--
--   * It is a linking decision, and linking should be explicit. The caller must be able to say
--     "this address belongs to an existing account — sign in with Fenix to link it" rather than
--     silently adopting an identity.
--   * The Google flow proves control of the *Google* address, not of the Técnico account. Those
--     are different claims.
--
-- So this function reports HOW the address matched and lets the caller decide.
--
-- ## "Verified" is by construction, and now enforced
--
-- An alternative email reaches user_contacts only through the email_token flow
-- (api/user/verify-email/confirm), which requires a token sent to that address. The one path
-- that bypassed it — PUT /api/user/update/[userId] writing the value directly behind a format
-- check — is closed in the same change. Without that, this lookup would be an
-- account-takeover primitive rather than a convenience.
--
-- Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION neiist.find_user_by_any_email(u_email TEXT)
RETURNS TABLE (
  istid VARCHAR(50),
  matched_primary_email BOOLEAN
) AS $$
  -- Primary (Fenix) email first: an exact match there is the account, unambiguously.
  SELECT u.istid, TRUE
  FROM neiist.users u
  WHERE lower(u.email) = lower(u_email)
  UNION ALL
  -- Otherwise a verified alternative email. LIMIT 1 on the whole thing keeps the primary match
  -- winning when an address is somehow both.
  SELECT c.user_istid, FALSE
  FROM neiist.user_contacts c
  WHERE c.contact_type = 'alt_email'
    AND lower(c.contact_value) = lower(u_email)
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.find_user_by_any_email(TEXT) TO neiist_app_user;
