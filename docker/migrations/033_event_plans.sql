-- 033 — Plano de Atividades (#247), the document above the requerimentos.
--
-- Found by reading the Organização de Eventos Drive. Every event folder holds one, and it is what
-- the team writes FIRST — before any requerimento exists. The website modelled the event and the
-- requerimentos and had no concept of the thing that produces them.
--
-- From the real Linux Install Party plan:
--
--   Local / Data / Hora                  <- already the event's
--   Coordenador · Colaboradores Responsáveis
--   Objetivo(s)                          <- two paragraphs of prose
--   Estrutura                            <- the run of show
--   Comunicação Externa: Oradores Convidados · Outros (Empresa/Patrocínio)
--   Comunicação Interna: Equipa de Visuais · Divulgação · Fotografia · Membros NEIIST
--   # To Dos
--     Fazer a reserva de espaços do tagus   — Guilherme Carreira
--     Fazer o requerimento de visuais       — Guilherme Carreira
--
-- ## Two rules from the plan document, both structural rather than advisory
--
-- **Derive, never retype.** There is no `local`, `data` or `hora` column here. Those are the
-- event's, and a copy is a copy that goes stale — the class of bug where the poster says 16:00 and
-- the event says 17:00. "Comunicação Interna" is likewise not stored: it IS the set of
-- requerimentos raised on the event.
--
-- **A to-do that means "raise a requerimento" links to the one it produced.** That is the whole
-- point of `event_plan_todos.requirement_id`. Before: an open to-do assigned to a person. After: a
-- live requerimento with its own checklist. One thing in two states, rather than two lists of the
-- same intent — which is exactly what Notion and Drive do to each other today.

CREATE TABLE IF NOT EXISTS neiist.event_plans (
  event_id  INT PRIMARY KEY REFERENCES neiist.internal_events(id) ON DELETE CASCADE,

  objetivo  TEXT,
  estrutura TEXT,

  -- The person accountable for the event, distinct from whoever typed the plan.
  coordinator_istid VARCHAR(50) REFERENCES neiist.users(istid) ON DELETE SET NULL,

  created_by_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Colaboradores Responsáveis — the people running this event, not the whole team.
CREATE TABLE IF NOT EXISTS neiist.event_plan_collaborators (
  event_id   INT NOT NULL REFERENCES neiist.event_plans(event_id) ON DELETE CASCADE,
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_istid)
);

-- Comunicação Externa: oradores convidados, patrocínios, parceiros.
--
-- Free text rather than a relation to Contacto's company database (#138, not built). A speaker is
-- often a person nobody has a record for, and requiring one would stop the plan being written.
CREATE TABLE IF NOT EXISTS neiist.event_plan_externals (
  id       SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES neiist.event_plans(event_id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('orador', 'patrocinio', 'parceiro', 'outro')),
  name     TEXT NOT NULL,
  detail   TEXT,
  position INT NOT NULL DEFAULT 0,

  CONSTRAINT plan_external_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_event_plan_externals ON neiist.event_plan_externals (event_id);

-- The To Dos, each with a named owner — which is how the real plans are written.
CREATE TABLE IF NOT EXISTS neiist.event_plan_todos (
  id       SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES neiist.event_plans(event_id) ON DELETE CASCADE,
  task     TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,

  assignee_istid VARCHAR(50) REFERENCES neiist.users(istid) ON DELETE SET NULL,

  done    BOOLEAN NOT NULL DEFAULT FALSE,
  done_by VARCHAR(50) REFERENCES neiist.users(istid),
  done_at TIMESTAMPTZ,

  -- The join that stops the plan and the requerimentos being two lists of the same intent.
  -- NULL while the to-do is still just an intention; set once it has been raised.
  requirement_id INT REFERENCES neiist.requirements(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plan_todo_task_not_blank CHECK (btrim(task) <> ''),
  CONSTRAINT plan_todo_done_complete CHECK (
    (done = FALSE AND done_by IS NULL AND done_at IS NULL)
    OR (done = TRUE AND done_by IS NOT NULL AND done_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_event_plan_todos ON neiist.event_plan_todos (event_id, position, id);
-- One to-do per requerimento: a requerimento is produced by exactly one intention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_plan_todos_requirement
  ON neiist.event_plan_todos (requirement_id) WHERE requirement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION neiist.touch_event_plan() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_plans_touch ON neiist.event_plans;
CREATE TRIGGER trg_event_plans_touch
  BEFORE UPDATE ON neiist.event_plans
  FOR EACH ROW EXECUTE FUNCTION neiist.touch_event_plan();

-- ---------------------------------------------------------------------------------------------
-- Writing it
-- ---------------------------------------------------------------------------------------------

-- Create or update the plan. **Only the owning team**, checked against the event.
--
-- A collaborating team (#219) reads the plan — a poster designer needs the objetivo — but does not
-- write it. The plan is the owning team's statement of what the event is.
CREATE OR REPLACE FUNCTION neiist.upsert_event_plan(
  p_event       INT,
  p_objetivo    TEXT,
  p_estrutura   TEXT,
  p_coordinator VARCHAR(50),
  p_actor       VARCHAR(50),
  p_team        VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT owner_department_name INTO v_owner
  FROM neiist.internal_events WHERE id = p_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse evento não existe.' USING ERRCODE = 'NEI15';
  END IF;
  IF p_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pelo evento pode escrever o plano.'
      USING ERRCODE = 'NEI21';
  END IF;

  INSERT INTO neiist.event_plans
    (event_id, objetivo, estrutura, coordinator_istid, created_by_istid)
  VALUES (p_event, NULLIF(btrim(coalesce(p_objetivo, '')), ''),
          NULLIF(btrim(coalesce(p_estrutura, '')), ''), p_coordinator, p_actor)
  ON CONFLICT (event_id) DO UPDATE
  SET objetivo = EXCLUDED.objetivo,
      estrutura = EXCLUDED.estrutura,
      coordinator_istid = EXCLUDED.coordinator_istid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.upsert_event_plan(
  INT, TEXT, TEXT, VARCHAR(50), VARCHAR(50), VARCHAR(30)
) TO neiist_app_user;

-- Add or remove a colaborador responsável. Owning team only, and only its own people — a plan
-- listing somebody who is not on the team would be a plan nobody can act on.
CREATE OR REPLACE FUNCTION neiist.set_plan_collaborator(
  c_event    INT,
  c_istid    VARCHAR(50),
  c_add      BOOLEAN,
  c_team     VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT e.owner_department_name INTO v_owner
  FROM neiist.event_plans p JOIN neiist.internal_events e ON e.id = p.event_id
  WHERE p.event_id = c_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse evento não tem plano.' USING ERRCODE = 'NEI20';
  END IF;
  IF c_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;

  IF c_add THEN
    IF NOT EXISTS (
      SELECT 1 FROM neiist.membership m
      WHERE m.user_istid = c_istid AND m.department_name = v_owner
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    ) THEN
      RAISE EXCEPTION 'Essa pessoa não pertence à equipa responsável.' USING ERRCODE = 'NEI19';
    END IF;
    INSERT INTO neiist.event_plan_collaborators (event_id, user_istid)
    VALUES (c_event, c_istid) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM neiist.event_plan_collaborators
    WHERE event_id = c_event AND user_istid = c_istid;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_plan_collaborator(INT, VARCHAR(50), BOOLEAN, VARCHAR(30))
  TO neiist_app_user;

-- Comunicação externa: an orador, a patrocínio, a parceiro.
CREATE OR REPLACE FUNCTION neiist.add_plan_external(
  e_event  INT,
  e_kind   TEXT,
  e_name   TEXT,
  e_detail TEXT,
  e_team   VARCHAR(30)
) RETURNS INT AS $$
DECLARE
  v_owner VARCHAR(30);
  v_next  INT;
  v_id    INT;
BEGIN
  SELECT ev.owner_department_name INTO v_owner
  FROM neiist.event_plans p JOIN neiist.internal_events ev ON ev.id = p.event_id
  WHERE p.event_id = e_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse evento não tem plano.' USING ERRCODE = 'NEI20';
  END IF;
  IF e_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;
  IF e_kind NOT IN ('orador', 'patrocinio', 'parceiro', 'outro') THEN
    RAISE EXCEPTION 'Tipo inválido.' USING ERRCODE = 'NEI19';
  END IF;
  IF btrim(coalesce(e_name, '')) = '' THEN
    RAISE EXCEPTION 'Indica um nome.' USING ERRCODE = 'NEI19';
  END IF;

  SELECT coalesce(max(position), -1) + 1 INTO v_next
  FROM neiist.event_plan_externals WHERE event_id = e_event;

  INSERT INTO neiist.event_plan_externals (event_id, kind, name, detail, position)
  VALUES (e_event, e_kind, btrim(e_name), NULLIF(btrim(coalesce(e_detail, '')), ''), v_next)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_plan_external(INT, TEXT, TEXT, TEXT, VARCHAR(30))
  TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.remove_plan_external(x_id INT, x_team VARCHAR(30))
RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT ev.owner_department_name INTO v_owner
  FROM neiist.event_plan_externals x
  JOIN neiist.internal_events ev ON ev.id = x.event_id
  WHERE x.id = x_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse item não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF x_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;

  DELETE FROM neiist.event_plan_externals WHERE id = x_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.remove_plan_external(INT, VARCHAR(30)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- The To Dos
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.add_plan_todo(
  t_event    INT,
  t_task     TEXT,
  t_assignee VARCHAR(50),
  t_team     VARCHAR(30)
) RETURNS INT AS $$
DECLARE
  v_owner VARCHAR(30);
  v_next  INT;
  v_id    INT;
BEGIN
  SELECT ev.owner_department_name INTO v_owner
  FROM neiist.event_plans p JOIN neiist.internal_events ev ON ev.id = p.event_id
  WHERE p.event_id = t_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse evento não tem plano.' USING ERRCODE = 'NEI20';
  END IF;
  IF t_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;
  IF btrim(coalesce(t_task, '')) = '' THEN
    RAISE EXCEPTION 'Escreve o que é preciso fazer.' USING ERRCODE = 'NEI19';
  END IF;

  -- An assignee must be on the owning team, or the plan lists work nobody there owns.
  IF t_assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = t_assignee AND m.department_name = v_owner
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Essa pessoa não pertence à equipa responsável.' USING ERRCODE = 'NEI19';
  END IF;

  SELECT coalesce(max(position), -1) + 1 INTO v_next
  FROM neiist.event_plan_todos WHERE event_id = t_event;

  INSERT INTO neiist.event_plan_todos (event_id, task, assignee_istid, position)
  VALUES (t_event, btrim(t_task), t_assignee, v_next)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_plan_todo(INT, TEXT, VARCHAR(50), VARCHAR(30))
  TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.set_plan_todo_done(
  t_id    INT,
  t_done  BOOLEAN,
  t_actor VARCHAR(50),
  t_team  VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT ev.owner_department_name INTO v_owner
  FROM neiist.event_plan_todos t JOIN neiist.internal_events ev ON ev.id = t.event_id
  WHERE t.id = t_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Essa tarefa não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF t_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;

  UPDATE neiist.event_plan_todos
  SET done = t_done,
      done_by = CASE WHEN t_done THEN t_actor ELSE NULL END,
      done_at = CASE WHEN t_done THEN NOW() ELSE NULL END
  WHERE id = t_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_plan_todo_done(INT, BOOLEAN, VARCHAR(50), VARCHAR(30))
  TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.remove_plan_todo(t_id INT, t_team VARCHAR(30))
RETURNS VOID AS $$
DECLARE
  v_owner       VARCHAR(30);
  v_requirement INT;
BEGIN
  SELECT ev.owner_department_name, t.requirement_id INTO v_owner, v_requirement
  FROM neiist.event_plan_todos t JOIN neiist.internal_events ev ON ev.id = t.event_id
  WHERE t.id = t_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Essa tarefa não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF t_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o plano.' USING ERRCODE = 'NEI21';
  END IF;
  -- A to-do that already produced a requerimento is not just an intention any more: another team
  -- is working from it. Cancel the requerimento first, which is a conversation with them.
  IF v_requirement IS NOT NULL THEN
    RAISE EXCEPTION 'Esta tarefa já deu origem a um requerimento. Cancela o requerimento primeiro.'
      USING ERRCODE = 'NEI19';
  END IF;

  DELETE FROM neiist.event_plan_todos WHERE id = t_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.remove_plan_todo(INT, VARCHAR(30)) TO neiist_app_user;

-- **The join.** Raise a requerimento FROM a plan to-do, atomically.
--
-- This is the function the whole slice exists for. "Fazer o requerimento de visuais — Guilherme"
-- stops being a line somebody has to remember to act on and becomes the requerimento itself, with
-- the to-do pointing at it. One thing in two states, instead of the plan and the requerimentos
-- being two lists of the same intent.
--
-- Marking the to-do done is deliberate and worth stating: the intention WAS "raise it", and that
-- is now finished. Whether the work lands is the requerimento's own status to carry.
CREATE OR REPLACE FUNCTION neiist.raise_requirement_from_todo(
  t_id       INT,
  t_target   VARCHAR(30),
  t_title    TEXT,
  t_detail   TEXT,
  t_deadline TIMESTAMPTZ,
  t_actor    VARCHAR(50),
  t_team     VARCHAR(30)
) RETURNS INT AS $$
DECLARE
  v_owner   VARCHAR(30);
  v_event   INT;
  v_existing INT;
  v_new     INT;
BEGIN
  SELECT ev.owner_department_name, t.event_id, t.requirement_id
    INTO v_owner, v_event, v_existing
  FROM neiist.event_plan_todos t JOIN neiist.internal_events ev ON ev.id = t.event_id
  WHERE t.id = t_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Essa tarefa não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF t_team <> v_owner THEN
    RAISE EXCEPTION 'Só a equipa responsável pode fazer requerimentos deste evento.'
      USING ERRCODE = 'NEI21';
  END IF;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Esta tarefa já deu origem a um requerimento.' USING ERRCODE = 'NEI19';
  END IF;

  -- Delegates to slice A rather than reimplementing: raise_requirements owns the rules about who
  -- may ask whom, and a second copy of them here is a second place to get them wrong.
  PERFORM neiist.raise_requirements(
    v_event, v_owner, ARRAY[t_target]::VARCHAR(30)[], ARRAY[t_title]::TEXT[],
    ARRAY[t_detail]::TEXT[], ARRAY[t_deadline]::TIMESTAMPTZ[], t_actor
  );

  SELECT id INTO v_new FROM neiist.requirements
  WHERE event_id = v_event AND target_department = t_target
  ORDER BY created_at DESC LIMIT 1;

  UPDATE neiist.event_plan_todos
  SET requirement_id = v_new, done = TRUE, done_by = t_actor, done_at = NOW()
  WHERE id = t_id;

  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.raise_requirement_from_todo(
  INT, VARCHAR(30), TEXT, TEXT, TIMESTAMPTZ, VARCHAR(50), VARCHAR(30)
) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- Reading it
-- ---------------------------------------------------------------------------------------------

-- The plan, for the owning team OR a collaborating team (#219).
--
-- Collaborators read it deliberately: a poster designer needs the objetivo to design a poster, and
-- making them ask for it by message is the coordination cost this whole migration removes. They
-- cannot write it — that is the owning team's statement of what the event is.
--
-- Note what is NOT returned: local, data, hora. Those are the event's, and this page renders them
-- from there. A copy would go stale (rule R1).
CREATE OR REPLACE FUNCTION neiist.get_event_plan(g_event INT, g_department VARCHAR(30))
RETURNS TABLE (
  event_id         INT,
  objetivo         TEXT,
  estrutura        TEXT,
  coordinator_name TEXT,
  coordinator_istid VARCHAR(50),
  can_edit         BOOLEAN,
  updated_at       TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT p.event_id, p.objetivo, p.estrutura, u.name, p.coordinator_istid,
         (e.owner_department_name = g_department),
         p.updated_at
  FROM neiist.event_plans p
  JOIN neiist.internal_events e ON e.id = p.event_id
  LEFT JOIN neiist.users u ON u.istid = p.coordinator_istid
  WHERE p.event_id = g_event
    AND (
      e.owner_department_name = g_department
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams c
            WHERE c.event_id = p.event_id AND c.department_name = g_department))
    );
$$;

GRANT EXECUTE ON FUNCTION neiist.get_event_plan(INT, VARCHAR(30)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_plan_collaborators(g_event INT, g_department VARCHAR(30))
RETURNS TABLE (istid VARCHAR(50), name TEXT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT c.user_istid, u.name
  FROM neiist.event_plan_collaborators c
  JOIN neiist.users u ON u.istid = c.user_istid
  JOIN neiist.internal_events e ON e.id = c.event_id
  WHERE c.event_id = g_event
    AND (
      e.owner_department_name = g_department
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams t
            WHERE t.event_id = c.event_id AND t.department_name = g_department))
    )
  ORDER BY u.name;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_plan_collaborators(INT, VARCHAR(30)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_plan_externals(g_event INT, g_department VARCHAR(30))
RETURNS TABLE (id INT, kind TEXT, name TEXT, detail TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT x.id, x.kind, x.name, x.detail
  FROM neiist.event_plan_externals x
  JOIN neiist.internal_events e ON e.id = x.event_id
  WHERE x.event_id = g_event
    AND (
      e.owner_department_name = g_department
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams t
            WHERE t.event_id = x.event_id AND t.department_name = g_department))
    )
  ORDER BY x.position, x.id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_plan_externals(INT, VARCHAR(30)) TO neiist_app_user;

-- The to-dos, each carrying the requerimento it produced, if any.
CREATE OR REPLACE FUNCTION neiist.get_plan_todos(g_event INT, g_department VARCHAR(30))
RETURNS TABLE (
  id             INT,
  task           TEXT,
  assignee_name  TEXT,
  assignee_istid VARCHAR(50),
  done           BOOLEAN,
  done_by_name   TEXT,
  requirement_id INT,
  requirement_team VARCHAR(30),
  requirement_status TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.id, t.task, a.name, t.assignee_istid, t.done, d.name,
         t.requirement_id, r.target_department, r.status
  FROM neiist.event_plan_todos t
  JOIN neiist.internal_events e ON e.id = t.event_id
  LEFT JOIN neiist.users a ON a.istid = t.assignee_istid
  LEFT JOIN neiist.users d ON d.istid = t.done_by
  LEFT JOIN neiist.requirements r ON r.id = t.requirement_id
  WHERE t.event_id = g_event
    AND (
      e.owner_department_name = g_department
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams c
            WHERE c.event_id = t.event_id AND c.department_name = g_department))
    )
  ORDER BY t.done, t.position, t.id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_plan_todos(INT, VARCHAR(30)) TO neiist_app_user;
