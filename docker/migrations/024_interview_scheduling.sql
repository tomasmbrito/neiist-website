-- 024 — Availability and interview booking (#218).
--
-- Tomás, 2026-08-25:
--
--   "the teams coordinators could put their availability in their crabfits, and then when someone
--    passes the first part of the candidatura, and goes to mark an interview, it could already
--    show the available slots (according to the coordinator), and then the person chooses their
--    slot there, and it automatically locks the slot, and sends a confirmation email for the
--    person and also sends an email for the coordinator"
--
-- The hard part is "it automatically locks the slot", and it is not the UI. Two candidates opening
-- the page at the same moment must not both get 20:00. A SELECT that checks availability followed
-- by an INSERT that claims it is the classic check-then-act race, and this repository has already
-- hit it twice — #79 (the per-user cap) and #100 (the stock cap). Both times the fix was the same:
-- **make the claim itself the check**, in one statement.
--
-- So there is no "is it free?" query anywhere in the booking path. `claim_interview_slot` is a
-- single conditional UPDATE whose WHERE clause is the availability test and whose success is the
-- reservation. Under READ COMMITTED a second claim blocks on the row lock, then re-evaluates its
-- WHERE against the committed new version, finds the slot taken, and updates zero rows. The test
-- for this holds a transaction open on a second connection — `Promise.all` does not reproduce it
-- (measured, and written down in the decision log on 2026-08-19).

-- ---------------------------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------------------------

-- Availability belongs to a PERSON, not a team: three coordinators of one team have three
-- different calendars, and a candidate is meeting one of them. `department_name` is carried too,
-- because the same person may coordinate for one team and merely help in another, and a candidate
-- applying to Visuais must not be offered a Fotografia interview.
CREATE TABLE IF NOT EXISTS neiist.interview_slots (
  id                SERIAL PRIMARY KEY,
  edition_id        INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE CASCADE,
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  coordinator_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  location          TEXT,

  -- A soft hold, taken when a candidate picks the slot. It becomes a booking once the interview
  -- event exists and the emails are out. Two columns rather than one because the gap between them
  -- is where a crash would otherwise lock a slot forever — an unconfirmed hold simply expires.
  held_by_application_id INT REFERENCES neiist.recruitment_applications(id) ON DELETE SET NULL,
  hold_expires_at        TIMESTAMPTZ,

  booked_application_id  INT REFERENCES neiist.recruitment_applications(id) ON DELETE SET NULL,
  booked_at              TIMESTAMPTZ,
  -- The interview itself is an `internal_event` (#129), not a second parallel calendar.
  event_id               INT REFERENCES neiist.internal_events(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT interview_slot_ends_after_start CHECK (ends_at > starts_at),
  -- One person cannot be in two places. This is also what stops a coordinator publishing the same
  -- hour twice by clicking twice.
  CONSTRAINT interview_slot_unique_per_coordinator UNIQUE (coordinator_istid, starts_at),
  -- A booking must say who and when; a free slot must not pretend to.
  CONSTRAINT interview_slot_booking_complete CHECK (
    (booked_application_id IS NULL AND booked_at IS NULL)
    OR (booked_application_id IS NOT NULL AND booked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_interview_slots_open
  ON neiist.interview_slots (edition_id, department_name, starts_at)
  WHERE booked_application_id IS NULL;

-- Publish one slot. Idempotent on (coordinator, start) so a double-click adds nothing.
CREATE OR REPLACE FUNCTION neiist.add_interview_slot(
  s_edition     INT,
  s_department  VARCHAR(30),
  s_coordinator VARCHAR(50),
  s_starts_at   TIMESTAMPTZ,
  s_ends_at     TIMESTAMPTZ,
  s_location    TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF s_ends_at <= s_starts_at THEN
    RAISE EXCEPTION 'O fim tem de ser depois do início.' USING ERRCODE = 'NEI19';
  END IF;

  INSERT INTO neiist.interview_slots
    (edition_id, department_name, coordinator_istid, starts_at, ends_at, location)
  VALUES (s_edition, s_department, s_coordinator, s_starts_at, s_ends_at,
          NULLIF(btrim(coalesce(s_location, '')), ''))
  ON CONFLICT (coordinator_istid, starts_at) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM neiist.interview_slots
    WHERE coordinator_istid = s_coordinator AND starts_at = s_starts_at;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_interview_slot(
  INT, VARCHAR(30), VARCHAR(50), TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO neiist_app_user;

-- Withdraw a slot. Refuses once it is booked: the candidate has been told, and deleting the row
-- would leave them turning up to an interview nobody has.
CREATE OR REPLACE FUNCTION neiist.remove_interview_slot(
  s_id          INT,
  s_coordinator VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.interview_slots
  WHERE id = s_id
    -- Only your own. A coordinator deleting a colleague's availability is not a thing anyone asked
    -- for, and scoping it here means the route cannot forget.
    AND coordinator_istid = s_coordinator
    AND booked_application_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não é possível remover: o horário não é teu ou já foi marcado.'
      USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.remove_interview_slot(INT, VARCHAR(50)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- What a candidate is offered
-- ---------------------------------------------------------------------------------------------

-- Free slots for THIS candidate's team, in the round they applied to.
--
-- "Free" includes a slot whose hold has expired — otherwise somebody who opened the page and
-- wandered off would take an interview time out of circulation permanently.
--
-- Keyed by application, not by department, so a candidate cannot enumerate another team's
-- schedule by changing a parameter. The coordinator's name is returned because a candidate is
-- meeting a person and should know who; nothing else about them is.
CREATE OR REPLACE FUNCTION neiist.get_free_interview_slots(g_application INT)
RETURNS TABLE (
  id               INT,
  department_name  VARCHAR(30),
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, s.department_name, u.name, s.starts_at, s.ends_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  JOIN neiist.recruitment_applications a ON a.id = g_application
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = s.department_name
  WHERE s.edition_id = a.edition_id
    AND s.starts_at > NOW()
    AND s.booked_application_id IS NULL
    AND (s.held_by_application_id IS NULL
         OR s.hold_expires_at < NOW()
         OR s.held_by_application_id = g_application)
  ORDER BY s.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_free_interview_slots(INT) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- The claim — the whole point of this file
-- ---------------------------------------------------------------------------------------------

-- Take a slot. ONE statement, whose WHERE clause is the availability test and whose success is
-- the reservation. There is deliberately no preceding "is it free?" SELECT: that gap is the race.
--
-- Returns the slot id on success and NULL when somebody else got there first, rather than raising
-- — losing a race is an ordinary outcome the page must render ("esse horário acabou de ser
-- ocupado"), not an error condition.
--
-- The hold lasts 15 minutes. Confirmation turns it into a booking; if the caller dies in between,
-- the slot returns to the pool by itself.
CREATE OR REPLACE FUNCTION neiist.claim_interview_slot(
  c_slot        INT,
  c_application INT
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  UPDATE neiist.interview_slots s
  SET held_by_application_id = c_application,
      hold_expires_at = NOW() + INTERVAL '15 minutes'
  WHERE s.id = c_slot
    AND s.starts_at > NOW()
    AND s.booked_application_id IS NULL
    AND (s.held_by_application_id IS NULL
         OR s.hold_expires_at < NOW()
         OR s.held_by_application_id = c_application)
    -- The slot must belong to a team this candidate actually applied to. Checked here rather than
    -- in the route because the claim is the only place that can be sure, and a candidate holding
    -- a slot id from another team is exactly what a guessed parameter looks like.
    AND EXISTS (
      SELECT 1 FROM neiist.recruitment_application_teams t
      JOIN neiist.recruitment_applications a ON a.id = t.application_id
      WHERE t.application_id = c_application
        AND t.department_name = s.department_name
        AND a.edition_id = s.edition_id
    )
  RETURNING s.id INTO v_id;

  -- One candidate, one interview per team: release any other hold they were carrying, so browsing
  -- back and forth does not silently reserve half the afternoon.
  IF v_id IS NOT NULL THEN
    UPDATE neiist.interview_slots
    SET held_by_application_id = NULL, hold_expires_at = NULL
    WHERE held_by_application_id = c_application
      AND id <> v_id
      AND booked_application_id IS NULL;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.claim_interview_slot(INT, INT) TO neiist_app_user;

-- Turn a held slot into a booking, once the interview event exists.
--
-- Conditional on the hold still being the caller's and still live, so a confirmation that arrives
-- after the hold expired and somebody else took the slot fails instead of double-booking.
CREATE OR REPLACE FUNCTION neiist.confirm_interview_slot(
  c_slot        INT,
  c_application INT,
  c_event       INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  UPDATE neiist.interview_slots
  SET booked_application_id = c_application,
      booked_at = NOW(),
      event_id = c_event,
      held_by_application_id = NULL,
      hold_expires_at = NULL
  WHERE id = c_slot
    AND booked_application_id IS NULL
    AND held_by_application_id = c_application
    AND hold_expires_at > NOW()
  RETURNING TRUE INTO v_ok;

  IF coalesce(v_ok, FALSE) THEN
    -- The application is now being interviewed. Derived from the booking rather than set by a
    -- caller, the same reasoning as `outcome` and `status` elsewhere in this pipeline.
    UPDATE neiist.recruitment_applications
    SET status = 'interviewing'
    WHERE id = c_application AND status = 'submitted';
  END IF;

  RETURN coalesce(v_ok, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.confirm_interview_slot(INT, INT, INT) TO neiist_app_user;

-- Cancel a booking; the slot goes back in the pool.
--
-- The interview event is deliberately NOT deleted here — it is the coordinator's calendar and
-- deleting from under them is worse than a stale entry they can remove. The link is cleared so a
-- re-booking cannot inherit it.
CREATE OR REPLACE FUNCTION neiist.cancel_interview_booking(
  c_slot        INT,
  c_application INT
) RETURNS INT AS $$
DECLARE
  v_event INT;
BEGIN
  UPDATE neiist.interview_slots
  SET booked_application_id = NULL,
      booked_at = NULL,
      event_id = NULL,
      held_by_application_id = NULL,
      hold_expires_at = NULL
  WHERE id = c_slot AND booked_application_id = c_application
  RETURNING event_id INTO v_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não tens uma entrevista marcada nesse horário.' USING ERRCODE = 'NEI20';
  END IF;

  RETURN v_event;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.cancel_interview_booking(INT, INT) TO neiist_app_user;

-- Housekeeping: drop holds nobody confirmed. Idempotent, so calling it twice is harmless, and it
-- is a function rather than a scheduled job because this database has no scheduler — the same
-- decision as `purge_old_applications` (#134).
--
-- Note that the claim already treats an expired hold as free, so this is tidying rather than
-- correctness. Correctness must never depend on a cleanup job having run.
CREATE OR REPLACE FUNCTION neiist.release_expired_interview_holds() RETURNS INT AS $$
DECLARE
  v_released INT;
BEGIN
  UPDATE neiist.interview_slots
  SET held_by_application_id = NULL, hold_expires_at = NULL
  WHERE booked_application_id IS NULL
    AND held_by_application_id IS NOT NULL
    AND hold_expires_at < NOW();

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.release_expired_interview_holds() TO neiist_app_user;

-- What a coordinator sees: their own published availability and what became of it.
CREATE OR REPLACE FUNCTION neiist.get_team_interview_slots(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT,
  booked_name      TEXT,
  held             BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, u.name, s.starts_at, s.ends_at, s.location, a.full_name,
         (s.held_by_application_id IS NOT NULL AND s.hold_expires_at > NOW())
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  LEFT JOIN neiist.recruitment_applications a ON a.id = s.booked_application_id
  WHERE s.department_name = g_department
  ORDER BY s.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_interview_slots(VARCHAR(30)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- How a candidate reaches the page at all
-- ---------------------------------------------------------------------------------------------

-- A candidate is not a user: they have no account, and scheduling must not create one as a side
-- effect — the same rule as onboarding not creating a membership (#134), for the same reason
-- (#193). So access to the booking page is a capability, not an identity: a hashed token, issued
-- when a coordinator invites them, spent by visiting.
--
-- Hashed for the reason #223 hashes its token: it grants a stranger a page, so it is a credential,
-- and a credential in a column is one leak away from being usable.
CREATE TABLE IF NOT EXISTS neiist.interview_invites (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      VARCHAR(50) REFERENCES neiist.users(istid),

  PRIMARY KEY (application_id, department_name),
  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE
);

-- Invite a candidate to book. Replaces any previous invite for the same (application, team) so a
-- coordinator re-sending does not leave two live tokens for one person.
CREATE OR REPLACE FUNCTION neiist.issue_interview_invite(
  i_application INT,
  i_department  VARCHAR(30),
  i_token_hash  TEXT,
  i_expires_at  TIMESTAMPTZ,
  i_actor       VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM neiist.recruitment_application_teams
    WHERE application_id = i_application AND department_name = i_department
  ) THEN
    RAISE EXCEPTION 'Esta candidatura não inclui essa equipa.' USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.interview_invites
    (application_id, department_name, token_hash, expires_at, created_by)
  VALUES (i_application, i_department, i_token_hash, i_expires_at, i_actor)
  ON CONFLICT (application_id, department_name) DO UPDATE
  SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      created_at = NOW(),
      created_by = EXCLUDED.created_by;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.issue_interview_invite(
  INT, VARCHAR(30), TEXT, TIMESTAMPTZ, VARCHAR(50)
) TO neiist_app_user;

-- Resolve a token to the candidate it belongs to. Takes the HASH, never the plaintext.
--
-- Returns nothing for unknown, expired, or an application that has since been decided — a
-- candidate who has already had their answer has no interview to book, and the same empty result
-- for all three means probing distinguishes nothing.
CREATE OR REPLACE FUNCTION neiist.find_interview_invite(t_hash TEXT)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  full_name       TEXT,
  email           TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT i.application_id, i.department_name, a.full_name, a.email
  FROM neiist.interview_invites i
  JOIN neiist.recruitment_applications a ON a.id = i.application_id
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = i.application_id AND t.department_name = i.department_name
  WHERE i.token_hash = t_hash
    AND i.expires_at > NOW()
    AND t.outcome = 'pending'
    AND a.status <> 'screened_out';
$$;

GRANT EXECUTE ON FUNCTION neiist.find_interview_invite(TEXT) TO neiist_app_user;

-- The candidate's own booking, for the page to show after they have chosen.
CREATE OR REPLACE FUNCTION neiist.get_interview_booking(g_application INT, g_department VARCHAR(30))
RETURNS TABLE (
  slot_id          INT,
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, u.name, s.starts_at, s.ends_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  WHERE s.booked_application_id = g_application
    AND s.department_name = g_department;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_interview_booking(INT, VARCHAR(30)) TO neiist_app_user;

-- Who the confirmation emails go to. One query rather than three, so the send path holds no
-- transaction open while it assembles addresses.
CREATE OR REPLACE FUNCTION neiist.get_interview_notification_targets(g_slot INT)
RETURNS TABLE (
  candidate_name   TEXT,
  candidate_email  TEXT,
  coordinator_name TEXT,
  coordinator_mail TEXT,
  department_name  VARCHAR(30),
  starts_at        TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.full_name, a.email, u.name, u.email, s.department_name, s.starts_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.recruitment_applications a ON a.id = s.booked_application_id
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  WHERE s.id = g_slot;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_interview_notification_targets(INT) TO neiist_app_user;
