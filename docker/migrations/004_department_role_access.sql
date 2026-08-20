-- 004: make a department role's access level editable, and stop an admin locking everyone out
--      (#158)
--
-- ⚠️ Like 003, this REPLACES a function that already exists. Production's real schema is
-- unmeasured (#152).
--
-- ## Why
--
-- valid_department_roles maps (department, role) -> access level, and it is what decides whether
-- a member is an admin, a coordinator, a shop manager or a plain member. Until now the only
-- operations were add and remove: there was no way to say "the Dev-Team coordinator is also a
-- shop manager" without deleting the role — which ends every current membership of it
-- (remove_valid_department_role sets to_date on the membership rows) and then re-adding it, so
-- people silently lose their position and their history.
--
-- ## The lockout
--
-- remove_valid_department_role had no guard. Demonstrated against the dev database inside a
-- rolled-back transaction: removing every access='admin' role in a loop leaves
--
--     admin_roles_left   0
--     users_still_admin  0
--
-- and managing roles requires admin or coordinator, so once those go too nobody can restore
-- them from the application. Recovery means a psql session against production, which — per #152
-- — is exactly the thing nobody has a documented path for.
--
-- The guard is in SQL rather than in the API because the API is not the only caller and a future
-- one should not have to remember. Same reasoning as #146.
--
-- Idempotent: CREATE OR REPLACE over full bodies.

-- Number of people who currently hold a given department role. Used by the UI to say "this
-- affects N members" before an access level is changed, so the consequence is visible.
CREATE OR REPLACE FUNCTION neiist.count_department_role_members(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS INTEGER
-- SECURITY DEFINER because the app calls this directly and neiist_app_user has no table
-- privileges by design (schema.sql:11-16). Caught by a test: "permission denied for table
-- membership".
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER
  FROM neiist.membership m
  WHERE m.department_name = u_department_name
    AND m.role_name = u_role_name
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE);
$$;

-- How many active roles still grant admin, excluding one (department, role) pair. The exclusion
-- is what lets both callers below ask "if I change/remove this one, is anything left?".
CREATE OR REPLACE FUNCTION neiist.count_other_admin_roles(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER
  FROM neiist.valid_department_roles v
  WHERE v.access = 'admin'
    AND v.active
    AND NOT (v.department_name = u_department_name AND v.role_name = u_role_name);
$$;

CREATE OR REPLACE FUNCTION neiist.update_valid_department_role(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
DECLARE
  v_current neiist.user_access_enum;
BEGIN
  SELECT v.access INTO v_current
  FROM neiist.valid_department_roles v
  WHERE v.department_name = u_department_name AND v.role_name = u_role_name AND v.active
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A posição "%" para o departamento "%" não existe.',
      u_role_name, u_department_name
      USING ERRCODE = 'NEI06';
  END IF;

  -- Demoting the last admin-level role is the lockout, so it is refused here as well as in
  -- remove: "change it to member" and "delete it" have the same effect on who can administer.
  IF v_current = 'admin' AND u_access <> 'admin'
     AND neiist.count_other_admin_roles(u_department_name, u_role_name) = 0 THEN
    RAISE EXCEPTION
      'Não é possível remover o último cargo com acesso de administrador — ficaria sem administradores.'
      USING ERRCODE = 'NEI07';
  END IF;

  UPDATE neiist.valid_department_roles v
  SET access = u_access
  WHERE v.department_name = u_department_name AND v.role_name = u_role_name AND v.active;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unchanged except for the guard. Body copied so the migration is self-contained and reviewable
-- rather than a diff against something the reader has to go and find.
CREATE OR REPLACE FUNCTION neiist.remove_valid_department_role(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.valid_department_roles WHERE department_name = u_department_name
      AND role_name = u_role_name) THEN
    RAISE EXCEPTION 'A posição "%" para o departamento "%" não existe.', u_role_name, u_department_name
      USING ERRCODE = 'NEI06';
  END IF;

  IF EXISTS (
    SELECT 1 FROM neiist.valid_department_roles
    WHERE department_name = u_department_name AND role_name = u_role_name
      AND access = 'admin' AND active
  ) AND neiist.count_other_admin_roles(u_department_name, u_role_name) = 0 THEN
    RAISE EXCEPTION
      'Não é possível remover o último cargo com acesso de administrador — ficaria sem administradores.'
      USING ERRCODE = 'NEI07';
  END IF;

  UPDATE neiist.valid_department_roles SET active = FALSE
    WHERE department_name = u_department_name AND role_name = u_role_name;
  UPDATE neiist.membership SET to_date = CURRENT_DATE
    WHERE department_name = u_department_name AND role_name = u_role_name
      AND (to_date IS NULL OR to_date > CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.count_department_role_members(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.count_other_admin_roles(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.update_valid_department_role(VARCHAR(30), VARCHAR(40), neiist.user_access_enum) TO neiist_app_user;
