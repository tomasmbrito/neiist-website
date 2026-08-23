-- 013: meeting detail — agenda, attendance, documents and related events (#129, slice B).
--
-- Slice A gave a team its list of events. This is the part that makes a *meeting* useful: what it
-- is about, who said they are coming, what came out of it, and which other event it belongs to.
--
-- Still nothing here touches `/activities`, the Notion sync or Google Calendar — those remain
-- slices C and D. `is_public` is unchanged and no new function returns event rows without a
-- department parameter, so the introspection guard from slice A still holds.

-- The agenda. A single text field rather than a table of items: in Notion it is page body, people
-- write prose and nested bullets, and modelling that as rows would lose the thing they actually
-- use it for. Minutes likewise.
ALTER TABLE neiist.internal_events
  ADD COLUMN IF NOT EXISTS agenda  TEXT,
  ADD COLUMN IF NOT EXISTS minutes TEXT;

-- Links out to the Plano de Atividades, the Relatório, a slide deck. **Links, not files** — those
-- documents stay in Notion/Drive by the scope boundary in #126, and this repo already learned in
-- #95 what accepting uploads costs.
CREATE TABLE IF NOT EXISTS neiist.event_documents (
  id       SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL DEFAULT 'other'
           CHECK (kind IN ('plano', 'relatorio', 'ata', 'other')),
  title    TEXT NOT NULL CHECK (btrim(title) <> ''),
  -- http/https only. A `javascript:` URL rendered into an href is stored XSS, and the anchor is
  -- built from this value; refusing it here means no renderer has to remember.
  url      TEXT NOT NULL CHECK (url ~* '^https?://'),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_documents_event ON neiist.event_documents (event_id);

-- Notion's self-relation: "this meeting belongs to that event".
--
-- Stored as ONE row per pair with the smaller id first, not two mirrored rows. Two rows means two
-- chances to be inconsistent, and "related" has no direction — the ordering is a normalisation
-- trick, not a claim about which event matters more.
CREATE TABLE IF NOT EXISTS neiist.event_relations (
  event_id         INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  related_event_id INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, related_event_id),
  CONSTRAINT event_relations_not_self CHECK (event_id <> related_event_id),
  CONSTRAINT event_relations_canonical_order CHECK (event_id < related_event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_relations_related
  ON neiist.event_relations (related_event_id);

-- One event in full, for its detail page.
--
-- Takes a department and checks it, like every other reader of this table: passing an id alone
-- would be an object reference with no tenancy check, and the caller would have to remember to
-- compare the owner afterwards. Requiring the department here means a mismatched pair simply
-- returns nothing — the introspection guard from slice A also still passes.
CREATE OR REPLACE FUNCTION neiist.get_internal_event_detail(
  e_id         INT,
  e_department VARCHAR(30)
) RETURNS TABLE (
  id               INT,
  kind             TEXT,
  name             TEXT,
  description      TEXT,
  agenda           TEXT,
  minutes          TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  is_public        BOOLEAN,
  created_by_istid VARCHAR(50),
  created_by_name  VARCHAR(100),
  locations        TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.description, e.agenda, e.minutes, e.starts_at, e.ends_at,
         e.is_public, e.created_by_istid, u.name,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  JOIN neiist.users u ON u.istid = e.created_by_istid
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE e.id = e_id AND e.owner_department_name = e_department
  GROUP BY e.id, u.name;
$$;

GRANT EXECUTE ON FUNCTION
  neiist.get_internal_event_detail(INT, VARCHAR(30)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_event_attendees(e_id INT, e_department VARCHAR(30))
RETURNS TABLE (user_istid VARCHAR(50), user_name VARCHAR(100), response TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.user_istid, u.name, a.response
  FROM neiist.event_attendees a
  JOIN neiist.users u ON u.istid = a.user_istid
  JOIN neiist.internal_events e ON e.id = a.event_id
  WHERE a.event_id = e_id AND e.owner_department_name = e_department
  ORDER BY u.name;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_event_attendees(INT, VARCHAR(30)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_event_documents(e_id INT, e_department VARCHAR(30))
RETURNS TABLE (id INT, kind TEXT, title TEXT, url TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT d.id, d.kind, d.title, d.url
  FROM neiist.event_documents d
  JOIN neiist.internal_events e ON e.id = d.event_id
  WHERE d.event_id = e_id AND e.owner_department_name = e_department
  ORDER BY d.added_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_event_documents(INT, VARCHAR(30)) TO neiist_app_user;

-- Related events, both directions, from the single canonical row.
CREATE OR REPLACE FUNCTION neiist.get_event_relations(e_id INT, e_department VARCHAR(30))
RETURNS TABLE (id INT, name TEXT, kind TEXT, starts_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT other.id, other.name, other.kind, other.starts_at
  FROM neiist.event_relations r
  JOIN neiist.internal_events self
    ON self.id = e_id AND self.owner_department_name = e_department
  JOIN neiist.internal_events other
    ON other.id = CASE WHEN r.event_id = e_id THEN r.related_event_id ELSE r.event_id END
  WHERE r.event_id = e_id OR r.related_event_id = e_id
  ORDER BY other.starts_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_event_relations(INT, VARCHAR(30)) TO neiist_app_user;

-- Agenda and minutes.
CREATE OR REPLACE FUNCTION neiist.update_event_notes(
  e_id      INT,
  e_agenda  TEXT,
  e_minutes TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.internal_events
  SET agenda = NULLIF(btrim(coalesce(e_agenda, '')), ''),
      minutes = NULLIF(btrim(coalesce(e_minutes, '')), ''),
      updated_at = NOW()
  WHERE id = e_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O evento não existe.' USING ERRCODE = 'NEI15';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.update_event_notes(INT, TEXT, TEXT) TO neiist_app_user;

-- Attendance. Upsert, because "invite Ana" and "Ana said yes" are the same row at different times,
-- and treating them as separate inserts is how a person ends up listed twice.
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
  IF NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = e_istid) THEN
    RAISE EXCEPTION 'O membro não existe.' USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.event_attendees (event_id, user_istid, response)
  VALUES (e_id, e_istid, e_response)
  ON CONFLICT (event_id, user_istid) DO UPDATE SET response = EXCLUDED.response;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_event_attendance(INT, VARCHAR(50), TEXT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.remove_event_attendee(e_id INT, e_istid VARCHAR(50))
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.event_attendees WHERE event_id = e_id AND user_istid = e_istid;
$$;

GRANT EXECUTE ON FUNCTION
  neiist.remove_event_attendee(INT, VARCHAR(50)) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.add_event_document(
  e_id    INT,
  e_kind  TEXT,
  e_title TEXT,
  e_url   TEXT
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF e_kind NOT IN ('plano', 'relatorio', 'ata', 'other') THEN
    RAISE EXCEPTION 'Tipo de documento inválido.' USING ERRCODE = 'NEI14';
  END IF;
  IF e_title IS NULL OR btrim(e_title) = '' THEN
    RAISE EXCEPTION 'O título é obrigatório.' USING ERRCODE = 'NEI14';
  END IF;
  -- Checked here as well as by the CHECK, so the caller gets this message rather than a raw
  -- constraint violation.
  IF e_url !~* '^https?://' THEN
    RAISE EXCEPTION 'O endereço tem de começar por http:// ou https://.' USING ERRCODE = 'NEI14';
  END IF;

  INSERT INTO neiist.event_documents (event_id, kind, title, url)
  VALUES (e_id, e_kind, btrim(e_title), btrim(e_url))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.add_event_document(INT, TEXT, TEXT, TEXT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.remove_event_document(d_id INT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.event_documents WHERE id = d_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.remove_event_document(INT) TO neiist_app_user;

-- Relate two events. Normalises the pair so the caller does not have to know about the ordering
-- constraint, and refuses a cross-team link: relating an event to another team's would let one
-- team's detail page name the other's internal meeting.
CREATE OR REPLACE FUNCTION neiist.relate_events(e_a INT, e_b INT) RETURNS VOID AS $$
DECLARE
  v_low  INT := least(e_a, e_b);
  v_high INT := greatest(e_a, e_b);
BEGIN
  IF e_a = e_b THEN
    RAISE EXCEPTION 'Um evento não pode estar relacionado consigo próprio.' USING ERRCODE = 'NEI14';
  END IF;
  IF (SELECT count(DISTINCT owner_department_name)
      FROM neiist.internal_events WHERE id IN (e_a, e_b)) <> 1 THEN
    RAISE EXCEPTION 'Só é possível relacionar eventos da mesma equipa.' USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.event_relations (event_id, related_event_id)
  VALUES (v_low, v_high)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.relate_events(INT, INT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.unrelate_events(e_a INT, e_b INT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.event_relations
  WHERE event_id = least(e_a, e_b) AND related_event_id = greatest(e_a, e_b);
$$;

GRANT EXECUTE ON FUNCTION neiist.unrelate_events(INT, INT) TO neiist_app_user;
