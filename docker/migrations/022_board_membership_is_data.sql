-- 022 — "On the board" becomes its own piece of data, separate from the access grade (#217).
--
-- Tomás, 2026-08-25, when told the Diretores de Atividades could not give the board signature:
--
--   "The Diretores de Atividades are members of the board, so yes they should have the role
--    board instead of coordinator."
--
-- The intent is unambiguous. Taking it literally is not possible and would not do what he wants:
--
--   * There is no `board` access level. The only level above `coordinator` is `admin`, and
--     `admin` is ORGANISATION-WIDE by design (`ORGANISATION_WIDE = [_ADMIN]` in permissions.ts).
--     Grading the Diretores de Atividades `admin` would hand them read and write on EVERY team's
--     workspace — the Dev-Team situation of #189, deliberately created for two more people.
--   * Adding a `board` value to `user_access_enum` means defining what it grants at every one of
--     the ~50 permissions, i.e. a third fixed list. #185 rejected that twice, and rightly:
--     "board access is data, not a hardcoded list".
--
-- So the thing that is actually true — **these people sit on the Direção** — becomes a column,
-- and stays orthogonal to how much of the workspace their role opens. A Diretor de Atividades is
-- on the board AND is a coordinator; the Tesoureiro is on the board AND is graded `member`. The
-- old rule collapsed those two facts into one and that is why it got this wrong.

ALTER TABLE neiist.valid_department_roles
  ADD COLUMN IF NOT EXISTS board_member BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN neiist.valid_department_roles.board_member IS
  'Does holding this role make someone a member of the Direção? Orthogonal to `access`: it says '
  'who they are, not how much of the workspace they may open. Used for the second recruitment '
  'signature (#217). Editable through the roles screen — never hardcode a list of role names.';

-- Seed: the Direção roles that carry board authority.
--
-- Presidente / Vice-Presidente / Vogal were already reachable under the old `access = 'admin'`
-- rule. The two Diretores de Atividades are the correction Tomás asked for.
--
-- Idempotent by construction: it names the pairs and sets a value, so re-running changes nothing.
-- It does NOT reset rows to FALSE, deliberately — production may already have been edited through
-- the roles screen, and a migration that overwrites a deliberate human decision is worse than one
-- that under-applies. Adding a board member is a UI action; this only establishes the baseline.
UPDATE neiist.valid_department_roles
SET board_member = TRUE
WHERE department_name = 'Direção'
  AND role_name IN (
    'Presidente',
    'Vice-Presidente',
    'Vogal',
    'Diretora de Atividades (Alameda)',
    'Diretor de Atividades (Taguspark)'
  );

-- NOT seeded, and this is a decision rather than an oversight: **Tesoureiro** and **Diretora
-- SINFO**. Both sit on the Direção in the formal sense, and both are graded `member` on purpose
-- (#185) — the Diretor da SINFO heads a secção autónoma, "like a different part of NEIIST", and
-- the Tesoureiro "is treated like he isn't even a member, he just has the role". Nothing here
-- decides they should stay out; it declines to widen their authority as a side effect of a change
-- that was about the Diretores de Atividades. It is one toggle in the roles screen either way.

-- The board side of the two-signature approval now reads the column instead of inferring the
-- board from an `admin` grade inside a non-team department.
--
-- What this preserves: the reason the old rule checked `department_type <> 'team'` at all was that
-- `Dev-Team / Coordenador` is graded `admin` on purpose (#189), so a grade-only rule made one
-- team's coordinator the board signatory everywhere — #180 again. Reading an explicit column
-- keeps that closed by construction rather than by a join that has to be remembered: `Dev-Team /
-- Coordenador` is simply not `board_member`, whatever its access grade says.
CREATE OR REPLACE FUNCTION neiist.application_approval_sides(
  s_actor      VARCHAR(50),
  s_department VARCHAR(30)
) RETURNS TABLE (side TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT 'team'::TEXT
  WHERE EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = s_actor
      AND m.department_name = s_department
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.access IN ('coordinator', 'admin')
  )
  UNION ALL
  SELECT 'board'::TEXT
  WHERE EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = s_actor
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.board_member
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.application_approval_sides(VARCHAR, VARCHAR) TO neiist_app_user;

-- Editable without a deploy, which is the whole #185 principle. Separate from
-- `update_valid_department_role` on purpose: that one carries the last-admin lockout guard
-- because it changes what a role can DO, and this changes who someone IS. Conflating them would
-- put an irrelevant guard on one and hide a relevant one from the other.
CREATE OR REPLACE FUNCTION neiist.set_role_board_membership(
  b_department_name VARCHAR(30),
  b_role_name       VARCHAR(40),
  b_board_member    BOOLEAN
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.valid_department_roles
  SET board_member = b_board_member
  WHERE department_name = b_department_name AND role_name = b_role_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O cargo "%" não existe no departamento "%".', b_role_name, b_department_name
      USING ERRCODE = 'NEI03';
  END IF;

  -- A team's role must never be board membership: that is the #180 shape exactly — a claim that
  -- belongs to one team becoming authority over all of them. The board is an admin body.
  IF b_board_member AND EXISTS (
    SELECT 1 FROM neiist.departments
    WHERE name = b_department_name AND department_type = 'team'
  ) THEN
    RAISE EXCEPTION 'Só os órgãos sociais podem ter cargos da direção.' USING ERRCODE = 'NEI03';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_role_board_membership(VARCHAR(30), VARCHAR(40), BOOLEAN)
  TO neiist_app_user;

-- The roles screen needs to see the column to offer a toggle for it. Return type changes, so the
-- old signature has to go first — CREATE OR REPLACE cannot widen a RETURNS TABLE.
DROP FUNCTION IF EXISTS neiist.get_department_roles(VARCHAR(30));

CREATE OR REPLACE FUNCTION neiist.get_department_roles(u_department_name VARCHAR(30))
RETURNS TABLE (
  role_name    VARCHAR(40),
  access       neiist.user_access_enum,
  active       BOOLEAN,
  board_member BOOLEAN
) AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = u_department_name) THEN
    RAISE EXCEPTION 'O departamento "%" não existe.', u_department_name;
  END IF;

  RETURN QUERY
  SELECT vdr.role_name, vdr.access, vdr.active, vdr.board_member
  FROM neiist.valid_department_roles vdr
  WHERE vdr.department_name = u_department_name
  ORDER BY vdr.access DESC, vdr.role_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.get_department_roles(VARCHAR(30)) TO neiist_app_user;
