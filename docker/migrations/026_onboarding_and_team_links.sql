-- 026 — Onboarding an accepted candidate, and handing over the team's link (#224, #225).
--
-- Slices D and E of #134. They are one migration because they are one screen: the page that
-- collects what NEIIST needs is also the only place the WhatsApp link is ever shown.
--
-- ## The rule that shapes all of this
--
-- **Onboarding does NOT create the membership.** Decided in #134 and worth restating, because it
-- will be tempting to "just add one line": this page is reachable by a person who is NOT a member,
-- holding a token. A self-service page reachable by a non-member that creates authority is the
-- exact shape of #193. `add_team_member` stays the single path by which a membership comes into
-- existence, and a human runs it. The page gathers; a person adds.
--
-- So nothing here writes to `membership`, `users`, or `valid_department_roles`. It writes to one
-- table that a coordinator reads.

-- ---------------------------------------------------------------------------------------------
-- #225 — the team's own links
-- ---------------------------------------------------------------------------------------------

-- A WhatsApp invite link is a CREDENTIAL IN A URL: anyone holding it joins the group. That single
-- fact drives every decision here.
--
--   * It is per team, and each team's coordinators edit their own (#134: "coordinators rotate
--     their own links and know who they want"). A shared list would go stale and would put every
--     team's invite in one place.
--   * It is never returned by a public route except through an accepted candidate's onboarding
--     token, and never rendered on a page anyone can reach.
--   * Rotating it is one action a coordinator can take without a developer — same principle as
--     #185: the things that change belong in data, not in a deploy.
CREATE TABLE IF NOT EXISTS neiist.team_links (
  department_name VARCHAR(30) PRIMARY KEY REFERENCES neiist.departments(name) ON DELETE CASCADE,
  whatsapp_url    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      VARCHAR(50) REFERENCES neiist.users(istid),

  -- Refuses anything that is not a WhatsApp invite. Not decoration: the field is shown to someone
  -- outside NEIIST, so a mistyped link is a link the núcleo sent a stranger to.
  CONSTRAINT team_link_is_whatsapp_invite CHECK (
    whatsapp_url IS NULL OR whatsapp_url ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]+$'
  )
);

CREATE OR REPLACE FUNCTION neiist.set_team_link(
  l_department VARCHAR(30),
  l_url        TEXT,
  l_actor      VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = l_department) THEN
    RAISE EXCEPTION 'A equipa "%" não existe.', l_department USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.team_links (department_name, whatsapp_url, updated_by)
  VALUES (l_department, NULLIF(btrim(coalesce(l_url, '')), ''), l_actor)
  ON CONFLICT (department_name) DO UPDATE
  SET whatsapp_url = EXCLUDED.whatsapp_url,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'O link tem de ser um convite do WhatsApp (https://chat.whatsapp.com/...).'
    USING ERRCODE = 'NEI19';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_team_link(VARCHAR(30), TEXT, VARCHAR(50))
  TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_team_link(l_department VARCHAR(30))
RETURNS TABLE (whatsapp_url TEXT, updated_at TIMESTAMPTZ, updated_by_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.whatsapp_url, t.updated_at, u.name
  FROM neiist.team_links t
  LEFT JOIN neiist.users u ON u.istid = t.updated_by
  WHERE t.department_name = l_department;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_link(VARCHAR(30)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- #224 — what the accepted candidate fills in
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS neiist.recruitment_onboarding (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  -- What they want to be called, which is often not what is on the application form.
  preferred_name  TEXT NOT NULL,
  phone           TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Cleared when a coordinator has actually added them, so the queue empties.
  completed_at    TIMESTAMPTZ,
  completed_by    VARCHAR(50) REFERENCES neiist.users(istid),

  PRIMARY KEY (application_id, department_name),
  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE,

  CONSTRAINT onboarding_name_not_blank CHECK (btrim(preferred_name) <> '')
);

-- Spend the token and record the answers, in ONE statement's worth of work.
--
-- Atomic on purpose. If the page consumed the token and then inserted, a crash between the two
-- would burn the candidate's only link and record nothing — they would be locked out of their own
-- onboarding with no way back except a coordinator noticing. `consume_onboarding_token` is
-- conditional on the token still being unused, so two simultaneous submissions cannot both win,
-- and the INSERT rides in the same transaction.
--
-- Returns the team's WhatsApp link, because the whole point of the flow is that finishing the form
-- is what hands it over — #225. A candidate who never completes onboarding never sees it.
-- Dropped first: CREATE OR REPLACE cannot change a RETURNS TABLE shape, and re-running a
-- migration must not fail on a database that already has an older signature.
DROP FUNCTION IF EXISTS neiist.complete_onboarding(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION neiist.complete_onboarding(
  o_token_hash     TEXT,
  o_preferred_name TEXT,
  o_phone          TEXT DEFAULT NULL
)
-- The OUT columns are `team` and `invite_url`, NOT `department_name` and `whatsapp_url`: an OUT
-- parameter is a plpgsql variable, and one sharing a name with a column of a table this function
-- reads makes every reference to it ambiguous. Distinct names are cheaper than qualifying every
-- occurrence and remembering to keep doing so.
RETURNS TABLE (team VARCHAR(30), invite_url TEXT) AS $$
DECLARE
  v_application INT;
  v_department  VARCHAR(30);
BEGIN
  IF btrim(coalesce(o_preferred_name, '')) = '' THEN
    RAISE EXCEPTION 'Indica como queres ser tratado(a).' USING ERRCODE = 'NEI19';
  END IF;

  -- Resolve BEFORE spending, but inside the same transaction, so the read and the write cannot be
  -- separated by a crash or by another request.
  SELECT t.application_id, t.department_name INTO v_application, v_department
  FROM neiist.find_onboarding_token(o_token_hash) t;

  IF v_application IS NULL THEN
    RAISE EXCEPTION 'Este link já não é válido.' USING ERRCODE = 'NEI20';
  END IF;

  IF NOT neiist.consume_onboarding_token(o_token_hash) THEN
    -- Somebody else spent it between the read and here. Losing that race means the form was
    -- already submitted, which is a sentence the page can show.
    RAISE EXCEPTION 'Este link já foi usado.' USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.recruitment_onboarding
    (application_id, department_name, preferred_name, phone)
  VALUES (v_application, v_department, btrim(o_preferred_name),
          NULLIF(btrim(coalesce(o_phone, '')), ''))
  ON CONFLICT (application_id, department_name) DO UPDATE
  SET preferred_name = EXCLUDED.preferred_name,
      phone = EXCLUDED.phone,
      submitted_at = NOW();

  -- A scalar subquery, not a LEFT JOIN: the OUT parameter is also called `department_name`, and
  -- joining a table that has that column makes the reference ambiguous inside plpgsql. Qualifying
  -- it inside the subquery keeps the two names apart, and still yields NULL when a team has set
  -- no link — which must not block somebody joining.
  RETURN QUERY
  SELECT v_department,
         (SELECT l.whatsapp_url FROM neiist.team_links l
          WHERE l.department_name = v_department);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.complete_onboarding(TEXT, TEXT, TEXT) TO neiist_app_user;

-- The coordinator's queue: accepted candidates who filled the form and are waiting to be added.
--
-- Department-scoped like every other reader in this family. It carries the phone number, which is
-- personal data — but it is the same team that already reads the application, under the same
-- `team.recruitment.decide` permission, and the number exists precisely so somebody can reach them.
CREATE OR REPLACE FUNCTION neiist.get_pending_onboarding(g_department VARCHAR(30))
RETURNS TABLE (
  application_id INT,
  full_name      TEXT,
  preferred_name TEXT,
  email          TEXT,
  phone          TEXT,
  istid          VARCHAR(50),
  submitted_at   TIMESTAMPTZ,
  suggested_email TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT o.application_id, a.full_name, o.preferred_name, a.email, o.phone, a.istid,
         o.submitted_at,
         -- #213 already knows how to build an @neiist.pt address from a name. Previewing it here
         -- means the coordinator sees what the person will get before creating anything, and the
         -- rule lives in one place.
         neiist.preview_neiist_email(a.full_name)
  FROM neiist.recruitment_onboarding o
  JOIN neiist.recruitment_applications a ON a.id = o.application_id
  WHERE o.department_name = g_department
    AND o.completed_at IS NULL
  ORDER BY o.submitted_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_pending_onboarding(VARCHAR(30)) TO neiist_app_user;

-- Mark somebody as actually added, so the queue empties.
--
-- Records only. It does NOT call add_team_member: creating the membership stays a deliberate act
-- a human performs in the members screen, for the reason at the top of this file.
CREATE OR REPLACE FUNCTION neiist.mark_onboarding_complete(
  m_application INT,
  m_department  VARCHAR(30),
  m_actor       VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.recruitment_onboarding
  SET completed_at = NOW(), completed_by = m_actor
  WHERE application_id = m_application AND department_name = m_department
    AND completed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há nada por tratar para essa candidatura.' USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.mark_onboarding_complete(INT, VARCHAR(30), VARCHAR(50))
  TO neiist_app_user;
