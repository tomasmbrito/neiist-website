-- 011: a coordinator can no longer promote a role to `admin` (#193).
--
-- `members.roles.manage` is held by [_ADMIN, _COORDINATOR], `PATCH /api/admin/roles` checked only
-- that, and `update_valid_department_role` took **no actor argument at all** — so nothing anywhere
-- asked "may this person grant `admin`?". A coordinator pointed the endpoint at their own role,
-- raised it to `admin`, and became organisation-wide admin: the full user directory (real student
-- PII), department and role management, the shop's admin surface, and every team's workspace.
--
-- Demonstrated end to end before this fix. It is a different escalation from #180/#181, which
-- covered assigning yourself a *membership*; this one never touches `membership`, it changes what
-- a role the person already holds is worth. The last-admin guard (#158) is the opposite direction
-- — it refuses removing the last admin, and says nothing about creating one.
--
-- The rule lives here rather than in the route because the route is not the only caller, and
-- because ~58 of ~64 query functions still `catch { return null }`: a guard that reports failure
-- by returning something falsy is a guard that can be swallowed.

-- May this person hand out organisation-wide access? Only someone who already holds it.
--
-- Membership-derived, deliberately: this must not be satisfiable by anything that a caller could
-- themselves have been given temporarily (#184 grants are not in `membership`).
CREATE OR REPLACE FUNCTION neiist.may_grant_admin_access(a_istid VARCHAR(50))
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = a_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.access = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.may_grant_admin_access(VARCHAR(50)) TO neiist_app_user;

-- Guarded overloads. The actor is the FIRST parameter and has no default, so a call site cannot
-- omit it and silently get the unguarded behaviour — the mistake that made this possible.
--
-- A NULL actor is permitted and means "no admin authority". Two internal call sites
-- (`addMember`, `addCollaborator`) create roles at fixed non-admin levels and have no actor to
-- thread; passing NULL there is safe *because* it fails closed — NULL can never satisfy
-- `may_grant_admin_access`, so a NULL actor can create a `member` or `coordinator` role and can
-- never create an `admin` one.
CREATE OR REPLACE FUNCTION neiist.update_valid_department_role(
  u_actor_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
BEGIN
  IF u_access = 'admin' AND NOT neiist.may_grant_admin_access(u_actor_istid) THEN
    RAISE EXCEPTION
      'Apenas um administrador pode atribuir o nível de acesso de administrador a um cargo.'
      USING ERRCODE = 'NEI13';
  END IF;
  PERFORM neiist.update_valid_department_role(u_department_name, u_role_name, u_access);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION neiist.add_valid_department_role(
  u_actor_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
BEGIN
  IF u_access = 'admin' AND NOT neiist.may_grant_admin_access(u_actor_istid) THEN
    RAISE EXCEPTION
      'Apenas um administrador pode criar um cargo com o nível de acesso de administrador.'
      USING ERRCODE = 'NEI13';
  END IF;
  PERFORM neiist.add_valid_department_role(u_department_name, u_role_name, u_access);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.update_valid_department_role(
  VARCHAR(50), VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.add_valid_department_role(
  VARCHAR(50), VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) TO neiist_app_user;

-- Close the back door. The three-argument forms have no actor and therefore cannot be guarded;
-- they stay because `docker/init.sql` seeds through them as the OWNER role, but the application
-- role must not be able to reach them — otherwise the guarded overload is advice, not a boundary.
--
-- `schema.sql:13-14` grants EXECUTE on everything in the schema to neiist_app_user, so this
-- REVOKE has to come after, and any future function of this shape has to remember the same.
-- FROM PUBLIC as well as from the app role. Postgres grants EXECUTE on every new function to
-- PUBLIC by default, so revoking from neiist_app_user alone leaves the privilege intact through
-- PUBLIC — `has_function_privilege` still answered true, which is how this was caught.
REVOKE EXECUTE ON FUNCTION neiist.update_valid_department_role(
  VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) FROM PUBLIC, neiist_app_user;
REVOKE EXECUTE ON FUNCTION neiist.add_valid_department_role(
  VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) FROM PUBLIC, neiist_app_user;
