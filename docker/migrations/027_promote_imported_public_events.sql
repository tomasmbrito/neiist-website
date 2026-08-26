-- 027 — Hand the public calendar over from the Notion sync to the workspace (#137, first slice).
--
-- #210 imports the 16 public Notion events as `members` rather than `public`, on purpose: the old
-- Notion -> `neiist.activities` sync still publishes those same pages, so importing them as
-- `public` would show every one of them TWICE on the students' calendar.
--
-- This is the handover. For each imported event whose Notion page is also an `activities` row:
-- promote the event to `public` and delete the activities row, **in one transaction**, so the
-- calendar goes from "shown once, by the sync" to "shown once, by the workspace" with no window
-- in which it is shown twice or not at all.
--
-- ## What this is NOT
--
-- It is not all of #137. Retiring Notion as an operational system needs Phases 2-9 — requerimentos
-- (#131), forms (#132), finance (#133), venue scouting (#135), sweats (#136), sponsorship (#138) —
-- none of which have started. Removing the Notion webhook or archiving the databases now would
-- strand every one of those modules. This slice takes only the part Phase 1 actually replaced.
--
-- ## Why it is a function and not part of the importer
--
-- Because it is a separate decision. The import is safe to run and re-run while the sync keeps
-- publishing; this changes what students see. It should be run deliberately, after somebody has
-- looked at the imported events in the workspace and agreed they are right.

-- Report first: what WOULD be promoted, and what would be left behind.
--
-- The second half matters more than the first. An `activities` row with no imported event is a
-- public event that exists ONLY in the old sync — promoting the others and later switching the
-- sync off would silently drop it from the calendar. Nobody would notice until a student did.
CREATE OR REPLACE FUNCTION neiist.public_calendar_handover_report()
RETURNS TABLE (
  status         TEXT,
  notion_page_id TEXT,
  title          TEXT,
  starts_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Imported, currently members-only, and the sync is still publishing it: ready to hand over.
  SELECT 'ready'::TEXT, e.notion_page_id, e.name, e.starts_at
  FROM neiist.internal_events e
  JOIN neiist.activities a ON a.id = e.notion_page_id
  WHERE e.notion_page_id IS NOT NULL
    AND e.visibility = 'members'
  UNION ALL
  -- Published by the sync with no imported counterpart. Handing over without importing these
  -- first would remove them from the students' calendar.
  SELECT 'orphan_activity'::TEXT, a.id, a.title, a.start
  FROM neiist.activities a
  WHERE NOT EXISTS (
    SELECT 1 FROM neiist.internal_events e WHERE e.notion_page_id = a.id
  )
  ORDER BY 1, 4;
$$;

GRANT EXECUTE ON FUNCTION neiist.public_calendar_handover_report() TO neiist_app_user;

-- Do the handover.
--
-- **Refuses while any orphan exists**, unless explicitly forced. That guard is the whole safety
-- property: an orphan means the import did not cover everything the sync publishes, and finishing
-- the handover in that state removes a real event from the students' calendar. Failing loudly is
-- the only outcome somebody notices.
--
-- Each promotion and its matching deletion happen together — this function runs in a single
-- implicit transaction, so there is no moment where an event is neither published by the sync nor
-- public in the workspace.
CREATE OR REPLACE FUNCTION neiist.hand_over_public_calendar(h_force BOOLEAN DEFAULT FALSE)
RETURNS INT AS $$
DECLARE
  v_orphans  INT;
  v_promoted INT;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM neiist.public_calendar_handover_report()
  WHERE status = 'orphan_activity';

  IF v_orphans > 0 AND NOT h_force THEN
    RAISE EXCEPTION
      'Há % atividades publicadas pela sync do Notion sem evento importado. Corre o import '
      'primeiro, ou chama esta função com force := TRUE se souberes que podem desaparecer '
      'do calendário.', v_orphans
      USING ERRCODE = 'NEI15';
  END IF;

  WITH promoted AS (
    UPDATE neiist.internal_events e
    SET visibility = 'public'
    FROM neiist.activities a
    WHERE a.id = e.notion_page_id
      AND e.notion_page_id IS NOT NULL
      AND e.visibility = 'members'
    RETURNING e.notion_page_id
  ),
  removed AS (
    DELETE FROM neiist.activities
    WHERE id IN (SELECT notion_page_id FROM promoted)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted FROM removed;

  RETURN v_promoted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.hand_over_public_calendar(BOOLEAN) TO neiist_app_user;
