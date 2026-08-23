-- 012: internal events and meetings (#129, slice A of Phase 1).
--
-- The first piece of NEIIST's Notion operations to actually move. `/workspace/[team]` has been
-- rendering a placeholder saying "as páginas do Notion serão migradas para aqui"; this is what
-- fills it.
--
-- Numbered 012, not 011: 011 is claimed by open PR #195 (the admin-grant guard). Likewise the
-- SQLSTATEs here are NEI14/NEI15 — NEI01-NEI12 are on main and NEI13 belongs to #195.
--
-- Deliberately NOT in this migration: anything touching `neiist.activities`, the Notion sync, or
-- Google Calendar. `is_public` exists and is enforced, but nothing reads it publicly yet — that
-- is slice C, and keeping it out means this cannot break the public calendar.

-- The event itself.
--
-- `owner_department_name`, not the `owner_team_id` the issue sketched: this repo has no
-- `teams.id`, teams are keyed by name, and `canForTeam` compares `departments.name` **exactly**.
-- Storing that same string is what lets the existing guard authorize these rows with no
-- translation step — and a translation step between the value authorized and the value written
-- is exactly how a check and its effect come apart (#180).
--
-- It references `departments`, not `teams`, so Direção and the Mesa da Assembleia Geral can own
-- meetings too. That is safe rather than a loophole: #184 forbids grants on non-team departments,
-- so no borrowed scope can ever reach an admin body's meetings.
CREATE TABLE IF NOT EXISTS neiist.internal_events (
  id                    SERIAL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('event', 'meeting')),
  name                  TEXT NOT NULL CHECK (btrim(name) <> ''),
  description           TEXT,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ,
  -- Default FALSE, always. A row that reaches the public calendar by forgetting a field is the
  -- failure this whole column exists to prevent.
  is_public             BOOLEAN NOT NULL DEFAULT FALSE,
  owner_department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  created_by_istid      VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT internal_events_ends_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

-- The team page lists a team's events by date; that is the only read shape slice A has.
CREATE INDEX IF NOT EXISTS idx_internal_events_by_team
  ON neiist.internal_events (owner_department_name, starts_at DESC);

-- Partial, for the public calendar slice C will add. Cheap now, and it documents the intent.
CREATE INDEX IF NOT EXISTS idx_internal_events_public
  ON neiist.internal_events (starts_at) WHERE is_public;

-- Every Notion multi-select becomes a join table. No comma-joined strings.
CREATE TABLE IF NOT EXISTS neiist.event_locations (
  event_id INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  location TEXT NOT NULL CHECK (btrim(location) <> ''),
  PRIMARY KEY (event_id, location)
);

-- Attendees resolve to real users, not free text — an acceptance criterion of #129, and what
-- makes "who was at that meeting" answerable later.
CREATE TABLE IF NOT EXISTS neiist.event_attendees (
  event_id   INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  response   TEXT NOT NULL DEFAULT 'invited'
             CHECK (response IN ('invited', 'accepted', 'declined', 'attended')),
  PRIMARY KEY (event_id, user_istid)
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_user
  ON neiist.event_attendees (user_istid);

-- Create an event with its locations and attendees, atomically.
--
-- One plpgsql function rather than `withTransaction` from the route: a single call is already one
-- implicit transaction, and it keeps the write indivisible for every caller, not only the one
-- that remembers to wrap it. #129 requires this — a half-written event with no locations is not a
-- state anything should be able to observe.
--
-- Authorization is NOT here. Unlike the grant functions (#184), which decide who may create new
-- authority, this decides nothing about permissions: `canForTeam` in the route and page owns that,
-- because the question is "may this caller act for this team", which the existing guard already
-- answers correctly and which duplicating would let drift.
CREATE OR REPLACE FUNCTION neiist.create_internal_event(
  e_kind        TEXT,
  e_name        TEXT,
  e_description TEXT,
  e_starts_at   TIMESTAMPTZ,
  e_ends_at     TIMESTAMPTZ,
  e_is_public   BOOLEAN,
  e_department  VARCHAR(30),
  e_created_by  VARCHAR(50),
  e_locations   TEXT[] DEFAULT ARRAY[]::TEXT[],
  e_attendees   VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[]
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF e_kind NOT IN ('event', 'meeting') THEN
    RAISE EXCEPTION 'Tipo inválido: use "event" ou "meeting".' USING ERRCODE = 'NEI14';
  END IF;
  IF e_name IS NULL OR btrim(e_name) = '' THEN
    RAISE EXCEPTION 'O nome é obrigatório.' USING ERRCODE = 'NEI14';
  END IF;
  IF e_starts_at IS NULL THEN
    RAISE EXCEPTION 'A data de início é obrigatória.' USING ERRCODE = 'NEI14';
  END IF;
  IF e_ends_at IS NOT NULL AND e_ends_at < e_starts_at THEN
    RAISE EXCEPTION 'A data de fim não pode ser anterior à de início.' USING ERRCODE = 'NEI14';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM neiist.departments WHERE name = e_department AND active
  ) THEN
    RAISE EXCEPTION 'A equipa "%" não existe ou está inativa.', e_department
      USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.internal_events
    (kind, name, description, starts_at, ends_at, is_public, owner_department_name,
     created_by_istid)
  VALUES
    (e_kind, btrim(e_name), NULLIF(btrim(coalesce(e_description, '')), ''), e_starts_at, e_ends_at,
     coalesce(e_is_public, FALSE), e_department, e_created_by)
  RETURNING id INTO v_id;

  INSERT INTO neiist.event_locations (event_id, location)
  SELECT v_id, btrim(loc)
  FROM unnest(coalesce(e_locations, ARRAY[]::TEXT[])) AS loc
  WHERE btrim(loc) <> ''
  ON CONFLICT DO NOTHING;

  -- Only real users. A bad istid is dropped rather than raising, because the alternative is a
  -- whole event refused over one mistyped attendee; the roster picker supplies these, so a miss
  -- means the person left the núcleo between page load and submit.
  INSERT INTO neiist.event_attendees (event_id, user_istid)
  SELECT v_id, u.istid
  FROM unnest(coalesce(e_attendees, ARRAY[]::VARCHAR(50)[])) AS a(istid)
  JOIN neiist.users u ON u.istid = a.istid
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_internal_event(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, VARCHAR(30), VARCHAR(50), TEXT[],
  VARCHAR(50)[]
) TO neiist_app_user;

-- One team's events. **Takes a department and filters on it** — that is the structural half of
-- the `is_public` boundary: there is no "all events" reader in slice A at all, so a caller cannot
-- accidentally receive another team's internal meetings by omitting a filter.
CREATE OR REPLACE FUNCTION neiist.get_team_internal_events(e_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  kind             TEXT,
  name             TEXT,
  description      TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  is_public        BOOLEAN,
  created_by_istid VARCHAR(50),
  created_by_name  VARCHAR(100),
  locations        TEXT[],
  attendee_count   INT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.description, e.starts_at, e.ends_at, e.is_public,
         e.created_by_istid, u.name,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[]),
         count(DISTINCT a.user_istid)::INT
  FROM neiist.internal_events e
  JOIN neiist.users u ON u.istid = e.created_by_istid
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  LEFT JOIN neiist.event_attendees a ON a.event_id = e.id
  WHERE e.owner_department_name = e_department
  GROUP BY e.id, u.name
  ORDER BY e.starts_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_internal_events(VARCHAR(30)) TO neiist_app_user;

-- Delete. Returns the owning department so the caller can authorize against the row's real owner
-- rather than one supplied in the request — the IDOR shape.
CREATE OR REPLACE FUNCTION neiist.get_internal_event_owner(e_id INT)
RETURNS VARCHAR(30) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT owner_department_name FROM neiist.internal_events WHERE id = e_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_internal_event_owner(INT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.delete_internal_event(e_id INT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.internal_events WHERE id = e_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.delete_internal_event(INT) TO neiist_app_user;
