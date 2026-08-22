-- 008: per-team access resolution (#180) and same-day membership removal (#181)
--
-- ⚠️ Run `yarn db:schema-diff` (#152) before applying anywhere real.
--
-- ## #180 — access levels are flattened across teams
--
-- neiist.get_user aggregates access with `array_agg(DISTINCT access)` grouped by user, so a
-- person who is a Membro of Fotografia and a Coordenador of Divulgação comes back as
-- {coordinator, member} with teams {Divulgação, Fotografia} and no way to tell which access
-- belongs to which team.
--
-- Every caller that needs "is this person a coordinator OF that team" therefore has to guess.
-- Three do, and two guess wrongly — the API check asks "coordinator somewhere AND a member of
-- this team", which let a plain Membro of Fotografia add members to Fotografia. Reproduced
-- against a running app before this change: HTTP 200 and a membership row.
--
-- get_user_team_scopes returns the (department, access) PAIRS, so the question can be answered
-- exactly instead of approximated. It replaces nothing — get_user is untouched, deliberately:
-- widening its RETURNS TABLE needs DROP FUNCTION, which drops the EXECUTE grant with it, and a
-- production role whose ALTER DEFAULT PRIVILEGES does not cover the migrating user would then
-- get "permission denied" on every guarded page.
--
-- ## #181 — a member added today cannot be removed today
--
-- add_team_member sets from_date = CURRENT_DATE; remove_team_member sets to_date =
-- CURRENT_DATE; the CHECK demanded to_date > from_date. So undoing a mistake required waiting a
-- day, and the constraint violation surfaced as a generic 500.
--
-- Relaxed to >=. A membership that begins and ends on the same day is a legitimate record of a
-- correction, and the invariant that actually matters — an end never PRECEDES a start — is kept.
--
-- Idempotent: CREATE OR REPLACE, and the constraint is dropped by name before being re-added.

-- ---------------------------------------------------------------------------------------------
-- #180
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.get_user_team_scopes(u_istid VARCHAR(50))
RETURNS TABLE (
  department_name VARCHAR(30),
  department_type VARCHAR(20),
  access          neiist.user_access_enum
) AS $$
  -- Current memberships only: to_date IS NULL, or still in the future. This is the same
  -- liveness rule get_user applies, and idx_membership_active indexes exactly it.
  --
  -- DISTINCT because a person can hold several roles in one department that map to the same
  -- access level; the caller wants the set of levels they have there, not a row per role.
  SELECT DISTINCT
    m.department_name,
    d.department_type,
    v.access
  FROM neiist.membership m
  JOIN neiist.departments d ON d.name = m.department_name
  JOIN neiist.valid_department_roles v
    ON v.department_name = m.department_name
   AND v.role_name = m.role_name
  WHERE m.user_istid = u_istid
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    AND d.active
    AND v.active;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.get_user_team_scopes(VARCHAR(50)) TO neiist_app_user;


-- Access level a role grants inside a department, for comparing what is being handed out against
-- what the assigner holds (see mayAssignAccess).
--
-- SECURITY DEFINER because neiist_app_user has no table privileges by design
-- (schema.sql:11-16) — a direct SELECT on valid_department_roles fails with aclcheck_error.
-- Learned the same way as count_department_role_members in 004.
CREATE OR REPLACE FUNCTION neiist.get_department_role_access(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS neiist.user_access_enum
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT v.access
  FROM neiist.valid_department_roles v
  WHERE v.department_name = u_department_name
    AND v.role_name = u_role_name
    AND v.active
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION
  neiist.get_department_role_access(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- #181
-- ---------------------------------------------------------------------------------------------

-- Refuse to run if the live table carries the strict rule under a different name.
--
-- DROP CONSTRAINT IF EXISTS is silent when the name does not match, so on a database where the
-- CHECK is called something else the drop would no-op, the ADD would succeed, BOTH constraints
-- would then exist, and the migration would report success while fixing nothing — coordinators
-- would still get a 500 removing a member added today. Production's schema is unmeasured (#152),
-- so this cannot be assumed away. Failing loudly is the point.
DO $$
DECLARE
  v_other TEXT;
BEGIN
  SELECT string_agg(conname, ', ') INTO v_other
  FROM pg_constraint
  WHERE conrelid = 'neiist.membership'::regclass
    AND contype = 'c'
    AND conname <> 'valid_member_dates'
    AND pg_get_constraintdef(oid) ILIKE '%to_date%';

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION
      'Another CHECK on neiist.membership references to_date (%). Reconcile it by hand before '
      'applying this migration, or the same-day fix will silently do nothing.', v_other;
  END IF;
END $$;

ALTER TABLE neiist.membership DROP CONSTRAINT IF EXISTS valid_member_dates;
ALTER TABLE neiist.membership
  ADD CONSTRAINT valid_member_dates CHECK (to_date IS NULL OR to_date >= from_date);
