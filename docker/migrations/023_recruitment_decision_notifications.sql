-- 023 — Telling the candidate, exactly once (#223, #134 slice C).
--
-- This is the slice #217 was blocking. Until the two signatures existed, one click closed a
-- decision, and adding email to that would have meant one click emailing a person that they are
-- in or out. Now the outcome is DERIVED from two signatures and cannot be assigned, so "this
-- decision is final" is a fact about the data rather than a hope about the UI.
--
-- The problem this file solves is **exactly once**, and it is not solved by calling sendEmail()
-- from wherever the decision closes. Three things go wrong with that:
--
--   1. The decision closes inside `record_application_approval`. Sending there means a network
--      call while a transaction holds a pooled connection — forbidden for the reason CLAUDE.md
--      gives: no rollback can unsend an email.
--   2. Two people can complete two teams' pairs at the same moment; without a claim, both drain
--      the same row.
--   3. A retry after a crash re-sends.
--
-- So: a **transactional outbox**. The trigger that settles the outcome writes a row in the same
-- transaction — it either happens with the decision or not at all. Sending happens afterwards,
-- outside any transaction, against rows it CLAIMS first. If the send then fails, the claim is
-- released and the error is recorded where the team can see it.

CREATE TABLE IF NOT EXISTS neiist.recruitment_decision_notifications (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),

  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Claimed, then sent. Two columns rather than one because the gap between them is exactly the
  -- window where a crash loses an email, and it should be visible rather than inferred.
  claimed_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,

  -- Acceptance only. Stored as a SHA-256 hash: this grants an onboarding flow to somebody who is
  -- NOT yet a member, so it is a credential, and a credential in a database column is one leak
  -- away from being usable. The plaintext exists only in the email.
  onboarding_token_hash TEXT UNIQUE,
  token_expires_at      TIMESTAMPTZ,
  token_used_at         TIMESTAMPTZ,

  -- One notification per (application, team), FOREVER. This is the honest model rather than a
  -- convenient one: a sent email cannot be unsent, so withdrawing a signature afterwards must not
  -- produce a second, contradicting message. The row stays, and the review screen shows that the
  -- candidate was already told.
  PRIMARY KEY (application_id, department_name),

  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE,

  CONSTRAINT decision_notification_token_only_on_accept CHECK (
    onboarding_token_hash IS NULL OR outcome = 'accepted'
  )
);

-- The drain queue: everything not yet sent, oldest first.
CREATE INDEX IF NOT EXISTS idx_decision_notifications_unsent
  ON neiist.recruitment_decision_notifications (queued_at)
  WHERE sent_at IS NULL;

-- Queue a notification the moment a team's outcome settles.
--
-- ON CONFLICT DO NOTHING is what makes this exactly-once at the queueing end: a decision that is
-- withdrawn and re-made does not queue a second email. Combined with the claim below, an email
-- is sent at most once for a given (application, team) for as long as the application exists.
CREATE OR REPLACE FUNCTION neiist.queue_decision_notification() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.outcome <> 'pending' AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    -- Screened-out applications never reached a team decision, so they are not notified here.
    IF EXISTS (
      SELECT 1 FROM neiist.recruitment_applications
      WHERE id = NEW.application_id AND status <> 'screened_out'
    ) THEN
      INSERT INTO neiist.recruitment_decision_notifications
        (application_id, department_name, outcome)
      VALUES (NEW.application_id, NEW.department_name, NEW.outcome)
      ON CONFLICT (application_id, department_name) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_queue_decision_notification
  ON neiist.recruitment_application_teams;

CREATE TRIGGER trg_queue_decision_notification
AFTER UPDATE ON neiist.recruitment_application_teams
FOR EACH ROW EXECUTE FUNCTION neiist.queue_decision_notification();

-- Claim everything ready to send, and return what the email needs.
--
-- The UPDATE is the claim, and it is the whole concurrency story: `WHERE sent_at IS NULL AND
-- claimed_at IS NULL` with RETURNING is atomic, so two concurrent drains partition the queue
-- between them instead of both sending it. `SKIP LOCKED` keeps the second caller from blocking on
-- the first rather than simply getting the rows the first did not take.
--
-- Deliberately returns the candidate's name and email — this is the one place they are needed
-- outside the reviewing team, and the function is called by the server, never by a route that
-- echoes it back.
CREATE OR REPLACE FUNCTION neiist.claim_decision_notifications(c_limit INT DEFAULT 50)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  outcome         TEXT,
  full_name       TEXT,
  email           TEXT,
  attempts        INT
) AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE neiist.recruitment_decision_notifications n
    SET claimed_at = NOW(), attempts = n.attempts + 1
    WHERE (n.application_id, n.department_name) IN (
      SELECT c.application_id, c.department_name
      FROM neiist.recruitment_decision_notifications c
      WHERE c.sent_at IS NULL AND c.claimed_at IS NULL
      ORDER BY c.queued_at
      LIMIT c_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING n.application_id, n.department_name, n.outcome, n.attempts
  )
  SELECT c.application_id, c.department_name, c.outcome, a.full_name, a.email, c.attempts
  FROM claimed c
  JOIN neiist.recruitment_applications a ON a.id = c.application_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.claim_decision_notifications(INT) TO neiist_app_user;

-- The send worked. For an acceptance this is also where the onboarding token is recorded — after
-- the email is out, so a token can never exist for a message nobody received.
CREATE OR REPLACE FUNCTION neiist.mark_decision_notification_sent(
  m_application INT,
  m_department  VARCHAR(30),
  m_token_hash  TEXT DEFAULT NULL,
  m_expires_at  TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET sent_at = NOW(),
      last_error = NULL,
      onboarding_token_hash = m_token_hash,
      token_expires_at = m_expires_at
  WHERE application_id = m_application AND department_name = m_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há notificação por enviar para esta candidatura.' USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.mark_decision_notification_sent(
  INT, VARCHAR(30), TEXT, TIMESTAMPTZ
) TO neiist_app_user;

-- The send failed. Release the claim so a later drain retries, and keep the reason.
--
-- The error is stored rather than logged because of the acceptance criterion that failures are
-- visible to the TEAM: a coordinator watching for a reply needs to know the email never left,
-- and a line in a server log is not something they will ever see.
CREATE OR REPLACE FUNCTION neiist.mark_decision_notification_failed(
  m_application INT,
  m_department  VARCHAR(30),
  m_error       TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET claimed_at = NULL,
      last_error = left(coalesce(m_error, 'Erro desconhecido.'), 500)
  WHERE application_id = m_application AND department_name = m_department
    AND sent_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.mark_decision_notification_failed(INT, VARCHAR(30), TEXT)
  TO neiist_app_user;

-- Look up a token, for the onboarding page (#224, slice D).
--
-- Takes the HASH, never the plaintext — the caller hashes what the visitor presented. Returns
-- nothing for a token that is unknown, expired, or already used, so the page cannot tell those
-- apart by probing and none of them is a way in.
CREATE OR REPLACE FUNCTION neiist.find_onboarding_token(t_hash TEXT)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  full_name       TEXT,
  email           TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT n.application_id, n.department_name, a.full_name, a.email
  FROM neiist.recruitment_decision_notifications n
  JOIN neiist.recruitment_applications a ON a.id = n.application_id
  WHERE n.onboarding_token_hash = t_hash
    AND n.outcome = 'accepted'
    AND n.token_used_at IS NULL
    AND (n.token_expires_at IS NULL OR n.token_expires_at > NOW());
$$;

GRANT EXECUTE ON FUNCTION neiist.find_onboarding_token(TEXT) TO neiist_app_user;

-- Spend a token. Conditional on it still being unused, so two simultaneous submissions cannot
-- both succeed — the second gets zero rows rather than a second run of whatever it guards.
CREATE OR REPLACE FUNCTION neiist.consume_onboarding_token(t_hash TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET token_used_at = NOW()
  WHERE onboarding_token_hash = t_hash
    AND outcome = 'accepted'
    AND token_used_at IS NULL
    AND (token_expires_at IS NULL OR token_expires_at > NOW())
  RETURNING TRUE INTO v_ok;

  RETURN coalesce(v_ok, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.consume_onboarding_token(TEXT) TO neiist_app_user;

-- The review screen gains the send state, so "did the candidate actually hear back?" is answerable
-- where the decision is made rather than in a server log. Return type changes, so drop first.
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
  board_actor    TEXT,
  notified_at    TIMESTAMPTZ,
  notify_error   TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, a.istid, a.email, a.phone, a.course, a.year, a.motivation,
         a.status, a.submitted_at, t.outcome, t.note,
         coalesce(
           (SELECT array_agg(o.department_name ORDER BY o.department_name)
            FROM neiist.recruitment_application_teams o
            WHERE o.application_id = a.id AND o.department_name <> a_department),
           ARRAY[]::TEXT[]),
         tm.decision, tmu.name, bd.decision, bdu.name,
         n.sent_at, n.last_error
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = a_department
  LEFT JOIN neiist.recruitment_application_approvals tm
    ON tm.application_id = a.id AND tm.department_name = a_department AND tm.side = 'team'
  LEFT JOIN neiist.users tmu ON tmu.istid = tm.actor_istid
  LEFT JOIN neiist.recruitment_application_approvals bd
    ON bd.application_id = a.id AND bd.department_name = a_department AND bd.side = 'board'
  LEFT JOIN neiist.users bdu ON bdu.istid = bd.actor_istid
  LEFT JOIN neiist.recruitment_decision_notifications n
    ON n.application_id = a.id AND n.department_name = a_department
  ORDER BY (t.outcome <> 'pending'), a.submitted_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_applications(VARCHAR(30)) TO neiist_app_user;
