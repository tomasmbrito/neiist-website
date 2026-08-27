-- 030 — The board can see every team's calendar (#241).
--
-- Tomás:
--   "to the admin/board members it should be the same but we should have a checkbox or filter that
--    allows us to see every event (from the other teams too), so for example if i want to see when
--    the Visuais team are having events we should be able to do it"
--
-- `get_member_internal_events` is scoped to the caller's own teams plus anything marked `members`
-- or `public`. That is right for a member and wrong for the Direção, whose job is precisely to see
-- across teams — which is why they are the only ones this opens up for.
--
-- ## This is the second unscoped reader of internal_events, and that is a security decision
--
-- `get_public_internal_events` earns its lack of a department parameter by filtering
-- `WHERE visibility = 'public'`. This one does not filter at all: it returns every internal event
-- in the database, including a team's `owner`-only meetings.
--
-- It is therefore NOT safe by construction, and the guard is at the call site: `/activities` only
-- calls it when `is_board_signatory` says so. That is a weaker guarantee than the rest of #126 and
-- it is deliberate — the alternative is passing the caller's istid and re-deriving "is this person
-- the board" inside a function that would then have to be trusted to get it right a second time.
-- One rule, one place (#185), with the enforcement where the session actually is.
--
-- **If a second call site ever appears, it must repeat that check.** The pg_proc allow-list test
-- names this function explicitly so it cannot be added quietly.
CREATE OR REPLACE FUNCTION neiist.get_all_internal_events()
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
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_all_internal_events() TO neiist_app_user;
