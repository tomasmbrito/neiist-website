-- Temporary, delegable team access grants (#184).
--
-- The requirement: the board lends someone access to a team they are not in, and a team's
-- coordinator can pass their own loan on to one of their own members. Both expire.
--
-- Grants union into `get_user_team_scopes` (rewritten at the bottom of this file), so every
-- existing guard honours them with no call-site change. The price of that reach is that a grant
-- must not be able to do everything a membership does — see `source` in permissions.ts and
-- invariant 5 below.
--
-- Rows are NEVER deleted: expiry and revocation are recorded, not erased. This table is the audit
-- record for grants, and #160's `permission_audit_log` will use the action names `grant.create`
-- and `grant.revoke` so the two agree without a later rename.
CREATE TABLE IF NOT EXISTS neiist.team_access_grants (
  id                SERIAL PRIMARY KEY,
  grantee_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  access            neiist.user_access_enum NOT NULL,
  granted_by_istid  VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  -- A delegated grant points at the board grant it was carved out of. NULL = a root grant made by
  -- the board. Depth is capped at one (invariant 3): board -> coordinator -> member, no further.
  parent_grant_id   INT REFERENCES neiist.team_access_grants(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_by_istid  VARCHAR(50) REFERENCES neiist.users(istid),
  revoke_reason     TEXT,

  -- `_ADMIN` is ORGANISATION_WIDE: canForTeam short-circuits on it before it looks at the
  -- department at all. A "team" grant carrying admin would therefore be a global grant wearing a
  -- team's name. Refused in the type system, in the function, and here.
  CONSTRAINT team_access_grants_never_admin CHECK (access <> 'admin'),
  CONSTRAINT team_access_grants_expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT team_access_grants_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT team_access_grants_not_self CHECK (grantee_istid <> granted_by_istid),
  -- Revocation is all-or-nothing: a revoked row must say who and when.
  CONSTRAINT team_access_grants_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by_istid IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_istid IS NOT NULL)
  )
);

-- The read path: "every live grant for this istid". Partial on the liveness condition that
-- get_user_team_scopes applies, so the union below stays cheap on the hot path.
CREATE INDEX IF NOT EXISTS idx_team_access_grants_live
  ON neiist.team_access_grants (grantee_istid, department_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_team_access_grants_parent
  ON neiist.team_access_grants (parent_grant_id)
  WHERE parent_grant_id IS NOT NULL;

-- Rank for comparing access levels.
--
-- The enum's own ordinal order is DESCENDING authority and puts shop_manager above member
-- (schema.sql:19-24), so `access < 'member'` does not mean what it looks like. This mirrors
-- ACCESS_RANK in src/lib/auth/permissions.ts, and a test pins the two together — it is one policy
-- written in two languages, which is a thing that drifts unless something checks.
CREATE OR REPLACE FUNCTION neiist.access_rank(a neiist.user_access_enum)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE a
    WHEN 'admin'        THEN 3
    WHEN 'coordinator'  THEN 2
    WHEN 'shop_manager' THEN 1
    WHEN 'member'       THEN 1
    -- ELSE 0, not NULL. Without it a future `ALTER TYPE … ADD VALUE` makes this return NULL,
    -- and `IF NULL > x THEN RAISE` is treated as false — so the delegation ceiling below would
    -- fail OPEN and silently allow an over-privileged delegation.
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION neiist.access_rank(neiist.user_access_enum) TO neiist_app_user;

-- Is this grant live right now? One definition, used by the read path, the delegation check and
-- the UI, so "active" cannot come to mean three slightly different things.
-- STABLE, not IMMUTABLE: it reads NOW(), which is STABLE. Declaring it IMMUTABLE is a false
-- contract that entitles Postgres to constant-fold the result — and this one predicate is the
-- entire expiry model, so a folded "true" would keep an expired grant granting forever.
CREATE OR REPLACE FUNCTION neiist.is_grant_active(g neiist.team_access_grants)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT g.revoked_at IS NULL AND g.expires_at > NOW();
$$;

GRANT EXECUTE ON FUNCTION neiist.is_grant_active(neiist.team_access_grants) TO neiist_app_user;

-- Create a grant. SECURITY DEFINER, and the granter's authority is derived HERE from the
-- database — never passed in as an argument. The route hands over the caller's istid and nothing
-- else about who they are, so a compromised or careless route cannot claim authority it lacks.
--
-- Every check RAISEs rather than returning a falsy value, because ~58 of ~64 query functions in
-- this repo still `catch { return null }` (CLAUDE.md §8): a guard that reports failure by
-- returning something can be swallowed by a caller that was written before the guard existed.
CREATE OR REPLACE FUNCTION neiist.create_team_access_grant(
  g_actor_istid    VARCHAR(50),
  g_grantee_istid  VARCHAR(50),
  g_department     VARCHAR(30),
  g_access         neiist.user_access_enum,
  g_expires_at     TIMESTAMPTZ,
  g_reason         TEXT,
  g_parent_id      INT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_parent        neiist.team_access_grants;
  v_dept_type     VARCHAR(20);
  v_dept_active   BOOLEAN;
  v_new_id        INT;
BEGIN
  -- 5. Never admin. Checked before anything else because it is the one that would silently
  --    convert a team grant into an organisation-wide one.
  IF g_access = 'admin' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode conceder permissões de administrador.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 10. Not to yourself.
  IF g_grantee_istid = g_actor_istid THEN
    RAISE EXCEPTION 'Não é possível conceder acesso temporário a si próprio.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 6. Bounded in time, and bounded in how far ahead. The cap is what stops "temporary" from
  --    being permanent under another name.
  IF g_expires_at IS NULL OR g_expires_at <= NOW() THEN
    RAISE EXCEPTION 'A data de fim tem de ser no futuro.' USING ERRCODE = 'NEI11';
  END IF;
  IF g_expires_at > NOW() + INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode durar mais de 90 dias.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 7. A reason, always. This table is the audit record; a blank reason makes it useless.
  IF g_reason IS NULL OR btrim(g_reason) = '' THEN
    RAISE EXCEPTION 'É obrigatório indicar o motivo do acesso temporário.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 8. Only real, active teams. Admin bodies (Direção, Mesa da Assembleia Geral, Conselho Fiscal)
  --    hold the board's own material and are deliberately not lendable.
  SELECT d.department_type, d.active INTO v_dept_type, v_dept_active
  FROM neiist.departments d WHERE d.name = g_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A equipa "%" não existe.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF NOT v_dept_active THEN
    RAISE EXCEPTION 'A equipa "%" está inativa.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF v_dept_type <> 'team' THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a equipas.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 9. The grantee must already be a NEIIST member. Without this a grant would turn a non-member
  --    into someone `isNeiistMember` accepts, which is exactly the boundary #183 exists to hold:
  --    a grant lends access to ANOTHER team, it does not admit someone to the núcleo.
  IF NOT EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = g_grantee_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a membros do NEIIST.'
      USING ERRCODE = 'NEI11';
  END IF;

  IF g_parent_id IS NULL THEN
    -- 1. A ROOT grant creates new authority, so only the board may make one. This is the SQL
    --    mirror of ORGANISATION_WIDE = [_ADMIN] in permissions.ts, and it is membership-derived:
    --    a grant can never be the thing that lets you make grants.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.departments d ON d.name = m.department_name
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = g_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
        -- The authority must come from an ADMIN BODY, not from any role that happens to grant
        -- `admin`. Checking only `access = 'admin'` made this claim false against the real seed:
        -- `Dev-Team / Coordenador` is deliberately `admin` (#189), so one team's coordinator
        -- satisfied "only the board may create new authority" and could mint 90-day grants on
        -- every other team. Reading their department's type is what makes the sentence true.
        AND d.department_type <> 'team'
    ) THEN
      RAISE EXCEPTION 'Apenas a direção pode conceder acesso temporário a uma equipa.'
        USING ERRCODE = 'NEI08';
    END IF;
  ELSE
    -- FOR SHARE, so a concurrent revoke_team_access_grant (which takes FOR UPDATE on the same
    -- row) cannot commit between this read and the INSERT below. Without it, READ COMMITTED
    -- lets a child be created against a parent that is being revoked in another transaction:
    -- the revoke's cascading UPDATE never sees the new row, and the child outlives its source
    -- with no parent left to revoke it through.
    SELECT * INTO v_parent FROM neiist.team_access_grants WHERE id = g_parent_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'O acesso temporário de origem não existe.' USING ERRCODE = 'NEI09';
    END IF;

    -- 2. You may only pass on a grant that is yours and still live.
    IF v_parent.grantee_istid <> g_actor_istid THEN
      RAISE EXCEPTION 'Só pode delegar um acesso temporário que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF NOT neiist.is_grant_active(v_parent) THEN
      RAISE EXCEPTION 'O acesso temporário de origem já não está ativo.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF v_parent.department_name <> g_department THEN
      RAISE EXCEPTION 'Um acesso delegado tem de ser para a mesma equipa do acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF neiist.access_rank(g_access) > neiist.access_rank(v_parent.access) THEN
      RAISE EXCEPTION 'Não pode delegar mais acesso do que aquele que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF g_expires_at > v_parent.expires_at THEN
      RAISE EXCEPTION 'Um acesso delegado não pode durar mais do que o acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 3. Depth capped at one. Board -> coordinator -> member, and no further: an unbounded chain
    --    would make the original grant's blast radius impossible to reason about.
    IF v_parent.parent_grant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Um acesso já delegado não pode ser delegado novamente.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 4. "He should be able to give access to a member of HIS team." Both halves are
    --    membership-derived: the delegator must hold coordinator-or-higher somewhere by
    --    membership, and the grantee must be a member of that same department. A grant cannot
    --    bootstrap the authority to delegate.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership dm
      JOIN neiist.valid_department_roles dv
        ON dv.department_name = dm.department_name AND dv.role_name = dm.role_name
      JOIN neiist.membership gm
        ON gm.department_name = dm.department_name
       AND (gm.to_date IS NULL OR gm.to_date > CURRENT_DATE)
      WHERE dm.user_istid = g_actor_istid
        AND gm.user_istid = g_grantee_istid
        AND (dm.to_date IS NULL OR dm.to_date > CURRENT_DATE)
        AND dv.active
        AND neiist.access_rank(dv.access) >= neiist.access_rank('coordinator')
    ) THEN
      RAISE EXCEPTION
        'Só pode delegar acesso a um membro de uma equipa que coordena.'
        USING ERRCODE = 'NEI10';
    END IF;
  END IF;

  INSERT INTO neiist.team_access_grants
    (grantee_istid, department_name, access, granted_by_istid, parent_grant_id, reason, expires_at)
  VALUES
    (g_grantee_istid, g_department, g_access, g_actor_istid, g_parent_id, btrim(g_reason),
     g_expires_at)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_team_access_grant(
  VARCHAR(50), VARCHAR(50), VARCHAR(30), neiist.user_access_enum, TIMESTAMPTZ, TEXT, INT
) TO neiist_app_user;

-- Revoke a grant, and with it anything delegated from it.
--
-- Permitted to the person who granted it, to anyone organisation-wide, or to the grantee giving
-- it back. Revoking a parent revokes its children in the same statement: leaving a delegated
-- grant alive after its source was withdrawn is exactly the orphaned-authority case the depth cap
-- exists to keep thinkable.
CREATE OR REPLACE FUNCTION neiist.revoke_team_access_grant(
  r_actor_istid VARCHAR(50),
  r_grant_id    INT,
  r_reason      TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_grant neiist.team_access_grants;
BEGIN
  SELECT * INTO v_grant FROM neiist.team_access_grants WHERE id = r_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O acesso temporário não existe.' USING ERRCODE = 'NEI01';
  END IF;

  IF v_grant.revoked_at IS NOT NULL THEN
    -- Idempotent: revoking twice is not an error, it is the same outcome.
    RETURN;
  END IF;

  IF NOT (
    v_grant.granted_by_istid = r_actor_istid
    OR v_grant.grantee_istid = r_actor_istid
    OR EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = r_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
    )
    -- The RECEIVING team's own coordinator, by membership. Without this the one person
    -- responsible for a team could not remove an outsider the board lent to it — they would see
    -- the grant on their own team's page and have no way to end it.
    OR EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = r_actor_istid
        AND m.department_name = v_grant.department_name
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND neiist.access_rank(v.access) >= neiist.access_rank('coordinator')
    )
  ) THEN
    RAISE EXCEPTION 'Não tem permissão para revogar este acesso temporário.'
      USING ERRCODE = 'NEI12';
  END IF;

  UPDATE neiist.team_access_grants
  SET revoked_at = NOW(), revoked_by_istid = r_actor_istid, revoke_reason = btrim(r_reason)
  WHERE id = r_grant_id OR (parent_grant_id = r_grant_id AND revoked_at IS NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.revoke_team_access_grant(VARCHAR(50), INT, TEXT) TO neiist_app_user;

-- Grants on a team, for the coordinator's screen. Newest first; revoked and expired rows are
-- included because the point of an audit record is that it still shows you what happened.
CREATE OR REPLACE FUNCTION neiist.get_team_access_grants(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  grantee_istid    VARCHAR(50),
  grantee_name     VARCHAR(100),
  access           neiist.user_access_enum,
  granted_by_istid VARCHAR(50),
  granted_by_name  VARCHAR(100),
  parent_grant_id  INT,
  reason           TEXT,
  granted_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  is_active        BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.grantee_istid, gu.name, g.access, g.granted_by_istid, au.name,
         g.parent_grant_id, g.reason, g.granted_at, g.expires_at, g.revoked_at,
         neiist.is_grant_active(g)
  FROM neiist.team_access_grants g
  JOIN neiist.users gu ON gu.istid = g.grantee_istid
  JOIN neiist.users au ON au.istid = g.granted_by_istid
  WHERE g.department_name = g_department
  ORDER BY g.granted_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_access_grants(VARCHAR(30)) TO neiist_app_user;

-- The grants this person holds and could pass on. Used by the UI to offer delegation only when
-- there is actually something to delegate.
CREATE OR REPLACE FUNCTION neiist.get_user_active_grants(u_istid VARCHAR(50))
RETURNS TABLE (
  id              INT,
  department_name VARCHAR(30),
  access          neiist.user_access_enum,
  parent_grant_id INT,
  expires_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.department_name, g.access, g.parent_grant_id, g.expires_at
  FROM neiist.team_access_grants g
  WHERE g.grantee_istid = u_istid AND neiist.is_grant_active(g)
  ORDER BY g.expires_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_user_active_grants(VARCHAR(50)) TO neiist_app_user;

-- Rewritten: memberships UNION live grants (#184).
--
-- Unioned HERE, at the source, rather than consulted separately by each guard. Every guard that
-- exists — canForTeam, visibleWorkspaceTeams, isNeiistMember, requireTeamWorkspace — and every
-- guard written for #129/#130/#131 then honours grants by construction. The alternative is a rule
-- written twice that eventually disagrees with itself, which is the exact shape of #97, #117
-- and #180.
--
-- `source` comes back so TypeScript can tell the two apart: a grant deliberately does NOT confer
-- everything a membership does (it cannot assign permanent roles, and it only satisfies the
-- permissions in GRANTABLE_TEAM_PERMISSIONS). Returning it is what makes that distinction
-- possible at all.
--
-- Expiry needs no job and no cleanup: scopes are re-read from the database on every request and
-- the JWT carries none, so the first request after expires_at simply comes back with fewer rows.
DROP FUNCTION IF EXISTS neiist.get_user_team_scopes(VARCHAR(50));

CREATE OR REPLACE FUNCTION neiist.get_user_team_scopes(u_istid VARCHAR(50))
RETURNS TABLE (
  department_name VARCHAR(30),
  department_type VARCHAR(20),
  access          neiist.user_access_enum,
  source          TEXT
) AS $$
  -- Current memberships only: to_date IS NULL, or still in the future. This is the same
  -- liveness rule get_user applies, and idx_membership_active indexes exactly it.
  --
  -- DISTINCT because a person can hold several roles in one department that map to the same
  -- access level; the caller wants the set of levels they have there, not a row per role.
  SELECT DISTINCT
    m.department_name,
    d.department_type,
    v.access,
    'membership'::TEXT
  FROM neiist.membership m
  JOIN neiist.departments d ON d.name = m.department_name
  JOIN neiist.valid_department_roles v
    ON v.department_name = m.department_name
   AND v.role_name = m.role_name
  WHERE m.user_istid = u_istid
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    AND d.active
    AND v.active

  UNION

  SELECT DISTINCT
    g.department_name,
    d.department_type,
    g.access,
    'grant'::TEXT
  FROM neiist.team_access_grants g
  JOIN neiist.departments d ON d.name = g.department_name
  WHERE g.grantee_istid = u_istid
    AND neiist.is_grant_active(g)
    AND d.active
    -- A grant is strictly ADDITIVE to membership, never a substitute for it.
    --
    -- `create_team_access_grant` already refuses a grant to a non-member, but that is checked
    -- once, at INSERT. Checking it only there meant a grant kept working after the grantee left
    -- the núcleo: offboarding ends their membership row, the membership branch above returns
    -- nothing, and this branch alone would still return a scope — making `isNeiistMember`
    -- (`scopes.length > 0`) true for an ex-member and handing them another team's internal
    -- workspace for up to 90 more days, with nothing in the admin UI showing why.
    --
    -- Enforced on the READ path because that is the only place that can react to a membership
    -- ending, which is an event this table never sees.
    AND EXISTS (
      SELECT 1
      FROM neiist.membership m
      WHERE m.user_istid = g.grantee_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.get_user_team_scopes(VARCHAR(50)) TO neiist_app_user;
