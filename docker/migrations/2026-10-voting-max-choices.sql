-- Migration: multiple choices per voter in voting sessions ("vote in up to N options").
--
-- docker/schema.sql only runs on an empty database, so an existing database (production,
-- staging, a dev volume) needs this script. It is safe to run on data that already has votes:
-- every existing ballot has exactly one row, which stays valid with max_choices = 1.
--
-- Run as the database owner (the same role that ran schema.sql), e.g.:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f docker/migrations/2026-10-voting-max-choices.sql

BEGIN;

-- 1. New column: how many options each voter may choose (1 keeps the old behaviour)
ALTER TABLE neiist.voting_sessions
  ADD COLUMN IF NOT EXISTS max_choices INTEGER NOT NULL DEFAULT 1 CHECK (max_choices >= 1);

-- 2. A voter can now have one row per chosen nominee
ALTER TABLE neiist.votes DROP CONSTRAINT IF EXISTS votes_pkey;
ALTER TABLE neiist.votes ADD PRIMARY KEY (session_id, voter_istid, nominee_id);

-- 3. Return types and signatures changed, so the old objects must be dropped first
DROP VIEW IF EXISTS neiist.voting_sessions_with_total_votes;
DROP FUNCTION IF EXISTS neiist.get_voting_sessions(INTEGER);
DROP FUNCTION IF EXISTS neiist.get_voting_session_by_id(INTEGER);
DROP FUNCTION IF EXISTS neiist.create_voting_session(TEXT, TEXT, VARCHAR, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS neiist.submit_vote(INTEGER, VARCHAR, TEXT);

-- 4. Recreate them (identical to docker/schema.sql)
-- Helper view for session data with total voters
-- Columns are listed explicitly so the functions below never depend on the table's column order.
CREATE OR REPLACE VIEW neiist.voting_sessions_with_total_votes AS
SELECT
    s.id,
    s.name,
    s.description,
    s.type,
    s.activity_id,
    s.status,
    s.start_at,
    s.end_at,
    s.created_at,
    s.updated_at,
    (SELECT COUNT(DISTINCT vt.voter_istid) FROM neiist.votes vt WHERE vt.session_id = s.id) as total_votes,
    s.show_results,
    s.max_choices
FROM neiist.voting_sessions s;

-- GET VOTING SESSIONS
CREATE OR REPLACE FUNCTION neiist.get_voting_sessions(p_limit INTEGER)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  type VARCHAR(20),
  activity_id TEXT,
  status TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  total_votes BIGINT,
  show_results BOOLEAN,
  max_choices INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id, v.name, v.description, v.type, v.activity_id, v.status, v.start_at, v.end_at,
    v.created_at, v.updated_at, v.total_votes, v.show_results, v.max_choices
  FROM neiist.voting_sessions_with_total_votes v
  ORDER BY v.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- GET VOTING SESSION BY ID
CREATE OR REPLACE FUNCTION neiist.get_voting_session_by_id(p_session_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  type VARCHAR(20),
  activity_id TEXT,
  status TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  total_votes BIGINT,
  show_results BOOLEAN,
  max_choices INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id, v.name, v.description, v.type, v.activity_id, v.status, v.start_at, v.end_at,
    v.created_at, v.updated_at, v.total_votes, v.show_results, v.max_choices
  FROM neiist.voting_sessions_with_total_votes v
  WHERE v.id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ADD VOTING SESSION
CREATE OR REPLACE FUNCTION neiist.create_voting_session(
  p_name TEXT,
  p_description TEXT,
  p_type VARCHAR(20),
  p_nominees JSONB,
  p_activity_id TEXT DEFAULT NULL,
  p_start_at TIMESTAMPTZ DEFAULT NULL,
  p_end_at TIMESTAMPTZ DEFAULT NULL,
  p_max_choices INTEGER DEFAULT 1
) RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  type VARCHAR(20),
  activity_id TEXT,
  status TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  total_votes BIGINT,
  show_results BOOLEAN,
  max_choices INTEGER
) AS $$
DECLARE
  v_session_id INTEGER;
  elem JSONB;
BEGIN
  INSERT INTO neiist.voting_sessions (name, description, type, activity_id, start_at, end_at, max_choices)
  VALUES (p_name, p_description, p_type, p_activity_id, p_start_at, p_end_at, COALESCE(p_max_choices, 1))
  RETURNING neiist.voting_sessions.id INTO v_session_id;

  IF p_nominees IS NOT NULL AND jsonb_typeof(p_nominees) = 'array' THEN
    FOR elem IN SELECT * FROM jsonb_array_elements(p_nominees)
    LOOP
      IF jsonb_typeof(elem) = 'object' THEN
        INSERT INTO neiist.voting_custom_options (session_id, id, name, photo_path, description_photo_path, description)
        VALUES (
          v_session_id,
          elem->>'id',
          elem->>'name',
          elem->>'photo_path',
          COALESCE(elem->>'description_photo_path', elem->>'photo_path'),
          elem->>'description'
        );

        INSERT INTO neiist.voting_nominees (session_id, nominee_id)
        VALUES (v_session_id, elem->>'id');
      ELSE
        INSERT INTO neiist.voting_nominees (session_id, nominee_id)
        VALUES (v_session_id, elem #>> '{}');
      END IF;
    END LOOP;
  END IF;

  RETURN QUERY SELECT * FROM neiist.get_voting_session_by_id(v_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- SUBMIT VOTE
-- Replaces the voter's whole ballot for the session with p_nominee_ids (1 to max_choices distinct nominees).
CREATE OR REPLACE FUNCTION neiist.submit_vote(
  p_session_id INTEGER,
  p_voter_istid VARCHAR(10),
  p_nominee_ids TEXT[]
) RETURNS VOID AS $$
DECLARE
  v_session neiist.voting_sessions%ROWTYPE;
  v_choices INTEGER := COALESCE(cardinality(p_nominee_ids), 0);
BEGIN
  -- Serialize concurrent submissions from the same voter so a ballot can never exceed max_choices
  PERFORM pg_advisory_xact_lock(p_session_id, hashtext(p_voter_istid));

  SELECT * INTO v_session FROM neiist.voting_sessions WHERE id = p_session_id;

  IF NOT FOUND OR v_session.status <> 'voting' THEN
    RAISE EXCEPTION 'Voting is not active for this session';
  END IF;

  IF v_session.start_at IS NOT NULL AND NOW() < v_session.start_at THEN
    RAISE EXCEPTION 'A votação ainda não começou';
  END IF;

  IF v_session.end_at IS NOT NULL AND NOW() > v_session.end_at THEN
    RAISE EXCEPTION 'A votação já terminou';
  END IF;

  IF v_choices < 1 THEN
    RAISE EXCEPTION 'Escolhe pelo menos uma opção';
  END IF;

  IF v_choices > v_session.max_choices THEN
    RAISE EXCEPTION 'Só podes escolher até % opções', v_session.max_choices;
  END IF;

  IF (SELECT COUNT(DISTINCT n) FROM unnest(p_nominee_ids) AS n) <> v_choices THEN
    RAISE EXCEPTION 'Não podes escolher a mesma opção mais do que uma vez';
  END IF;

  -- Check that every nominee is valid for this session
  IF EXISTS (
    SELECT 1 FROM unnest(p_nominee_ids) AS n
    WHERE NOT EXISTS (SELECT 1 FROM neiist.voting_nominees WHERE session_id = p_session_id AND nominee_id = n)
  ) THEN
    RAISE EXCEPTION 'Invalid nominee for this session';
  END IF;

  -- Replace the previous ballot, if any
  DELETE FROM neiist.votes WHERE session_id = p_session_id AND voter_istid = p_voter_istid;

  INSERT INTO neiist.votes (session_id, voter_istid, nominee_id)
  SELECT p_session_id, p_voter_istid, n FROM unnest(p_nominee_ids) AS n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.get_voting_sessions(INTEGER) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.get_voting_session_by_id(INTEGER) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.create_voting_session(TEXT, TEXT, VARCHAR, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.submit_vote(INTEGER, VARCHAR, TEXT[]) TO neiist_app_user;

COMMIT;
