-- 020: collaborating teams and per-event visibility (#219).
--
-- Two corrections to the model built in #129, both from how NEIIST actually works — see
-- docs/ai-workflow/how-neiist-works.md.
--
-- 1. **An event is owned by one team but worked on by several.** An event starts in Organização de
--    Eventos (or with the board, for bigger ones) and grows collaborators as the work needs them:
--    a poster pulls in Visuais, a story pulls in Divulgação. Today a Visuais member brought in to
--    make the poster **cannot see the event they are working on**.
--
-- 2. **Visibility is a choice, not a boolean.** `is_public` has two states; the núcleo needs four,
--    and the missing one is "members" — "every member should see the Jantar de Curso, but it is
--    not for the public". That cannot be said today at all.
--
-- Both are additive. `owner_department_name` keeps its meaning (accountability), so every existing
-- guard keeps working unchanged.

-- Teams helping with an event, beyond the one that owns it.
CREATE TABLE IF NOT EXISTS neiist.event_collaborating_teams (
  event_id        INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, department_name)
);

-- The read path: "which events can this team see", for collaborators.
CREATE INDEX IF NOT EXISTS idx_event_collaborators_by_department
  ON neiist.event_collaborating_teams (department_name);

-- Visibility, replacing the boolean.
--
-- Added as a new column with a DERIVED default rather than a rewrite: `is_public` stays, and is
-- kept in step by the trigger below, so anything still reading it — the public calendar, the
-- Google sync — keeps working while this lands. #137 removes `is_public` once nothing reads it.
--
-- The order matters: 'public' is the widest and 'owner' the narrowest, and code that compares
-- them should use the helper below rather than the enum's ordinal, for the reason `access_rank`
-- exists (schema.sql's `user_access_enum` taught this the hard way).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_visibility_enum') THEN
    CREATE TYPE neiist.event_visibility_enum AS ENUM ('public', 'members', 'teams', 'owner');
  END IF;
END
$$;

ALTER TABLE neiist.internal_events
  ADD COLUMN IF NOT EXISTS visibility neiist.event_visibility_enum;

-- Backfill from the boolean, which is exactly what it meant.
UPDATE neiist.internal_events
SET visibility = CASE WHEN is_public THEN 'public'::neiist.event_visibility_enum
                      ELSE 'teams'::neiist.event_visibility_enum END
WHERE visibility IS NULL;

-- **No column DEFAULT, deliberately.** A default is applied before a BEFORE INSERT trigger runs,
-- so the trigger could never tell "the caller said nothing" from "the caller said teams" — and
-- that is exactly the distinction it needs to derive visibility from `is_public` for the callers
-- that still pass only the boolean. The trigger sets it in every path instead, which is why the
-- column can still be NOT NULL.
ALTER TABLE neiist.internal_events
  ALTER COLUMN visibility DROP DEFAULT;

-- NOT NULL only after the backfill, so the migration is safe on a populated database.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'neiist' AND table_name = 'internal_events'
      AND column_name = 'visibility' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE neiist.internal_events ALTER COLUMN visibility SET NOT NULL;
  END IF;
END
$$;

-- Keep `is_public` in step with `visibility`, in both directions.
--
-- Two columns meaning one thing is exactly what this repository keeps getting bitten by, so this
-- is deliberately temporary: it exists only so that the public calendar and the Google Calendar
-- sync — which still read `is_public` — cannot disagree with the workspace while #219 lands
-- across several PRs. Removing `is_public` is #137's job, and the trigger goes with it.
CREATE OR REPLACE FUNCTION neiist.sync_event_visibility() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit visibility wins; otherwise derive it from is_public so old callers still work.
    IF NEW.visibility IS NULL THEN
      NEW.visibility := CASE WHEN NEW.is_public THEN 'public' ELSE 'teams' END;
    END IF;
    NEW.is_public := (NEW.visibility = 'public');
    RETURN NEW;
  END IF;

  -- On update, whichever column actually changed is the one the caller meant.
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    NEW.is_public := (NEW.visibility = 'public');
  ELSIF NEW.is_public IS DISTINCT FROM OLD.is_public THEN
    NEW.visibility := CASE WHEN NEW.is_public THEN 'public' ELSE 'teams' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_internal_events_visibility ON neiist.internal_events;
CREATE TRIGGER trg_internal_events_visibility
  BEFORE INSERT OR UPDATE ON neiist.internal_events
  FOR EACH ROW EXECUTE FUNCTION neiist.sync_event_visibility();

-- Teams that can see an event: the owner, plus collaborators.
-- Keyed by event id AND asking department, like every other read here (#126). Who else is working
-- on an event is itself internal: it says which teams NEIIST pulled in and therefore what the
-- event involves. An id belonging to an unrelated team returns zero rows, so a guessed id tells
-- the caller nothing — rather than relying on the route to compare owners afterwards.
DROP FUNCTION IF EXISTS neiist.event_teams(INT);

CREATE OR REPLACE FUNCTION neiist.event_teams(e_id INT, asking_department VARCHAR(30))
RETURNS TABLE (department_name VARCHAR(30))
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH teams AS (
    SELECT owner_department_name AS name FROM neiist.internal_events WHERE id = e_id
    UNION
    SELECT c.department_name FROM neiist.event_collaborating_teams c WHERE c.event_id = e_id
  )
  SELECT name FROM teams
  WHERE EXISTS (SELECT 1 FROM teams t WHERE t.name = asking_department);
$$;

GRANT EXECUTE ON FUNCTION neiist.event_teams(INT, VARCHAR) TO neiist_app_user;

-- Add or remove a collaborating team.
--
-- Refuses the owner (it is already there, and a row saying otherwise would make `event_teams`
-- return a duplicate) and refuses an unknown department, rather than silently doing nothing —
-- the person adding Visuais to the poster needs to know if it did not take.
CREATE OR REPLACE FUNCTION neiist.set_event_collaborator(
  c_event_id   INT,
  c_department VARCHAR(30),
  c_add        BOOLEAN
) RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT owner_department_name INTO v_owner FROM neiist.internal_events WHERE id = c_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O evento não existe.' USING ERRCODE = 'NEI15';
  END IF;

  IF c_add THEN
    IF c_department = v_owner THEN
      RAISE EXCEPTION 'A equipa responsável já tem acesso ao evento.' USING ERRCODE = 'NEI14';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = c_department AND active) THEN
      RAISE EXCEPTION 'A equipa "%" não existe ou está inativa.', c_department
        USING ERRCODE = 'NEI15';
    END IF;
    INSERT INTO neiist.event_collaborating_teams (event_id, department_name)
    VALUES (c_event_id, c_department)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM neiist.event_collaborating_teams
    WHERE event_id = c_event_id AND department_name = c_department;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_event_collaborator(INT, VARCHAR(30), BOOLEAN) TO neiist_app_user;

-- The team reader, widened to collaborators.
--
-- Replaces #129's version, which matched `owner_department_name` only. Still takes a department
-- and still filters on it, so the structural invariant holds: no row-returning function reads
-- `internal_events` without either a department parameter or a visibility filter.
DROP FUNCTION IF EXISTS neiist.get_team_internal_events(VARCHAR(30));

CREATE OR REPLACE FUNCTION neiist.get_team_internal_events(e_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  kind             TEXT,
  name             TEXT,
  description      TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  is_public        BOOLEAN,
  visibility       TEXT,
  is_owner         BOOLEAN,
  created_by_istid VARCHAR(50),
  created_by_name  VARCHAR(100),
  locations        TEXT[],
  attendee_count   INT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.description, e.starts_at, e.ends_at, e.is_public,
         e.visibility::TEXT,
         -- So the UI can show a collaborator that this is not their event to delete.
         (e.owner_department_name = e_department),
         e.created_by_istid, u.name,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[]),
         count(DISTINCT a.user_istid)::INT
  FROM neiist.internal_events e
  JOIN neiist.users u ON u.istid = e.created_by_istid
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  LEFT JOIN neiist.event_attendees a ON a.event_id = e.id
  WHERE e.owner_department_name = e_department
     -- Collaborators see it too, EXCEPT when the owner has narrowed it to themselves.
     OR (e.visibility <> 'owner' AND EXISTS (
          SELECT 1 FROM neiist.event_collaborating_teams c
          WHERE c.event_id = e.id AND c.department_name = e_department))
  GROUP BY e.id, u.name
  ORDER BY e.starts_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_internal_events(VARCHAR(30)) TO neiist_app_user;

-- The member view, widened the same way, plus the new `members` visibility level.
--
-- A member now sees: their own teams' events (owner or collaborator), AND anything marked
-- `members` or `public` regardless of team — which is what that level is for.
DROP FUNCTION IF EXISTS neiist.get_member_internal_events(VARCHAR(50));

CREATE OR REPLACE FUNCTION neiist.get_member_internal_events(u_istid VARCHAR(50))
RETURNS TABLE (
  id              INT,
  kind            TEXT,
  name            TEXT,
  department_name VARCHAR(30),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  is_public       BOOLEAN,
  visibility      TEXT,
  locations       TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.owner_department_name, e.starts_at, e.ends_at, e.is_public,
         e.visibility::TEXT,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE (
      -- Their own teams, as owner or collaborator.
      e.owner_department_name IN (
        SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s
      )
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams c
            WHERE c.event_id = e.id
              AND c.department_name IN (
                SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s)))
      -- Or anything the núcleo as a whole is meant to see. This is the level that did not exist.
      OR e.visibility IN ('members', 'public')
    )
    -- Still a member, and still upcoming. A caller with no scopes gets only nothing: the guard
    -- is that `members` events are for members, and someone with zero scopes is not one.
    AND EXISTS (SELECT 1 FROM neiist.get_user_team_scopes(u_istid) s2)
    AND e.starts_at >= NOW() - INTERVAL '1 day'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_member_internal_events(VARCHAR(50)) TO neiist_app_user;

-- The public reader, unchanged in behaviour but stated in the new vocabulary.
--
-- Still the ONLY function allowed to read `internal_events` without a department, and it still
-- earns that by filtering — `visibility = 'public'` where it used to say `is_public`. The
-- `pg_proc` allow-list test is updated to match.
DROP FUNCTION IF EXISTS neiist.get_public_internal_events();

CREATE OR REPLACE FUNCTION neiist.get_public_internal_events()
RETURNS TABLE (
  id          INT,
  name        TEXT,
  description TEXT,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  locations   TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.name, e.description, e.starts_at, e.ends_at, e.updated_at,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE e.visibility = 'public'
    AND e.kind = 'event'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_public_internal_events() TO neiist_app_user;
