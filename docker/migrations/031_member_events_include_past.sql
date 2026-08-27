-- 031 — A member's team events, including past ones, for the calendar (#241).
--
-- `get_member_internal_events` filters `starts_at >= NOW() - INTERVAL '1 day'`. That was correct
-- for what it was built for: the "próximos eventos" panel under the calendar, which is a list of
-- what is coming.
--
-- It is wrong for a CALENDAR. A calendar is navigated backwards — you go to November to see what
-- happened in November — and against NEIIST's real data the effect was total: every imported event
-- is from the 2025/26 academic year, so a member's own team meetings simply never appeared.
--
-- The `who` rule is untouched. Only the `when` becomes a parameter, defaulted to the old behaviour
-- so the existing call site keeps working without knowing this happened.
--
-- Dropped first because adding a defaulted parameter to an existing function creates an OVERLOAD
-- rather than replacing it, and two functions differing only in arity is how a caller ends up
-- silently on the wrong one.
DROP FUNCTION IF EXISTS neiist.get_member_internal_events(VARCHAR(50));

CREATE OR REPLACE FUNCTION neiist.get_member_internal_events(
  u_istid       VARCHAR(50),
  u_include_past BOOLEAN DEFAULT FALSE
)
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
      -- Or anything the núcleo as a whole is meant to see.
      OR e.visibility IN ('members', 'public')
    )
    -- Unchanged, and the important half: a caller with no scopes gets nothing. `members` events
    -- are for members, and someone with zero scopes is not one.
    AND EXISTS (SELECT 1 FROM neiist.get_user_team_scopes(u_istid) s2)
    AND (u_include_past OR e.starts_at >= NOW() - INTERVAL '1 day')
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_member_internal_events(VARCHAR(50), BOOLEAN)
  TO neiist_app_user;
