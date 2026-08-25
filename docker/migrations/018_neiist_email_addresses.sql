-- 018: unique @neiist.pt addresses (#213).
--
-- NEIIST is moving to Google Workspace. The site reserves the address and guarantees it is
-- unique; creating the mailbox in Workspace stays a manual step, deliberately — see the issue.
--
-- The address is stored WITHOUT the domain. Storing `ana.silva` rather than `ana.silva@neiist.pt`
-- means the domain lives in one place (the UI), and a future domain change is not a data
-- migration across every row.
ALTER TABLE neiist.users
  ADD COLUMN IF NOT EXISTS neiist_email_local VARCHAR(64);

-- The whole point of this feature. A helper that "generates a unique address" is worth nothing if
-- two concurrent calls can still collide; the constraint is what makes it true.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_neiist_email_local
  ON neiist.users (neiist_email_local)
  WHERE neiist_email_local IS NOT NULL;

-- Fold a name to an email-safe ASCII local-part fragment.
--
-- `unaccent` is not installed and installing it needs superuser, so this uses `translate`, which
-- covers every accented character that occurs in Portuguese names. Verified against the real
-- users table: the only non-ASCII in there today is Portuguese accenting.
--
-- IMMUTABLE truthfully: same input, same output, no reads.
CREATE OR REPLACE FUNCTION neiist.fold_name_part(p_text TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
    lower(translate(
      coalesce(p_text, ''),
      'áàâãäÁÀÂÃÄéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜçÇñÑ',
      'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUcCnN'
    )),
    -- Anything left that is not a-z or a digit goes. Hyphenated surnames ("Multi-Cargo") become
    -- one run; apostrophes and stray punctuation disappear rather than producing an invalid
    -- local-part.
    '[^a-z0-9]', '', 'g'
  );
$$;

-- Build the base local-part from a full name: first given name + last surname.
--
-- Portuguese names carry particles — "Tomás Moreira Luis de Jesus Brito" — and the last WORD is
-- the surname people use, while "de"/"da"/"dos"/"e" are not names at all. Dropping them stops
-- `de.brito` and the like.
--
-- Deliberately NOT the full chain: "tomas.moreira.luis.de.jesus.brito" is nobody's email address.
CREATE OR REPLACE FUNCTION neiist.build_neiist_email_base(p_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_words    TEXT[];
  v_kept     TEXT[] := ARRAY[]::TEXT[];
  v_word     TEXT;
  v_folded   TEXT;
  v_first    TEXT;
  v_last     TEXT;
BEGIN
  v_words := regexp_split_to_array(btrim(coalesce(p_name, '')), '\s+');

  FOREACH v_word IN ARRAY v_words LOOP
    -- Particles are compared AFTER folding, so "De" and "dos" are caught the same way.
    v_folded := neiist.fold_name_part(v_word);
    IF v_folded <> '' AND v_folded NOT IN ('de', 'da', 'do', 'das', 'dos', 'e', 'del', 'di') THEN
      v_kept := array_append(v_kept, v_folded);
    END IF;
  END LOOP;

  IF array_length(v_kept, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  v_first := v_kept[1];
  v_last  := v_kept[array_length(v_kept, 1)];

  -- One usable word ("Prince") gives just that, rather than "prince.prince".
  IF v_first = v_last THEN
    RETURN v_first;
  END IF;

  RETURN v_first || '.' || v_last;
END;
$$;

-- Reserve an address for a user, resolving collisions.
--
-- The collision rule is a numeric suffix — `ana.silva`, then `ana.silva2` — chosen over cleverer
-- schemes (middle names, initials) because it is predictable: nobody has to work out *why* they
-- got the address they got, and the second Ana can be told hers in one sentence.
--
-- SECURITY DEFINER, and it does the read and the write in ONE statement so two concurrent calls
-- cannot both settle on the same suffix. The UNIQUE index is still the authority; this makes the
-- happy path not depend on losing a race.
CREATE OR REPLACE FUNCTION neiist.assign_neiist_email(u_istid VARCHAR(50))
RETURNS TEXT AS $$
DECLARE
  v_name     TEXT;
  v_existing TEXT;
  v_base     TEXT;
  v_candidate TEXT;
  v_suffix   INT := 1;
BEGIN
  SELECT name, neiist_email_local INTO v_name, v_existing
  FROM neiist.users WHERE istid = u_istid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O utilizador não existe.' USING ERRCODE = 'NEI18';
  END IF;

  -- Idempotent: an address already reserved is returned unchanged. Reassigning would silently
  -- change someone's email address, which is exactly the thing that must not happen by accident.
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_base := neiist.build_neiist_email_base(v_name);
  IF v_base IS NULL OR v_base = '' THEN
    RAISE EXCEPTION 'Não foi possível gerar um endereço a partir do nome "%".', v_name
      USING ERRCODE = 'NEI18';
  END IF;

  v_candidate := v_base;
  LOOP
    BEGIN
      UPDATE neiist.users SET neiist_email_local = v_candidate WHERE istid = u_istid;
      RETURN v_candidate;
    EXCEPTION WHEN unique_violation THEN
      -- Taken. Try the next suffix. Bounded so a pathological case cannot spin.
      v_suffix := v_suffix + 1;
      IF v_suffix > 50 THEN
        RAISE EXCEPTION 'Demasiados endereços semelhantes a "%".', v_base USING ERRCODE = 'NEI18';
      END IF;
      v_candidate := v_base || v_suffix::TEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.assign_neiist_email(VARCHAR(50)) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.build_neiist_email_base(TEXT) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.fold_name_part(TEXT) TO neiist_app_user;

-- What an address WOULD be, without reserving it — so the add-member screen can show a preview
-- before anyone commits. Read-only, and deliberately not the same function: a preview that
-- reserved would burn an address every time someone typed a name.
CREATE OR REPLACE FUNCTION neiist.preview_neiist_email(p_name TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH base AS (SELECT neiist.build_neiist_email_base(p_name) AS b)
  SELECT CASE
    WHEN b IS NULL OR b = '' THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM neiist.users WHERE neiist_email_local = b) THEN b
    ELSE b || (
      SELECT min(n) FROM generate_series(2, 51) n
      WHERE NOT EXISTS (
        SELECT 1 FROM neiist.users WHERE neiist_email_local = b || n::TEXT
      )
    )::TEXT
  END
  FROM base;
$$;

GRANT EXECUTE ON FUNCTION neiist.preview_neiist_email(TEXT) TO neiist_app_user;
