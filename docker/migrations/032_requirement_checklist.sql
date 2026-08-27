-- 032 — The shared checklist (#242, slice of #131).
--
-- Every one of the five Notion brief templates ends with a To-do List, under an explicit
-- instruction repeated verbatim in all five:
--
--   Para quem faz o requerimento: no final do ficheiro colocar na To-do List o que se espera
--   receber da equipa a quem foi feito o Requerimento.
--   Para quem recebe: ir atualizando a To-do List consoante o que já foi feito.
--
-- It is how "what is expected" and "what is done" are actually communicated between two teams.
-- #131 listed it; slice A (#232) shipped without it. It is the largest gap between the website and
-- the real protocol.
--
-- ## Why `source` exists
--
-- #233 will generate items from brief options: ticking "Cartaz A3" in the Visuais brief creates the
-- checklist item, rather than the requester ticking a format and the receiving team retyping the
-- same four lines by hand — which is what actually happens in Notion today, verified on the
-- Workshop de Rust requerimento.
--
-- That means a brief can be edited and its items regenerated. `source` is what stops that
-- regeneration deleting a note somebody typed: only `brief` items are replaceable.

CREATE TABLE IF NOT EXISTS neiist.requirement_checklist (
  id             SERIAL PRIMARY KEY,
  requirement_id INT NOT NULL REFERENCES neiist.requirements(id) ON DELETE CASCADE,
  item           TEXT NOT NULL,
  position       INT NOT NULL DEFAULT 0,

  done     BOOLEAN NOT NULL DEFAULT FALSE,
  done_by  VARCHAR(50) REFERENCES neiist.users(istid),
  done_at  TIMESTAMPTZ,

  -- 'brief'  — generated from a brief option (#233); replaceable when the brief changes
  -- 'manual' — typed by a person; never touched by regeneration
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('brief', 'manual')),
  /** The brief option this came from, so regeneration can match rather than guess by text. */
  brief_key TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT checklist_item_not_blank CHECK (btrim(item) <> ''),
  -- Done says who and when, or claims neither. Same shape as every other completion in this
  -- schema (#215's decisions, #217's approvals).
  CONSTRAINT checklist_done_complete CHECK (
    (done = FALSE AND done_by IS NULL AND done_at IS NULL)
    OR (done = TRUE AND done_by IS NOT NULL AND done_at IS NOT NULL)
  ),
  -- A brief item must say which option produced it, or regeneration cannot find it again.
  CONSTRAINT checklist_brief_has_key CHECK (source <> 'brief' OR brief_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_requirement_checklist
  ON neiist.requirement_checklist (requirement_id, position, id);

-- A brief option maps to at most one item on a requerimento, so regenerating is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_checklist_brief_key
  ON neiist.requirement_checklist (requirement_id, brief_key)
  WHERE brief_key IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Who may do what — the slice A asymmetry, applied to the checklist
-- ---------------------------------------------------------------------------------------------

-- Add an item. **The REQUESTING team only.**
--
-- The checklist is the requester's definition of done: it is the list of what they expect back.
-- Letting the target team add to it would let Visuais decide what Organização de Eventos asked
-- for, which is the same inversion #232 refuses when it stops the requester marking its own
-- request `done`.
CREATE OR REPLACE FUNCTION neiist.add_checklist_item(
  c_requirement INT,
  c_item        TEXT,
  c_team        VARCHAR(30),
  c_source      TEXT DEFAULT 'manual',
  c_brief_key   TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_requesting VARCHAR(30);
  v_next       INT;
  v_id         INT;
BEGIN
  SELECT requesting_department INTO v_requesting
  FROM neiist.requirements WHERE id = c_requirement;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse requerimento não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF c_team <> v_requesting THEN
    RAISE EXCEPTION 'Só a equipa que fez o pedido pode dizer o que espera receber.'
      USING ERRCODE = 'NEI21';
  END IF;
  IF btrim(coalesce(c_item, '')) = '' THEN
    RAISE EXCEPTION 'Escreve o que é preciso.' USING ERRCODE = 'NEI19';
  END IF;

  SELECT coalesce(max(position), -1) + 1 INTO v_next
  FROM neiist.requirement_checklist WHERE requirement_id = c_requirement;

  INSERT INTO neiist.requirement_checklist
    (requirement_id, item, position, source, brief_key)
  VALUES (c_requirement, btrim(c_item), v_next, c_source, c_brief_key)
  -- Regenerating a brief must not duplicate: the same option updates its own item in place, and
  -- deliberately does NOT reset `done` — the work was still done.
  ON CONFLICT (requirement_id, brief_key) WHERE brief_key IS NOT NULL DO UPDATE
  SET item = EXCLUDED.item
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_checklist_item(INT, TEXT, VARCHAR(30), TEXT, TEXT)
  TO neiist_app_user;

-- Tick or untick. **The TARGET team only.** It is their work; saying it is finished is their
-- statement to make, exactly as `status` is in #232.
CREATE OR REPLACE FUNCTION neiist.set_checklist_item_done(
  c_id    INT,
  c_done  BOOLEAN,
  c_actor VARCHAR(50),
  c_team  VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_target VARCHAR(30);
BEGIN
  SELECT r.target_department INTO v_target
  FROM neiist.requirement_checklist c
  JOIN neiist.requirements r ON r.id = c.requirement_id
  WHERE c.id = c_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse item não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF c_team <> v_target THEN
    RAISE EXCEPTION 'Só a equipa responsável pode marcar o que já fez.' USING ERRCODE = 'NEI21';
  END IF;

  UPDATE neiist.requirement_checklist
  SET done = c_done,
      done_by = CASE WHEN c_done THEN c_actor ELSE NULL END,
      done_at = CASE WHEN c_done THEN NOW() ELSE NULL END
  WHERE id = c_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_checklist_item_done(INT, BOOLEAN, VARCHAR(50), VARCHAR(30))
  TO neiist_app_user;

-- Remove an item. Requesting team only, mirroring who may add.
--
-- A `brief` item cannot be removed by hand: it exists because the brief says so, and deleting it
-- here would put the checklist and the brief in disagreement until the next regeneration silently
-- brought it back. Untick the option in the brief instead.
CREATE OR REPLACE FUNCTION neiist.remove_checklist_item(
  c_id   INT,
  c_team VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_requesting VARCHAR(30);
  v_source     TEXT;
BEGIN
  SELECT r.requesting_department, c.source INTO v_requesting, v_source
  FROM neiist.requirement_checklist c
  JOIN neiist.requirements r ON r.id = c.requirement_id
  WHERE c.id = c_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse item não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF c_team <> v_requesting THEN
    RAISE EXCEPTION 'Só a equipa que fez o pedido pode remover itens.' USING ERRCODE = 'NEI21';
  END IF;
  IF v_source = 'brief' THEN
    RAISE EXCEPTION 'Este item vem do briefing. Desmarca a opção no briefing para o remover.'
      USING ERRCODE = 'NEI19';
  END IF;

  DELETE FROM neiist.requirement_checklist WHERE id = c_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.remove_checklist_item(INT, VARCHAR(30)) TO neiist_app_user;

-- Drop the brief items an option no longer selects (#233 will call this before regenerating).
-- Manual items are untouched, which is the whole point of `source`.
CREATE OR REPLACE FUNCTION neiist.prune_brief_checklist_items(
  c_requirement INT,
  c_keep_keys   TEXT[]
) RETURNS INT AS $$
DECLARE
  v_removed INT;
BEGIN
  DELETE FROM neiist.requirement_checklist
  WHERE requirement_id = c_requirement
    AND source = 'brief'
    AND NOT (brief_key = ANY(coalesce(c_keep_keys, ARRAY[]::TEXT[])));

  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.prune_brief_checklist_items(INT, TEXT[]) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- Reading it
-- ---------------------------------------------------------------------------------------------

-- Keyed by requirement AND asking team, like every reader in #126: an id belonging to a pair the
-- caller is not part of returns nothing, rather than trusting the route to compare.
CREATE OR REPLACE FUNCTION neiist.get_requirement_checklist(
  g_requirement INT,
  g_department  VARCHAR(30)
) RETURNS TABLE (
  id           INT,
  item         TEXT,
  done         BOOLEAN,
  done_by_name TEXT,
  done_at      TIMESTAMPTZ,
  source       TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT c.id, c.item, c.done, u.name, c.done_at, c.source
  FROM neiist.requirement_checklist c
  JOIN neiist.requirements r ON r.id = c.requirement_id
  LEFT JOIN neiist.users u ON u.istid = c.done_by
  WHERE c.requirement_id = g_requirement
    AND (r.target_department = g_department OR r.requesting_department = g_department)
  ORDER BY c.position, c.id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_requirement_checklist(INT, VARCHAR(30)) TO neiist_app_user;

-- The list gains checklist progress.
--
-- "Em curso" tells nobody anything; "3/4" does. This is the number the inbox (#235) is built
-- around, and it is the reason the checklist is worth having in a list view rather than only on a
-- detail page.
--
-- Return type changes, so the old signature has to go first.
DROP FUNCTION IF EXISTS neiist.get_team_requirements(VARCHAR(30));

CREATE OR REPLACE FUNCTION neiist.get_team_requirements(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  event_id         INT,
  event_name       TEXT,
  direction        TEXT,
  requesting_department VARCHAR(30),
  target_department     VARCHAR(30),
  title            TEXT,
  detail           TEXT,
  deadline         TIMESTAMPTZ,
  status           TEXT,
  assignee_name    TEXT,
  deliverable_count INT,
  checklist_total  INT,
  checklist_done   INT,
  created_at       TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.id, r.event_id, e.name,
         CASE WHEN r.target_department = g_department THEN 'inbox' ELSE 'outbox' END,
         r.requesting_department, r.target_department,
         r.title, r.detail, r.deadline, r.status, u.name,
         (SELECT count(*)::INT FROM neiist.requirement_deliverables d
          WHERE d.requirement_id = r.id),
         (SELECT count(*)::INT FROM neiist.requirement_checklist c
          WHERE c.requirement_id = r.id),
         (SELECT count(*)::INT FROM neiist.requirement_checklist c
          WHERE c.requirement_id = r.id AND c.done),
         r.created_at
  FROM neiist.requirements r
  JOIN neiist.internal_events e ON e.id = r.event_id
  LEFT JOIN neiist.users u ON u.istid = r.assignee_istid
  WHERE r.target_department = g_department OR r.requesting_department = g_department
  ORDER BY (r.status IN ('done', 'cancelled')), r.deadline NULLS LAST, r.created_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_requirements(VARCHAR(30)) TO neiist_app_user;
