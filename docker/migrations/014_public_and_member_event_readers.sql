-- 014: the public calendar and the member view read internal events (#129, slice C).
--
-- This is the first time a **student-facing page** stops depending on Notion at request time.
--
-- Slice A established an invariant: no row-returning function may read `internal_events` without
-- either a department parameter or `WHERE is_public`, pinned by a `pg_proc` introspection test.
-- This migration adds the one function that satisfies the second half of that rule — deliberately,
-- once, with tests — and one member-scoped reader that satisfies the first.

-- The public calendar. **`WHERE is_public` is the entire authorization**: this function is callable
-- by anyone, so the column is what stands between an internal meeting and the front page.
--
-- Meetings are excluded on top of that, belt and braces. `kind = 'event'` is not a security
-- control — a public meeting would already be a deliberate act — but nothing in the núcleo's
-- workflow wants an internal coordination meeting on the students' calendar even if someone ticks
-- the box by mistake, and the mistake is one checkbox away.
CREATE OR REPLACE FUNCTION neiist.get_public_internal_events()
RETURNS TABLE (
  id          INT,
  name        TEXT,
  description TEXT,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  locations   TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.name, e.description, e.starts_at, e.ends_at,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE e.is_public
    AND e.kind = 'event'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_public_internal_events() TO neiist_app_user;

-- The member's own internal view on /activities.
--
-- Scoped to the teams this person actually belongs to — via `get_user_team_scopes`, so temporary
-- grants (#184) are honoured for free. This is **narrower than what it replaces**: the Notion view
-- (#127) showed every team's internal events to anyone holding `activities.viewInternal`, which
-- predates the team boundary #183 established. Tightening it is the point, not a side effect.
CREATE OR REPLACE FUNCTION neiist.get_member_internal_events(u_istid VARCHAR(50))
RETURNS TABLE (
  id              INT,
  kind            TEXT,
  name            TEXT,
  department_name VARCHAR(30),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  is_public       BOOLEAN,
  locations       TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.owner_department_name, e.starts_at, e.ends_at, e.is_public,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE e.owner_department_name IN (
    SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s
  )
    -- Upcoming only: this is a "what is coming up for my teams" panel, not an archive.
    AND e.starts_at >= NOW() - INTERVAL '1 day'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_member_internal_events(VARCHAR(50)) TO neiist_app_user;
