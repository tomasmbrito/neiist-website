-- 016: two findings from the whole-feature security review (#208).
--
-- 1. Attendance was a user-existence and full-name oracle over the entire users table.
-- 2. A temporary grant could permanently destroy a team's minutes archive.

-- Attendance: the invitee must be a NEIIST member.
--
-- Before, `set_event_attendance` accepted **any istid that exists**, so a coordinator — or a
-- temporary grantee, since `team.events.manage` is grantable — could POST candidate istids
-- against their own event and read the answer off the status code: 200 means that account is
-- real, 400 "O membro não existe" means it is not. Then GET returns `attendees[].userName`, the
-- person's real name from `neiist.users`. Iterate the istid space, harvest the student directory.
-- The roster picker in the UI was team-scoped; the API was not.
--
-- Restricted to current NEIIST members rather than to the event's own team on purpose: inviting
-- someone from another team to a meeting is a real and normal thing to do (a Dev-Team member at a
-- Divulgação planning meeting), and the requirement never said otherwise. What it must not be is
-- a lookup across every account the site has ever created — the shop's customers included.
--
-- The oracle is narrowed rather than closed: it still distinguishes "is a member" from "is not".
-- Closing it entirely would mean accepting an invitation for a non-existent person and reporting
-- success, which trades a small leak for a silently broken feature. Membership is public
-- knowledge inside the núcleo — /about-us lists it — so this is the honest boundary.
CREATE OR REPLACE FUNCTION neiist.set_event_attendance(
  e_id       INT,
  e_istid    VARCHAR(50),
  e_response TEXT
) RETURNS VOID AS $$
BEGIN
  IF e_response NOT IN ('invited', 'accepted', 'declined', 'attended') THEN
    RAISE EXCEPTION 'Resposta inválida.' USING ERRCODE = 'NEI14';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM neiist.internal_events WHERE id = e_id) THEN
    RAISE EXCEPTION 'O evento não existe.' USING ERRCODE = 'NEI15';
  END IF;

  -- Members only, and the same liveness rule `get_user_team_scopes` uses.
  IF NOT EXISTS (
    SELECT 1
    FROM neiist.membership m
    WHERE m.user_istid = e_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Só é possível convidar membros do NEIIST.' USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.event_attendees (event_id, user_istid, response)
  VALUES (e_id, e_istid, e_response)
  ON CONFLICT (event_id, user_istid) DO UPDATE SET response = EXCLUDED.response;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_event_attendance(INT, VARCHAR(50), TEXT) TO neiist_app_user;
