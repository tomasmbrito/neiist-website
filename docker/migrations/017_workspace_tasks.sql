-- 017: tasks (#130, Phase 2 slice A).
--
-- Ports Notion's Tasks data source. The Notion shape is `Task · Assigned To (person) ·
-- Team (multi) · Due Date · Event (relation, max 1) · Status`.
--
-- Two departures from that shape, both deliberate:
--
--   * **`Team` is single, not multi.** Notion allows several, but a task owned by two teams has
--     no answer to "who is accountable", and every authorization question here — may I see it,
--     may I edit it — needs exactly one department to compare against `canForTeam`. A task that
--     genuinely spans teams is two tasks, or one task and a relation. Same reasoning as
--     `internal_events.owner_department_name` (#129).
--   * **Assignees are many.** That one IS genuinely plural in practice: "Ana and Rui do the
--     posters" is one task with two people, and splitting it loses that they are collaborating.
CREATE TABLE IF NOT EXISTS neiist.tasks (
  id                    SERIAL PRIMARY KEY,
  title                 TEXT NOT NULL CHECK (btrim(title) <> ''),
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'not_started'
                        CHECK (status IN ('not_started', 'in_progress', 'done')),
  due_at                TIMESTAMPTZ,
  -- The owning team, and the thing every guard compares. Same column type and FK target as
  -- internal_events, so `canForTeam` needs no translation step.
  owner_department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  -- Optional link to the event this task is for. Notion caps this at one; so does the column.
  event_id              INT REFERENCES neiist.internal_events(id) ON DELETE SET NULL,
  created_by_istid      VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when status first becomes 'done', so "when was this finished" is answerable without an
  -- audit log. #130 asks for status transitions to be recorded; this is the cheap half that is
  -- useful immediately, and #160 is where a full history belongs.
  completed_at          TIMESTAMPTZ,

  CONSTRAINT tasks_completed_matches_status CHECK (
    (status = 'done' AND completed_at IS NOT NULL) OR (status <> 'done' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tasks_by_team ON neiist.tasks (owner_department_name, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_by_event ON neiist.tasks (event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS neiist.task_assignees (
  task_id    INT NOT NULL REFERENCES neiist.tasks(id) ON DELETE CASCADE,
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_istid)
);

-- The member dashboard's hot path: "my tasks", across every team.
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON neiist.task_assignees (user_istid);

-- `updated_at` and `completed_at` maintained centrally. #129 slice D learned this the hard way:
-- `updated_at` was set by exactly one function there, so every other write left it stale.
CREATE OR REPLACE FUNCTION neiist.touch_task() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  -- Derived, never passed in: a caller cannot claim a completion time, and cannot forget to.
  IF NEW.status = 'done' AND coalesce(OLD.status, '') <> 'done' THEN
    NEW.completed_at := NOW();
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_touch ON neiist.tasks;
CREATE TRIGGER trg_tasks_touch
  BEFORE INSERT OR UPDATE ON neiist.tasks
  FOR EACH ROW EXECUTE FUNCTION neiist.touch_task();

-- Create a task with its assignees, atomically. Same pattern as create_internal_event: one
-- plpgsql call is one implicit transaction, so it is indivisible for every caller rather than
-- the one that remembers to wrap it.
CREATE OR REPLACE FUNCTION neiist.create_task(
  t_title       TEXT,
  t_description TEXT,
  t_status      TEXT,
  t_due_at      TIMESTAMPTZ,
  t_department  VARCHAR(30),
  t_event_id    INT,
  t_created_by  VARCHAR(50),
  t_assignees   VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[]
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF t_title IS NULL OR btrim(t_title) = '' THEN
    RAISE EXCEPTION 'O título é obrigatório.' USING ERRCODE = 'NEI16';
  END IF;
  IF t_status NOT IN ('not_started', 'in_progress', 'done') THEN
    RAISE EXCEPTION 'Estado inválido.' USING ERRCODE = 'NEI16';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = t_department AND active) THEN
    RAISE EXCEPTION 'A equipa "%" não existe ou está inativa.', t_department USING ERRCODE = 'NEI17';
  END IF;

  -- A task may only hang off an event of the SAME team. Otherwise one team's board would name
  -- another team's internal meeting, which is the boundary #129 spent three slices holding.
  IF t_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM neiist.internal_events
    WHERE id = t_event_id AND owner_department_name = t_department
  ) THEN
    RAISE EXCEPTION 'O evento não pertence a esta equipa.' USING ERRCODE = 'NEI17';
  END IF;

  INSERT INTO neiist.tasks
    (title, description, status, due_at, owner_department_name, event_id, created_by_istid)
  VALUES
    (btrim(t_title), NULLIF(btrim(coalesce(t_description, '')), ''), t_status, t_due_at,
     t_department, t_event_id, t_created_by)
  RETURNING id INTO v_id;

  -- Members only, and the same reasoning as event attendance (#208): accepting any istid that
  -- exists would make this a directory oracle over every account the site has.
  INSERT INTO neiist.task_assignees (task_id, user_istid)
  SELECT v_id, a.istid
  FROM unnest(coalesce(t_assignees, ARRAY[]::VARCHAR(50)[])) AS a(istid)
  WHERE EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = a.istid AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  )
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_task(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, VARCHAR(30), INT, VARCHAR(50), VARCHAR(50)[]
) TO neiist_app_user;

-- One team's tasks. Takes a department and filters on it — the same structural rule as
-- internal_events: there is no "all tasks" reader, so no caller can receive another team's by
-- omitting a filter.
CREATE OR REPLACE FUNCTION neiist.get_team_tasks(t_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  title            TEXT,
  description      TEXT,
  status           TEXT,
  due_at           TIMESTAMPTZ,
  event_id         INT,
  event_name       TEXT,
  created_by_istid VARCHAR(50),
  completed_at     TIMESTAMPTZ,
  assignees        JSONB
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.id, t.title, t.description, t.status, t.due_at, t.event_id, e.name,
         t.created_by_istid, t.completed_at,
         coalesce(
           jsonb_agg(jsonb_build_object('istid', u.istid, 'name', u.name))
             FILTER (WHERE u.istid IS NOT NULL),
           '[]'::jsonb)
  FROM neiist.tasks t
  LEFT JOIN neiist.internal_events e ON e.id = t.event_id
  LEFT JOIN neiist.task_assignees a ON a.task_id = t.id
  LEFT JOIN neiist.users u ON u.istid = a.user_istid
  WHERE t.owner_department_name = t_department
  GROUP BY t.id, e.name
  -- Open tasks first, then by due date with undated last: a board is for what is outstanding.
  ORDER BY (t.status = 'done'), t.due_at NULLS LAST, t.id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_tasks(VARCHAR(30)) TO neiist_app_user;

-- "My tasks", across every team this person belongs to — the member dashboard's core query.
--
-- Scoped through get_user_team_scopes, so a task in a team they have left, or one reached only
-- through an expired grant, drops off automatically. Being ASSIGNED is not sufficient on its own:
-- an ex-member must not keep reading a team's tasks because someone once assigned them one.
CREATE OR REPLACE FUNCTION neiist.get_user_tasks(u_istid VARCHAR(50))
RETURNS TABLE (
  id               INT,
  title            TEXT,
  status           TEXT,
  due_at           TIMESTAMPTZ,
  department_name  VARCHAR(30),
  event_id         INT,
  event_name       TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.id, t.title, t.status, t.due_at, t.owner_department_name, t.event_id, e.name
  FROM neiist.tasks t
  JOIN neiist.task_assignees a ON a.task_id = t.id AND a.user_istid = u_istid
  LEFT JOIN neiist.internal_events e ON e.id = t.event_id
  WHERE t.owner_department_name IN (
    SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s
  )
  ORDER BY (t.status = 'done'), t.due_at NULLS LAST, t.id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_user_tasks(VARCHAR(50)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_task_owner(t_id INT)
RETURNS VARCHAR(30) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT owner_department_name FROM neiist.tasks WHERE id = t_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_task_owner(INT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.set_task_status(t_id INT, t_status TEXT)
RETURNS VOID AS $$
BEGIN
  IF t_status NOT IN ('not_started', 'in_progress', 'done') THEN
    RAISE EXCEPTION 'Estado inválido.' USING ERRCODE = 'NEI16';
  END IF;
  UPDATE neiist.tasks SET status = t_status WHERE id = t_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A tarefa não existe.' USING ERRCODE = 'NEI17';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_task_status(INT, TEXT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.set_task_assignee(t_id INT, t_istid VARCHAR(50), t_assign BOOLEAN)
RETURNS VOID AS $$
BEGIN
  IF t_assign THEN
    IF NOT EXISTS (
      SELECT 1 FROM neiist.membership m
      WHERE m.user_istid = t_istid AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    ) THEN
      RAISE EXCEPTION 'Só é possível atribuir tarefas a membros do NEIIST.' USING ERRCODE = 'NEI17';
    END IF;
    INSERT INTO neiist.task_assignees (task_id, user_istid)
    VALUES (t_id, t_istid) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM neiist.task_assignees WHERE task_id = t_id AND user_istid = t_istid;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_task_assignee(INT, VARCHAR(50), BOOLEAN) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.delete_task(t_id INT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.tasks WHERE id = t_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.delete_task(INT) TO neiist_app_user;

-- Close the attendee oracle on the CREATE path too (#208 fixed only the update path).
--
-- `set_event_attendance` was tightened in 016 to require a live membership, because accepting any
-- existing istid made the endpoint a directory lookup: 200 means the account is real, and GET
-- then returns the person's name. `create_internal_event` was left joining `neiist.users`, so the
-- same harvest worked by creating a meeting with 200 candidate istids in one request.
--
-- One rule, two write paths, one fixed. The shape this repo keeps relearning — #97, #117, #180,
-- and #202 twice.
--
-- Filtered rather than raised, matching the existing behaviour here: an unknown attendee is
-- dropped and the event still saves, because the alternative is losing an event over one stale
-- roster entry.
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
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = e_department AND active) THEN
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

  -- MEMBERS, not merely users. This is the line that closes the oracle.
  INSERT INTO neiist.event_attendees (event_id, user_istid)
  SELECT v_id, a.istid
  FROM unnest(coalesce(e_attendees, ARRAY[]::VARCHAR(50)[])) AS a(istid)
  WHERE EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = a.istid AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  )
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_internal_event(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, VARCHAR(30), VARCHAR(50), TEXT[],
  VARCHAR(50)[]
) TO neiist_app_user;
