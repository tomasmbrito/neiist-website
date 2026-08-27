-- 028 — Requerimentos: the request/assign/deliver spine (#232, slice A of #131).
--
-- The Requerimento protocol is how NEIIST's teams actually work together, and #131 calls it the
-- centrepiece of the Notion migration. Organização de Eventos creates an event, then raises a
-- requerimento to each team it needs: Visuais for artwork, Divulgação to publish, C&Q for the
-- signup form, Contacto for sponsors, Fotografia to cover it.
--
-- This slice is the spine only. The five typed briefs are #233, the approval and publication
-- gates are #234, and the inboxes plus the "approved but unpublished" queue are #235. The columns
-- those slices need exist here so they are additive rather than a rewrite — but nothing writes
-- them yet, and nothing reads them as if they meant something.

-- ---------------------------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS neiist.requirements (
  id           SERIAL PRIMARY KEY,
  event_id     INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,

  -- Two teams, and which is which is the whole authorization model: the REQUESTING team asks,
  -- the TARGET team does the work and owns the status.
  requesting_department VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),
  target_department     VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),

  title      TEXT NOT NULL,
  detail     TEXT,
  deadline   TIMESTAMPTZ,
  -- Who on the target team owns it. Nullable: a requerimento often arrives before the receiving
  -- team has decided who picks it up, and forcing a name at creation would either block the
  -- request or invite a placeholder.
  assignee_istid VARCHAR(50) REFERENCES neiist.users(istid) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'requested'
         CHECK (status IN ('requested', 'accepted', 'in_progress', 'done', 'cancelled')),

  -- #234's columns, present so that slice is additive. Nothing writes them in slice A.
  approved_by_istid VARCHAR(50) REFERENCES neiist.users(istid),
  approved_at       TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,

  created_by_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT requirement_title_not_blank CHECK (btrim(title) <> ''),
  -- A team does not raise a requerimento to itself. That is just doing the work, and allowing it
  -- would make "only the target team may change status" meaningless for those rows.
  CONSTRAINT requirement_two_teams CHECK (requesting_department <> target_department),
  -- An approval must say who and when, or claim neither. Same shape as #215's decision rows.
  CONSTRAINT requirement_approval_complete CHECK (
    (approved_by_istid IS NULL AND approved_at IS NULL)
    OR (approved_by_istid IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_requirements_inbox
  ON neiist.requirements (target_department, status, deadline);
CREATE INDEX IF NOT EXISTS idx_requirements_outbox
  ON neiist.requirements (requesting_department, status);
CREATE INDEX IF NOT EXISTS idx_requirements_event
  ON neiist.requirements (event_id);

-- Deliverables: the artwork, the post, the form. Links rather than uploads in this slice — #95
-- hardened uploads, but a requerimento's deliverable is usually already in Drive or Canva, and
-- adding a second upload path before anyone asks for one is speculative.
CREATE TABLE IF NOT EXISTS neiist.requirement_deliverables (
  id             SERIAL PRIMARY KEY,
  requirement_id INT NOT NULL REFERENCES neiist.requirements(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  label          TEXT,
  uploaded_by    VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT deliverable_url_is_http CHECK (url ~ '^https?://')
);

CREATE INDEX IF NOT EXISTS idx_requirement_deliverables
  ON neiist.requirement_deliverables (requirement_id);

CREATE OR REPLACE FUNCTION neiist.touch_requirement() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_requirements_touch ON neiist.requirements;
CREATE TRIGGER trg_requirements_touch
  BEFORE UPDATE ON neiist.requirements
  FOR EACH ROW EXECUTE FUNCTION neiist.touch_requirement();

-- ---------------------------------------------------------------------------------------------
-- Raising them
-- ---------------------------------------------------------------------------------------------

-- Raise N requerimentos on one event, atomically — a stated acceptance criterion of #131.
--
-- Atomic matters here for a reason that is easy to miss: an event needing a poster AND a campaign
-- AND a photographer is one decision. Half of it landing means Visuais starts work on something
-- Divulgação was never told about, and the person who submitted the form has no way to know which
-- half took. A plpgsql function is one implicit transaction, so either every requerimento exists
-- or none does.
--
-- The arrays are parallel. Postgres has no "array of records" that is pleasant to pass from the
-- driver, and a JSONB parameter would move validation out of the type system into a parse step.
-- Length is checked so a mismatch is an error rather than a silently truncated request.
CREATE OR REPLACE FUNCTION neiist.raise_requirements(
  r_event         INT,
  r_requesting    VARCHAR(30),
  r_targets       VARCHAR(30)[],
  r_titles        TEXT[],
  r_details       TEXT[],
  r_deadlines     TIMESTAMPTZ[],
  r_created_by    VARCHAR(50)
) RETURNS INT AS $$
DECLARE
  v_count INT;
BEGIN
  IF coalesce(array_length(r_targets, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Indica pelo menos uma equipa.' USING ERRCODE = 'NEI19';
  END IF;

  IF array_length(r_titles, 1) <> array_length(r_targets, 1)
     OR array_length(r_details, 1) <> array_length(r_targets, 1)
     OR array_length(r_deadlines, 1) <> array_length(r_targets, 1) THEN
    RAISE EXCEPTION 'Os campos do pedido não correspondem às equipas.' USING ERRCODE = 'NEI19';
  END IF;

  -- The event must belong to the requesting team. Checked here rather than trusted from the
  -- route: a requerimento names the event it belongs to, and raising one against another team's
  -- event would put work on somebody's inbox referencing something they cannot open.
  IF NOT EXISTS (
    SELECT 1 FROM neiist.internal_events
    WHERE id = r_event AND owner_department_name = r_requesting
  ) THEN
    RAISE EXCEPTION 'Esse evento não é da tua equipa.' USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.requirements
    (event_id, requesting_department, target_department, title, detail, deadline, created_by_istid)
  SELECT r_event, r_requesting, t.target, r_titles[t.i],
         NULLIF(btrim(coalesce(r_details[t.i], '')), ''), r_deadlines[t.i], r_created_by
  FROM unnest(r_targets) WITH ORDINALITY AS t(target, i);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.raise_requirements(
  INT, VARCHAR(30), VARCHAR(30)[], TEXT[], TEXT[], TIMESTAMPTZ[], VARCHAR(50)
) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- Moving them along — and who may
-- ---------------------------------------------------------------------------------------------

-- Set the status. **Only the TARGET team**, except for cancelling.
--
-- This is the authorization heart of the slice. The requesting team raised the request; letting it
-- mark its own request `done` would make the status meaningless as a signal — Organização de
-- Eventos could close a poster nobody drew. Conversely the requesting team CAN cancel: withdrawing
-- your own request is not a claim about somebody else's work.
--
-- The transition matrix is here rather than in TypeScript for the reason #78 established: the API
-- is not the only caller, and a rule that lives in one caller is a rule the next one forgets.
CREATE OR REPLACE FUNCTION neiist.set_requirement_status(
  s_id     INT,
  s_status TEXT,
  s_actor  VARCHAR(50),
  s_team   VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_target     VARCHAR(30);
  v_requesting VARCHAR(30);
  v_current    TEXT;
BEGIN
  SELECT target_department, requesting_department, status
    INTO v_target, v_requesting, v_current
  FROM neiist.requirements WHERE id = s_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse requerimento não existe.' USING ERRCODE = 'NEI20';
  END IF;

  IF s_status NOT IN ('requested', 'accepted', 'in_progress', 'done', 'cancelled') THEN
    RAISE EXCEPTION 'Estado inválido.' USING ERRCODE = 'NEI19';
  END IF;

  IF s_status = 'cancelled' THEN
    -- Either side may cancel: the asker withdraws, or the doer declines.
    IF s_team NOT IN (v_target, v_requesting) THEN
      RAISE EXCEPTION 'Só as equipas envolvidas podem cancelar este requerimento.'
        USING ERRCODE = 'NEI21';
    END IF;
  ELSIF s_team <> v_target THEN
    RAISE EXCEPTION 'Só a equipa responsável pode alterar o estado deste requerimento.'
      USING ERRCODE = 'NEI21';
  END IF;

  -- `cancelled` is terminal, exactly as `cancelled` is terminal for orders (#78). Reopening a
  -- withdrawn request should be a new request, so the history says what actually happened.
  IF v_current = 'cancelled' THEN
    RAISE EXCEPTION 'Este requerimento foi cancelado.' USING ERRCODE = 'NEI19';
  END IF;

  UPDATE neiist.requirements SET status = s_status WHERE id = s_id;

  -- Recorded for #234 to build on; slice A does not read it.
  IF s_status <> 'done' THEN
    UPDATE neiist.requirements
    SET approved_by_istid = NULL, approved_at = NULL
    WHERE id = s_id AND approved_at IS NOT NULL;
  END IF;

  PERFORM s_actor;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_requirement_status(INT, TEXT, VARCHAR(50), VARCHAR(30))
  TO neiist_app_user;

-- Assign somebody on the target team. Only the target team, and only its own people.
CREATE OR REPLACE FUNCTION neiist.assign_requirement(
  a_id       INT,
  a_assignee VARCHAR(50),
  a_team     VARCHAR(30)
) RETURNS VOID AS $$
DECLARE
  v_target VARCHAR(30);
BEGIN
  SELECT target_department INTO v_target FROM neiist.requirements WHERE id = a_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse requerimento não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF a_team <> v_target THEN
    RAISE EXCEPTION 'Só a equipa responsável pode atribuir este requerimento.'
      USING ERRCODE = 'NEI21';
  END IF;

  -- Unassignment is allowed; assignment must name somebody actually on the team, so an inbox
  -- cannot show work owned by a person who is not there.
  IF a_assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = a_assignee AND m.department_name = v_target
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Essa pessoa não pertence à equipa responsável.' USING ERRCODE = 'NEI19';
  END IF;

  UPDATE neiist.requirements SET assignee_istid = a_assignee WHERE id = a_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.assign_requirement(INT, VARCHAR(50), VARCHAR(30))
  TO neiist_app_user;

-- Record a deliverable. Target team only — it is their output.
CREATE OR REPLACE FUNCTION neiist.add_requirement_deliverable(
  d_id     INT,
  d_url    TEXT,
  d_label  TEXT,
  d_actor  VARCHAR(50),
  d_team   VARCHAR(30)
) RETURNS INT AS $$
DECLARE
  v_target VARCHAR(30);
  v_new    INT;
BEGIN
  SELECT target_department INTO v_target FROM neiist.requirements WHERE id = d_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esse requerimento não existe.' USING ERRCODE = 'NEI20';
  END IF;
  IF d_team <> v_target THEN
    RAISE EXCEPTION 'Só a equipa responsável pode entregar material.' USING ERRCODE = 'NEI21';
  END IF;

  BEGIN
    INSERT INTO neiist.requirement_deliverables (requirement_id, url, label, uploaded_by)
    VALUES (d_id, btrim(d_url), NULLIF(btrim(coalesce(d_label, '')), ''), d_actor)
    RETURNING id INTO v_new;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'O link tem de começar por http:// ou https://.' USING ERRCODE = 'NEI19';
  END;

  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_requirement_deliverable(
  INT, TEXT, TEXT, VARCHAR(50), VARCHAR(30)
) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- Reading them
-- ---------------------------------------------------------------------------------------------

-- Everything one team can see: what it has been asked for, and what it has asked of others.
--
-- Keyed by department in SQL rather than filtered in the route, like every reader in #126. A
-- requerimento is a conversation between exactly two teams, and a third sees nothing — not
-- because a route remembers to check, but because the WHERE clause cannot return it.
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
  created_at       TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.id, r.event_id, e.name,
         CASE WHEN r.target_department = g_department THEN 'inbox' ELSE 'outbox' END,
         r.requesting_department, r.target_department,
         r.title, r.detail, r.deadline, r.status, u.name,
         (SELECT count(*)::INT FROM neiist.requirement_deliverables d
          WHERE d.requirement_id = r.id),
         r.created_at
  FROM neiist.requirements r
  JOIN neiist.internal_events e ON e.id = r.event_id
  LEFT JOIN neiist.users u ON u.istid = r.assignee_istid
  WHERE r.target_department = g_department OR r.requesting_department = g_department
  ORDER BY (r.status IN ('done', 'cancelled')), r.deadline NULLS LAST, r.created_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_requirements(VARCHAR(30)) TO neiist_app_user;

-- One requerimento's deliverables, keyed by requirement AND asking team — same rule as
-- `event_teams` in #219: an id belonging to an unrelated pair returns nothing.
CREATE OR REPLACE FUNCTION neiist.get_requirement_deliverables(
  g_id         INT,
  g_department VARCHAR(30)
) RETURNS TABLE (
  id          INT,
  url         TEXT,
  label       TEXT,
  uploaded_by_name TEXT,
  uploaded_at TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT d.id, d.url, d.label, u.name, d.uploaded_at
  FROM neiist.requirement_deliverables d
  JOIN neiist.requirements r ON r.id = d.requirement_id
  LEFT JOIN neiist.users u ON u.istid = d.uploaded_by
  WHERE d.requirement_id = g_id
    AND (r.target_department = g_department OR r.requesting_department = g_department)
  ORDER BY d.uploaded_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_requirement_deliverables(INT, VARCHAR(30))
  TO neiist_app_user;
