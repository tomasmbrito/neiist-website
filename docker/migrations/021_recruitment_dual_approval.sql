-- 021 — Recruitment: no decision reaches a candidate on one person's say-so (#217).
--
-- Tomás, 2026-08-25:
--   "in order for the emails (of rejection or acceptance) to be sent, both the coordinator of
--    that team and at least one member of the board should accept their candidatura"
--
-- #215 recorded ONE `outcome` per (application, team), settable by anyone holding
-- `team.recruitment.decide` — which is `[_ADMIN, _COORDINATOR]`. So a single coordinator, or a
-- single board member, closed the decision alone. That was harmless only because nothing was
-- sent. It stops being harmless the moment slice C exists, where one click mails a person that
-- they are in or out. This is why #217 blocks slice C rather than being a note on it.
--
-- Three properties, all enforced here rather than in the route:
--
--   1. TWO approvals, recorded separately, with who and when for each.
--   2. The outcome is DERIVED from them by trigger, never assigned. Same reasoning as `status`
--      being derived in #215: a summary a caller can set is a summary that can disagree with
--      what it summarises.
--   3. The two approvals must come from two PEOPLE, and each must actually hold the side they
--      are filling. The route does not get to say which side someone is acting as.

-- ---------------------------------------------------------------------------------------------
-- The approvals themselves.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS neiist.recruitment_application_approvals (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  -- Which half of the pair this is. Not a claim the caller makes — `record_application_approval`
  -- derives it from the actor's real memberships and refuses if they do not hold it.
  side            TEXT NOT NULL CHECK (side IN ('team', 'board')),
  decision        TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  actor_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note            TEXT,

  PRIMARY KEY (application_id, department_name, side),

  -- Cascades with the team row, which cascades with the application, which the 6-month retention
  -- purge deletes. An approval is a record about a candidate and must not outlive them (#134).
  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE,

  -- "Both" means two people. Someone who is a coordinator of the team AND on the board may fill
  -- either slot, but not both: the point is a second pair of eyes, and one person holding two
  -- hats is still one pair. Enforced here rather than in the UI because the UI is not a boundary.
  CONSTRAINT recruitment_approval_two_people
    UNIQUE (application_id, department_name, actor_istid)
);

-- The board's queue: everything waiting on a board signature, across all teams.
CREATE INDEX IF NOT EXISTS idx_recruitment_approvals_by_side
  ON neiist.recruitment_application_approvals (side, decided_at);

-- ---------------------------------------------------------------------------------------------
-- The outcome becomes derived.
-- ---------------------------------------------------------------------------------------------

-- Recompute one (application, team) outcome from its approvals, then re-derive the application's
-- status the same way #215 did.
--
-- The rule, from the quotation above: NOTHING is settled until both sides have spoken. A single
-- rejection does not settle it either — an email saying "no" is still an email, and Tomás asked
-- for both signatures on rejections as explicitly as on acceptances. So:
--
--     both sides accepted            -> accepted
--     both sides in, any rejection   -> rejected
--     anything else                  -> pending
--
-- `decided_by_istid` records whoever COMPLETED the pair, because the CHECK from #215 wants one
-- istid and the completing signature is the one that made it real. The full pair is in the
-- approvals table; this column is a summary, and is read as one.
CREATE OR REPLACE FUNCTION neiist.recompute_application_outcome() RETURNS TRIGGER AS $$
DECLARE
  v_app    INT;
  v_dept   VARCHAR(30);
  v_team   INT;
  v_board  INT;
  v_reject INT;
BEGIN
  v_app  := COALESCE(NEW.application_id, OLD.application_id);
  v_dept := COALESCE(NEW.department_name, OLD.department_name);

  SELECT count(*) FILTER (WHERE side = 'team'),
         count(*) FILTER (WHERE side = 'board'),
         count(*) FILTER (WHERE decision = 'reject')
    INTO v_team, v_board, v_reject
  FROM neiist.recruitment_application_approvals
  WHERE application_id = v_app AND department_name = v_dept;

  IF v_team = 0 OR v_board = 0 THEN
    UPDATE neiist.recruitment_application_teams
    SET outcome = 'pending', decided_by_istid = NULL, decided_at = NULL
    WHERE application_id = v_app AND department_name = v_dept;
  ELSE
    UPDATE neiist.recruitment_application_teams t
    SET outcome = CASE WHEN v_reject > 0 THEN 'rejected' ELSE 'accepted' END,
        decided_by_istid = last.actor_istid,
        decided_at = last.decided_at,
        -- The team's note is the one about the candidate's fit; the board's is a sign-off. The
        -- team's is what the summary carries, and both remain readable in the approvals table.
        note = (
          SELECT NULLIF(btrim(coalesce(a.note, '')), '')
          FROM neiist.recruitment_application_approvals a
          WHERE a.application_id = v_app AND a.department_name = v_dept AND a.side = 'team'
        )
    FROM (
      SELECT a.actor_istid, a.decided_at
      FROM neiist.recruitment_application_approvals a
      WHERE a.application_id = v_app AND a.department_name = v_dept
      ORDER BY a.decided_at DESC, a.side DESC
      LIMIT 1
    ) AS last
    WHERE t.application_id = v_app AND t.department_name = v_dept;
  END IF;

  -- Derived exactly as in #215: closed once no team is still pending. Recomputed in BOTH
  -- directions, because withdrawing an approval must reopen an application that had closed —
  -- otherwise a withdrawal would leave a 'closed' application with a 'pending' team.
  UPDATE neiist.recruitment_applications a
  SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM neiist.recruitment_application_teams t
          WHERE t.application_id = a.id AND t.outcome = 'pending'
        ) THEN 'closed'
        -- Reopening restores 'submitted' ONLY from 'closed'. Writing it unconditionally would
        -- erase 'interviewing' — someone withdrawing a signature would silently un-schedule the
        -- interview the candidate had already been invited to.
        WHEN a.status = 'closed' THEN 'submitted'
        ELSE a.status END,
      decided_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM neiist.recruitment_application_teams t
          WHERE t.application_id = a.id AND t.outcome = 'pending'
        ) THEN NULL ELSE NOW() END
  WHERE a.id = v_app AND a.status <> 'screened_out';

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_recompute_application_outcome
  ON neiist.recruitment_application_approvals;

CREATE TRIGGER trg_recompute_application_outcome
AFTER INSERT OR UPDATE OR DELETE ON neiist.recruitment_application_approvals
FOR EACH ROW EXECUTE FUNCTION neiist.recompute_application_outcome();

-- ---------------------------------------------------------------------------------------------
-- Recording an approval.
-- ---------------------------------------------------------------------------------------------

-- Which sides does this person actually hold, for this team?
--
-- 'board' is DATA, not a hardcoded list of names (#185): an active membership in a department
-- whose type is not 'team', with a role graded `admin`. Against the real seed that is exactly
-- Direção's Presidente, Vice-Presidente and Vogal — Conselho Fiscal and Mesa da Assembleia Geral
-- top out at `coordinator`, which is the whole reason Mesa "only has what we give them", and
-- Tesoureiro and Diretora SINFO are `member` on purpose. Change who signs off by editing
-- `valid_department_roles`, not this function.
--
-- Reading `department_type` matters and is not decoration: `Dev-Team / Coordenador` is graded
-- `admin` on purpose (#189), so a rule that checked only `access = 'admin'` would let one team's
-- coordinator supply the BOARD half of every other team's recruitment. That is #180 again.
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
    JOIN neiist.departments d ON d.name = m.department_name
    WHERE m.user_istid = s_actor
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.access = 'admin'
      AND d.department_type <> 'team'
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.application_approval_sides(VARCHAR, VARCHAR) TO neiist_app_user;

-- Record one half of the pair.
--
-- `a_side` is a HINT, for the one person who holds both, not an instruction — it is checked
-- against `application_approval_sides` and refused if they do not hold it. A route that passed
-- 'board' for a team coordinator gets an error, not a board approval. This is the difference
-- between a check and its effect that #180 was about.
CREATE OR REPLACE FUNCTION neiist.record_application_approval(
  a_application INT,
  a_department  VARCHAR(30),
  a_decision    TEXT,
  a_actor       VARCHAR(50),
  a_side        TEXT DEFAULT NULL,
  a_note        TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_sides TEXT[];
  v_side  TEXT;
BEGIN
  IF a_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'Decisão inválida.' USING ERRCODE = 'NEI19';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM neiist.recruitment_application_teams
    WHERE application_id = a_application AND department_name = a_department
  ) THEN
    RAISE EXCEPTION 'Esta candidatura não inclui essa equipa.' USING ERRCODE = 'NEI20';
  END IF;

  SELECT array_agg(side) INTO v_sides
  FROM neiist.application_approval_sides(a_actor, a_department);

  IF v_sides IS NULL THEN
    RAISE EXCEPTION 'Não tens autoridade para decidir sobre esta candidatura.'
      USING ERRCODE = 'NEI21';
  END IF;

  IF a_side IS NOT NULL THEN
    IF NOT (a_side = ANY(v_sides)) THEN
      RAISE EXCEPTION 'Não podes assinar como %.', a_side USING ERRCODE = 'NEI21';
    END IF;
    v_side := a_side;
  ELSIF array_length(v_sides, 1) = 1 THEN
    v_side := v_sides[1];
  ELSE
    -- Holds both. Fill whichever half is still open; if both are open the caller must choose,
    -- because picking for them would silently spend the signature they meant to give later.
    SELECT s INTO v_side FROM unnest(v_sides) AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM neiist.recruitment_application_approvals x
      WHERE x.application_id = a_application AND x.department_name = a_department AND x.side = s
    )
    LIMIT 1;

    IF v_side IS NULL OR (SELECT count(*) FROM unnest(v_sides) AS s
                          WHERE NOT EXISTS (
                            SELECT 1 FROM neiist.recruitment_application_approvals x
                            WHERE x.application_id = a_application
                              AND x.department_name = a_department AND x.side = s)) > 1 THEN
      RAISE EXCEPTION 'Indica se assinas pela equipa ou pela direção.' USING ERRCODE = 'NEI21';
    END IF;
  END IF;

  -- ON CONFLICT so someone may change their own mind; the UNIQUE on (application, team, actor)
  -- is what stops them changing somebody else's. A conflict on the actor constraint means one
  -- person is reaching for the second signature, and must fail loudly rather than overwrite.
  BEGIN
    INSERT INTO neiist.recruitment_application_approvals
      (application_id, department_name, side, decision, actor_istid, note)
    VALUES (a_application, a_department, v_side, a_decision, a_actor,
            NULLIF(btrim(coalesce(a_note, '')), ''))
    ON CONFLICT (application_id, department_name, side) DO UPDATE
    SET decision = EXCLUDED.decision,
        actor_istid = EXCLUDED.actor_istid,
        decided_at = NOW(),
        note = EXCLUDED.note;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'As duas aprovações têm de ser de pessoas diferentes.' USING ERRCODE = 'NEI22';
  END;

  RETURN v_side;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.record_application_approval(
  INT, VARCHAR, TEXT, VARCHAR, TEXT, TEXT
) TO neiist_app_user;

-- Withdraw a signature. Deliberately allowed while the decision is still forming, and it
-- reopens the application through the same trigger — a pair that can only be assembled and
-- never taken apart makes an accidental click permanent.
CREATE OR REPLACE FUNCTION neiist.withdraw_application_approval(
  w_application INT,
  w_department  VARCHAR(30),
  w_actor       VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.recruitment_application_approvals
  WHERE application_id = w_application
    AND department_name = w_department
    -- Only your own. Removing someone else's signature is how one person gets both halves.
    AND actor_istid = w_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não tens nenhuma aprovação registada nesta candidatura.'
      USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.withdraw_application_approval(INT, VARCHAR, VARCHAR)
  TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- `decide_application_team` is withdrawn.
-- ---------------------------------------------------------------------------------------------

-- Leaving it callable would leave the single-click path open next to the two-signature one, and
-- the whole point of #217 is that the single-click path stops existing. Dropped rather than
-- rewritten so nothing keeps a stale reference to it.
DROP FUNCTION IF EXISTS neiist.decide_application_team(INT, VARCHAR(30), TEXT, VARCHAR(50), TEXT);

-- ---------------------------------------------------------------------------------------------
-- Reads: what is waiting on whom.
-- ---------------------------------------------------------------------------------------------

-- `get_team_applications` gains the two signatures. Return type changes, so it must be dropped
-- first — CREATE OR REPLACE cannot widen a RETURNS TABLE.
DROP FUNCTION IF EXISTS neiist.get_team_applications(VARCHAR(30));

CREATE OR REPLACE FUNCTION neiist.get_team_applications(a_department VARCHAR(30))
RETURNS TABLE (
  id            INT,
  full_name     TEXT,
  istid         VARCHAR(50),
  email         TEXT,
  phone         TEXT,
  course        TEXT,
  year          INT,
  motivation    TEXT,
  status        TEXT,
  submitted_at  TIMESTAMPTZ,
  outcome       TEXT,
  note          TEXT,
  other_teams   TEXT[],
  team_decision  TEXT,
  team_actor     TEXT,
  board_decision TEXT,
  board_actor    TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, a.istid, a.email, a.phone, a.course, a.year, a.motivation,
         a.status, a.submitted_at, t.outcome, t.note,
         -- The other teams they applied to, so a coordinator can see the person is also being
         -- considered elsewhere. Names only — the other teams' decisions are theirs to make.
         coalesce(
           (SELECT array_agg(o.department_name ORDER BY o.department_name)
            FROM neiist.recruitment_application_teams o
            WHERE o.application_id = a.id AND o.department_name <> a_department),
           ARRAY[]::TEXT[]),
         tm.decision, tmu.name, bd.decision, bdu.name
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = a_department
  LEFT JOIN neiist.recruitment_application_approvals tm
    ON tm.application_id = a.id AND tm.department_name = a_department AND tm.side = 'team'
  LEFT JOIN neiist.users tmu ON tmu.istid = tm.actor_istid
  LEFT JOIN neiist.recruitment_application_approvals bd
    ON bd.application_id = a.id AND bd.department_name = a_department AND bd.side = 'board'
  LEFT JOIN neiist.users bdu ON bdu.istid = bd.actor_istid
  ORDER BY (t.outcome <> 'pending'), a.submitted_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_applications(VARCHAR(30)) TO neiist_app_user;

-- The board's queue: every application across every team where the TEAM has signed and the board
-- has not. Deliberately narrow — the board is not asked to review what the team has not looked at
-- yet, which is the practical reason the two signatures are ordered in the first place.
--
-- No motivation, phone or course here: this is a work queue, not the application. The board opens
-- the team's page for the detail, where the same authorization already applies. Handing over the
-- full record of every applicant to build a list would be collecting more than the list needs.
CREATE OR REPLACE FUNCTION neiist.get_board_pending_applications()
RETURNS TABLE (
  id              INT,
  full_name       TEXT,
  department_name VARCHAR(30),
  submitted_at    TIMESTAMPTZ,
  team_decision   TEXT,
  team_actor      TEXT,
  team_note       TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, t.department_name, a.submitted_at, tm.decision, u.name, tm.note
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t ON t.application_id = a.id
  JOIN neiist.recruitment_application_approvals tm
    ON tm.application_id = a.id AND tm.department_name = t.department_name AND tm.side = 'team'
  LEFT JOIN neiist.users u ON u.istid = tm.actor_istid
  WHERE a.status <> 'screened_out'
    AND NOT EXISTS (
      SELECT 1 FROM neiist.recruitment_application_approvals bd
      WHERE bd.application_id = a.id AND bd.department_name = t.department_name
        AND bd.side = 'board'
    )
  ORDER BY tm.decided_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_board_pending_applications() TO neiist_app_user;
