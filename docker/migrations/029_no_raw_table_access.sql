-- 029 — Four queries that read tables directly, which the app role may not do.
--
-- `/workspace` returned 500 with `permission denied for table membership`. The app connects as
-- `neiist_app_user`, and `docker/schema.sql:11-16` deliberately gives that role NO table
-- privileges: every read and write goes through a `SECURITY DEFINER` function, so the rule about
-- who may see what lives in one place instead of being re-derived at each call site.
--
-- Four functions I added over this migration series broke that rule by inlining SQL against a
-- table. They all work in tests — the test suite connects as the OWNER — and all fail in the
-- running app. That gap is why this went unnoticed:
--
--   isBoardSignatory        -> neiist.membership            (blocked /workspace entirely)
--   getOpenEdition          -> neiist.recruitment_editions  (would blank the application form)
--   setEventVisibility      -> UPDATE neiist.internal_events (would 500 the visibility dropdown)
--   bookInterview           -> neiist.interview_slots       (would 500 every booking)
--
-- Only the first was reachable from a page anyone had opened yet.

-- May this person give the board signature? Reads `board_member`, exactly as
-- `application_approval_sides` does — the same rule, in one place (#217).
CREATE OR REPLACE FUNCTION neiist.is_board_signatory(b_istid VARCHAR(50))
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = b_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.board_member
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.is_board_signatory(VARCHAR(50)) TO neiist_app_user;

-- The open recruitment round, if there is one. Drives whether /candidatura shows a form or an
-- explanation, so it is called on a PUBLIC page — the one place a permission error is most
-- visible and least explicable to the person hitting it.
CREATE OR REPLACE FUNCTION neiist.get_open_recruitment_edition()
RETURNS TABLE (id INT, name TEXT, closes_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.name, e.closes_at
  FROM neiist.recruitment_editions e
  WHERE NOW() BETWEEN e.opens_at AND e.closes_at
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_open_recruitment_edition() TO neiist_app_user;

-- Change an event's visibility. The trigger from 020 keeps `is_public` in step, so this stays a
-- plain UPDATE — but it has to be a function, because the app role cannot write the table.
CREATE OR REPLACE FUNCTION neiist.set_event_visibility(
  v_event      INT,
  v_visibility neiist.event_visibility_enum
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.internal_events SET visibility = v_visibility WHERE id = v_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O evento não existe.' USING ERRCODE = 'NEI15';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_event_visibility(INT, neiist.event_visibility_enum)
  TO neiist_app_user;

-- The times and coordinator of one slot, for building the interview event (#218).
CREATE OR REPLACE FUNCTION neiist.get_interview_slot_times(s_slot INT)
RETURNS TABLE (starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, coordinator VARCHAR(50))
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.starts_at, s.ends_at, s.coordinator_istid
  FROM neiist.interview_slots s WHERE s.id = s_slot;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_interview_slot_times(INT) TO neiist_app_user;
