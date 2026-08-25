-- 015: the public event reader also returns `updated_at` (#129, slice D).
--
-- Google Calendar sync decides whether an existing entry needs rewriting by comparing a stored
-- timestamp (`extendedProperties.private.notionLastEdited`). Without a change timestamp on the
-- workspace side, editing an event in the workspace would leave the calendar entry stale forever:
-- the sync would see an id it already has and skip it.
--
-- `CREATE OR REPLACE` cannot change a function's return type, so this drops first. Safe: the only
-- callers are `getPublicInternalEvents` and `/activities`, both of which ship in the same release,
-- and a `DROP ... IF EXISTS` followed by `CREATE` inside one migration transaction is never
-- observable as "missing" by anything else.
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
  -- Unchanged, and still the entire authorization for this function: it takes no department, so
  -- `is_public` is what stands between an internal meeting and the front page. `kind = 'event'`
  -- keeps coordination meetings off the students' calendar even if someone ticks the box.
  WHERE e.is_public
    AND e.kind = 'event'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_public_internal_events() TO neiist_app_user;

-- `updated_at` was only ever set by `update_event_notes`. An event whose name, date or locations
-- change would not have moved it, so the calendar would keep the old entry.
CREATE OR REPLACE FUNCTION neiist.touch_internal_event() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_internal_events_touch ON neiist.internal_events;
CREATE TRIGGER trg_internal_events_touch
  BEFORE UPDATE ON neiist.internal_events
  FOR EACH ROW EXECUTE FUNCTION neiist.touch_internal_event();
