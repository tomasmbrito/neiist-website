-- 025 — Importing the Notion events, idempotently (#210, #126 Phase 1).
--
-- Phase 1 built the tables and the UI (#129, all four slices). Nothing was ever imported into
-- them: the workspace is live and empty. This is the piece that fills it.
--
-- The single most important property is **idempotence**, and it has three separate jobs:
--
--   1. Re-running the importer must not duplicate 52 events into 104.
--   2. A run that dies half way must be resumable by simply running it again.
--   3. Phase 10 (#137) has to be able to tell an imported row from one created in the workspace,
--      in order to retire the Notion sync without deleting things people made here.
--
-- One column does all three: `notion_page_id`, unique, NULL for anything born in the website.

ALTER TABLE neiist.internal_events
  ADD COLUMN IF NOT EXISTS notion_page_id TEXT;

-- Partial, so the many native rows with NULL do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_events_notion_page
  ON neiist.internal_events (notion_page_id)
  WHERE notion_page_id IS NOT NULL;

COMMENT ON COLUMN neiist.internal_events.notion_page_id IS
  'The Notion page this row was imported from (#210). NULL means it was created in the website. '
  'Unique, so re-running the importer updates instead of duplicating. #137 uses it to tell '
  'imported rows from native ones when the Notion sync is retired.';

-- Import or update one event, atomically, with everything that hangs off it.
--
-- Modelled on `create_internal_event` (#129) rather than written fresh, because the same rule
-- applies: an event and its locations and attendees are one thing, and a partial event is worse
-- than none. The difference is the conflict target — this one is an upsert keyed on the Notion
-- page, so it is safe to run twice.
--
-- Attendees are matched by the CALLER (the importer resolves Notion people to istids and reports
-- the ones it cannot); this function takes istids and, following #129, silently drops any that do
-- not exist rather than losing the whole event over one stale roster entry.
CREATE OR REPLACE FUNCTION neiist.import_internal_event(
  i_notion_page   TEXT,
  i_kind          TEXT,
  i_name          TEXT,
  i_starts_at     TIMESTAMPTZ,
  i_ends_at       TIMESTAMPTZ,
  i_visibility    neiist.event_visibility_enum,
  i_department    VARCHAR(30),
  i_created_by    VARCHAR(50),
  i_locations     TEXT[] DEFAULT ARRAY[]::TEXT[],
  i_attendees     VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[],
  i_collaborators VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[]
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF i_kind NOT IN ('event', 'meeting') THEN
    RAISE EXCEPTION 'Tipo inválido: use "event" ou "meeting".' USING ERRCODE = 'NEI14';
  END IF;

  -- The owning team is a foreign key, and a Notion team name that does not match must fail LOUDLY
  -- rather than be dropped. Raised here, not just relied upon from the FK, so the message names
  -- the department instead of quoting a constraint.
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = i_department) THEN
    RAISE EXCEPTION 'O departamento "%" não existe.', i_department USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.internal_events
    (kind, name, starts_at, ends_at, visibility, owner_department_name, created_by_istid,
     notion_page_id)
  VALUES (i_kind, i_name, i_starts_at, i_ends_at, i_visibility, i_department, i_created_by,
          i_notion_page)
  ON CONFLICT (notion_page_id) WHERE notion_page_id IS NOT NULL DO UPDATE
  SET kind = EXCLUDED.kind,
      name = EXCLUDED.name,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      visibility = EXCLUDED.visibility,
      owner_department_name = EXCLUDED.owner_department_name
  RETURNING id INTO v_id;

  -- Locations and attendees are replaced, not merged: Notion is the source of truth for the rows
  -- it owns, and a merge would make a removal in Notion invisible here forever.
  DELETE FROM neiist.event_locations WHERE event_id = v_id;
  INSERT INTO neiist.event_locations (event_id, location)
  SELECT v_id, loc FROM unnest(i_locations) AS loc WHERE btrim(loc) <> '';

  DELETE FROM neiist.event_attendees WHERE event_id = v_id;
  -- The unnest alias is deliberately NOT called `istid`: inside the EXISTS subquery that name
  -- would rebind to `users.istid`, making the condition `u.istid = u.istid` — always true, so
  -- every unknown attendee would reach the foreign key and blow up the whole import. Caught by
  -- test, not by reading.
  INSERT INTO neiist.event_attendees (event_id, user_istid)
  SELECT v_id, candidate FROM unnest(i_attendees) AS candidate
  WHERE EXISTS (SELECT 1 FROM neiist.users u WHERE u.istid = candidate)
  ON CONFLICT DO NOTHING;

  -- Collaborating teams (#219). The importer uses this for the one Notion value that names two
  -- groups at once — "Coordenação/Direção" — rather than silently picking one of them.
  DELETE FROM neiist.event_collaborating_teams WHERE event_id = v_id;
  INSERT INTO neiist.event_collaborating_teams (event_id, department_name)
  SELECT v_id, dept FROM unnest(i_collaborators) AS dept
  WHERE dept <> i_department
    AND EXISTS (SELECT 1 FROM neiist.departments d WHERE d.name = dept)
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.import_internal_event(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, neiist.event_visibility_enum,
  VARCHAR(30), VARCHAR(50), TEXT[], VARCHAR(50)[], VARCHAR(30)[]
) TO neiist_app_user;

-- Does this Notion page already reach /activities through the old sync?
--
-- `neiist.activities.id` IS the Notion page id, which makes this exact rather than a guess about
-- matching titles and dates. It matters because 16 of the 52 events are public: importing them
-- as `visibility = 'public'` while the Notion -> activities sync still runs would show every one
-- of them TWICE on the students' calendar. The importer uses this to import them members-only and
-- say so; #137 retires the sync and flips them.
CREATE OR REPLACE FUNCTION neiist.activity_exists(a_notion_page TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM neiist.activities WHERE id = a_notion_page);
$$;

GRANT EXECUTE ON FUNCTION neiist.activity_exists(TEXT) TO neiist_app_user;
