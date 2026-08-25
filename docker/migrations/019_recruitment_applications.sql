-- 019: recruitment applications (#134, slice A).
--
-- Replaces a "Candidata-te" button that pointed at https://google.com.
--
-- The modelling problem is that **one application has an independent outcome per team**. Someone
-- who applies to Dev-Team, Visuais and Fotografia may be accepted into one, two, all three, or
-- none — so the outcome cannot be a column on the application. It is a row per (application,
-- team), which is also what lets `canForTeam` authorize each decision separately.

-- A recruitment round. Applications belong to one, so "this year's candidates" is a filter rather
-- than a date range someone has to remember, and closing a round is one flag rather than a
-- convention.
CREATE TABLE IF NOT EXISTS neiist.recruitment_editions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (btrim(name) <> ''),
  opens_at   TIMESTAMPTZ NOT NULL,
  closes_at  TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT recruitment_editions_closes_after_opens CHECK (closes_at > opens_at)
);

-- Only one round may accept applications at a time: two open rounds means an applicant cannot
-- tell which they are applying to, and neither can the person reviewing.
--
-- NOT a partial unique index — `NOW()` is STABLE, not IMMUTABLE, and Postgres refuses it in an
-- index predicate. Correctly: an index whose membership changes with the clock is not an index.
-- The rule is enforced by this trigger instead, which is the right place for a constraint that
-- depends on time.
CREATE OR REPLACE FUNCTION neiist.check_one_open_edition() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM neiist.recruitment_editions e
    WHERE e.id <> coalesce(NEW.id, -1)
      AND tstzrange(e.opens_at, e.closes_at) && tstzrange(NEW.opens_at, NEW.closes_at)
  ) THEN
    RAISE EXCEPTION 'Já existe uma edição de recrutamento neste período.' USING ERRCODE = 'NEI20';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recruitment_editions_no_overlap ON neiist.recruitment_editions;
CREATE TRIGGER trg_recruitment_editions_no_overlap
  BEFORE INSERT OR UPDATE ON neiist.recruitment_editions
  FOR EACH ROW EXECUTE FUNCTION neiist.check_one_open_edition();

-- The application itself.
--
-- `istid` is NOT a foreign key to `neiist.users` on purpose: someone can apply before they have
-- ever logged in, and requiring an account first would put a Fenix login in front of a form that
-- should be open. It is captured so the acceptance flow can match them later.
--
-- Personal data lives here, and it belongs to people who may never become members. The retention
-- rule (6 months after rejection, decided 2026-08-25) is enforced by `purge_old_applications`
-- below rather than by anyone remembering.
CREATE TABLE IF NOT EXISTS neiist.recruitment_applications (
  id           SERIAL PRIMARY KEY,
  edition_id   INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL CHECK (btrim(full_name) <> ''),
  istid        VARCHAR(50) NOT NULL CHECK (btrim(istid) <> ''),
  email        TEXT NOT NULL CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone        TEXT,
  course       TEXT,
  year         INT CHECK (year IS NULL OR year BETWEEN 1 AND 10),
  motivation   TEXT,
  -- The application as a whole, distinct from the per-team outcomes below. `screened_out` is a
  -- rejection before any team looks; `closed` means every team has decided.
  status       TEXT NOT NULL DEFAULT 'submitted'
               CHECK (status IN ('submitted', 'screened_out', 'interviewing', 'closed')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,

  -- One application per person per round. A second attempt should edit the first, not create a
  -- rival that some teams see and others do not.
  CONSTRAINT recruitment_applications_one_per_edition UNIQUE (edition_id, istid)
);

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_edition
  ON neiist.recruitment_applications (edition_id, status);

-- The per-team half, and the reason this is not a status column.
--
-- `department_name` is the same key `internal_events` and `tasks` use, so `canForTeam` authorizes
-- these rows with no translation step — and a translation between the value authorized and the
-- value written is how a check and its effect come apart (#180).
CREATE TABLE IF NOT EXISTS neiist.recruitment_application_teams (
  application_id  INT NOT NULL REFERENCES neiist.recruitment_applications(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  outcome         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'accepted', 'rejected')),
  decided_by_istid VARCHAR(50) REFERENCES neiist.users(istid),
  decided_at      TIMESTAMPTZ,
  note            TEXT,

  PRIMARY KEY (application_id, department_name),

  -- A decision must say who made it and when; `pending` must not pretend to.
  CONSTRAINT recruitment_teams_decision_complete CHECK (
    (outcome = 'pending' AND decided_by_istid IS NULL AND decided_at IS NULL)
    OR (outcome <> 'pending' AND decided_by_istid IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_recruitment_teams_by_department
  ON neiist.recruitment_application_teams (department_name, outcome);

-- Submit an application with its team choices, atomically. Same pattern as create_internal_event.
--
-- Callable by ANYONE — this is the one public write in the workspace family — so every rule that
-- matters is here rather than in the route.
CREATE OR REPLACE FUNCTION neiist.submit_application(
  a_full_name  TEXT,
  a_istid      VARCHAR(50),
  a_email      TEXT,
  a_phone      TEXT,
  a_course     TEXT,
  a_year       INT,
  a_motivation TEXT,
  a_teams      VARCHAR(30)[]
) RETURNS INT AS $$
DECLARE
  v_edition INT;
  v_id      INT;
  v_teams   INT;
BEGIN
  IF a_full_name IS NULL OR btrim(a_full_name) = '' THEN
    RAISE EXCEPTION 'O nome é obrigatório.' USING ERRCODE = 'NEI19';
  END IF;
  IF a_istid IS NULL OR btrim(a_istid) = '' THEN
    RAISE EXCEPTION 'O número de aluno é obrigatório.' USING ERRCODE = 'NEI19';
  END IF;

  -- The open round. No open round means recruitment is closed, and saying so is better than
  -- silently accepting an application nobody will ever read.
  SELECT id INTO v_edition FROM neiist.recruitment_editions
  WHERE NOW() BETWEEN opens_at AND closes_at
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'As candidaturas estão fechadas de momento.' USING ERRCODE = 'NEI20';
  END IF;

  IF a_teams IS NULL OR array_length(a_teams, 1) IS NULL THEN
    RAISE EXCEPTION 'Escolhe pelo menos uma equipa.' USING ERRCODE = 'NEI19';
  END IF;

  -- Every chosen team must be a real, active team. An unknown name is a mistake worth showing,
  -- not something to drop silently — the applicant would never learn their choice vanished.
  SELECT count(*) INTO v_teams
  FROM unnest(a_teams) AS t(name)
  JOIN neiist.departments d ON d.name = t.name AND d.active AND d.department_type = 'team';

  IF v_teams <> array_length(a_teams, 1) THEN
    RAISE EXCEPTION 'Uma das equipas escolhidas não existe.' USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.recruitment_applications
    (edition_id, full_name, istid, email, phone, course, year, motivation)
  VALUES
    (v_edition, btrim(a_full_name), btrim(a_istid), lower(btrim(a_email)),
     NULLIF(btrim(coalesce(a_phone, '')), ''), NULLIF(btrim(coalesce(a_course, '')), ''),
     a_year, NULLIF(btrim(coalesce(a_motivation, '')), ''))
  RETURNING id INTO v_id;

  INSERT INTO neiist.recruitment_application_teams (application_id, department_name)
  SELECT v_id, t.name FROM unnest(a_teams) AS t(name)
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.submit_application(
  TEXT, VARCHAR(50), TEXT, TEXT, TEXT, INT, TEXT, VARCHAR(30)[]
) TO neiist_app_user;

-- Applications a given team can see.
--
-- **Takes a department and filters on it**, like every other reader in this family: an
-- application to Visuais is not Dev-Team's business, and there is deliberately no "all
-- applications" reader for anyone below the board.
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
  other_teams   TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, a.istid, a.email, a.phone, a.course, a.year, a.motivation,
         a.status, a.submitted_at, t.outcome, t.note,
         -- The other teams they applied to, so a coordinator can see the person is also being
         -- considered elsewhere. Names only — the other teams' decisions are theirs to make.
         coalesce(
           (SELECT array_agg(o.department_name ORDER BY o.department_name)
            FROM neiist.recruitment_application_teams o
            WHERE o.application_id = a.id AND o.department_name <> a_department),
           ARRAY[]::TEXT[])
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = a_department
  ORDER BY (t.outcome <> 'pending'), a.submitted_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_applications(VARCHAR(30)) TO neiist_app_user;

-- Decide on one team's part of an application. The actor is recorded, not passed as a claim
-- about authority: the route has already asked `canForTeam`, and this records who acted.
CREATE OR REPLACE FUNCTION neiist.decide_application_team(
  d_application INT,
  d_department  VARCHAR(30),
  d_outcome     TEXT,
  d_actor       VARCHAR(50),
  d_note        TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  IF d_outcome NOT IN ('pending', 'accepted', 'rejected') THEN
    RAISE EXCEPTION 'Decisão inválida.' USING ERRCODE = 'NEI19';
  END IF;

  UPDATE neiist.recruitment_application_teams
  SET outcome = d_outcome,
      note = NULLIF(btrim(coalesce(d_note, '')), ''),
      decided_by_istid = CASE WHEN d_outcome = 'pending' THEN NULL ELSE d_actor END,
      decided_at = CASE WHEN d_outcome = 'pending' THEN NULL ELSE NOW() END
  WHERE application_id = d_application AND department_name = d_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esta candidatura não inclui essa equipa.' USING ERRCODE = 'NEI20';
  END IF;

  -- The application closes once every team has decided. Derived rather than set by a caller, so
  -- it cannot drift from the rows it summarises.
  UPDATE neiist.recruitment_applications a
  SET status = 'closed', decided_at = NOW()
  WHERE a.id = d_application
    AND a.status <> 'screened_out'
    AND NOT EXISTS (
      SELECT 1 FROM neiist.recruitment_application_teams t
      WHERE t.application_id = a.id AND t.outcome = 'pending'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.decide_application_team(
  INT, VARCHAR(30), TEXT, VARCHAR(50), TEXT
) TO neiist_app_user;

-- Retention: 6 months after the application was decided (#134, decided 2026-08-25).
--
-- These are people who may never have joined NEIIST, and the GDPR exposure in Notion is a stated
-- motivation for the whole migration (#126) — importing that problem would defeat the point.
--
-- A function rather than a scheduled job because this database has no scheduler; calling it is
-- the deploy's or an operator's job, and it is idempotent so calling it twice is harmless.
CREATE OR REPLACE FUNCTION neiist.purge_old_applications()
RETURNS INT AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM neiist.recruitment_applications
  WHERE decided_at IS NOT NULL AND decided_at < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.purge_old_applications() TO neiist_app_user;
