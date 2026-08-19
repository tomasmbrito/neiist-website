-- 001: ON CONFLICT DO NOTHING on the two neiist.user_courses inserts (#146)
--
-- neiist.user_courses has PRIMARY KEY (user_istid, course_name). Fenix returns one registration
-- per *enrolment*, so a student who re-registered for the same degree comes back with that
-- course name twice. Both inserts below then abort the whole surrounding function, which is why
-- a re-registered student could not create an account at all (#120/#122).
--
-- #120 fixed the caller (src/app/api/auth/userdata/route.ts dedupes before calling). This makes
-- the database defend itself instead of trusting every present and future caller — the API is
-- not the only thing that reaches these functions.
--
-- DO NOTHING rather than DO UPDATE: the row is (user_istid, course_name) and nothing else, so a
-- conflicting row is byte-identical to the one being inserted and there is nothing to update.
--
-- Idempotent: both statements are CREATE OR REPLACE FUNCTION over the full body.

CREATE OR REPLACE FUNCTION neiist.add_user(
  p_istid VARCHAR(50),
  p_name TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_alt_email TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_photo_path TEXT DEFAULT NULL,
  p_courses TEXT[] DEFAULT NULL,
  p_github TEXT DEFAULT NULL,
  p_linkedin TEXT DEFAULT NULL
) RETURNS TABLE(
  istid VARCHAR(50),
  name TEXT,
  email TEXT,
  alt_email TEXT,
  phone TEXT,
  preferred_contact_method TEXT,
  photo_path TEXT,
  courses TEXT[],
  roles TEXT[],
  teams VARCHAR(30)[],
  github TEXT,
  linkedin TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO neiist.users (istid, name, email, photo_path, github, linkedin)
  VALUES (p_istid, COALESCE(p_name, 'Unknown'), COALESCE(p_email, p_istid || '@tecnico.ulisboa.pt'), p_photo_path, p_github, p_linkedin);

  -- Insert alternative email if provided
  IF p_alt_email IS NOT NULL THEN
    INSERT INTO neiist.user_contacts (user_istid, contact_type, contact_value)
    VALUES (p_istid, 'alt_email', p_alt_email);
  END IF;

  -- Insert phone if provided
  IF p_phone IS NOT NULL THEN
    INSERT INTO neiist.user_contacts (user_istid, contact_type, contact_value)
    VALUES (p_istid, 'phone', p_phone);
  END IF;

  -- Insert courses if provided
  IF p_courses IS NOT NULL THEN
    INSERT INTO neiist.user_courses (user_istid, course_name)
    SELECT p_istid, unnest(p_courses)
    ON CONFLICT (user_istid, course_name) DO NOTHING;
  END IF;

  RETURN QUERY SELECT * FROM neiist.get_user(p_istid);
END;
$$;

CREATE OR REPLACE FUNCTION neiist.update_user(
  p_istid VARCHAR(50),
  p_updates JSONB
) RETURNS TABLE(
  istid VARCHAR(50),
  name TEXT,
  email TEXT,
  alt_email TEXT,
  phone TEXT,
  preferred_contact_method TEXT,
  photo_path TEXT,
  courses TEXT[],
  roles TEXT[],
  teams VARCHAR(30)[],
  github TEXT,
  linkedin TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Update users table fields
  IF p_updates ? 'name' THEN
    UPDATE neiist.users SET name = p_updates->>'name' WHERE istid = p_istid;
  END IF;
  IF p_updates ? 'email' THEN
    UPDATE neiist.users SET email = p_updates->>'email' WHERE istid = p_istid;
  END IF;
  IF p_updates ? 'photo' THEN
    UPDATE neiist.users SET photo_path = p_updates->>'photo' WHERE istid = p_istid;
  END IF;
  IF p_updates ? 'github' THEN
    UPDATE neiist.users SET github = p_updates->>'github' WHERE neiist.users.istid = p_istid;
  END IF;
  IF p_updates ? 'linkedin' THEN
    UPDATE neiist.users SET linkedin = p_updates->>'linkedin' WHERE neiist.users.istid = p_istid;
  END IF;

  -- Update alternativeEmail in user_contacts
  IF p_updates ? 'alternativeEmail' THEN
    IF p_updates->>'alternativeEmail' IS NULL THEN
      DELETE FROM neiist.user_contacts WHERE user_istid = p_istid AND contact_type = 'alt_email';
    ELSE
      INSERT INTO neiist.user_contacts (user_istid, contact_type, contact_value)
      VALUES (p_istid, 'alt_email', p_updates->>'alternativeEmail')
      ON CONFLICT (user_istid, contact_type) DO UPDATE SET contact_value = EXCLUDED.contact_value;
    END IF;
  END IF;

  -- Update phone in user_contacts
  IF p_updates ? 'phone' THEN
    IF p_updates->>'phone' IS NULL THEN
      DELETE FROM neiist.user_contacts WHERE user_istid = p_istid AND contact_type = 'phone';
    ELSE
      INSERT INTO neiist.user_contacts (user_istid, contact_type, contact_value)
      VALUES (p_istid, 'phone', p_updates->>'phone')
      ON CONFLICT (user_istid, contact_type) DO UPDATE SET contact_value = EXCLUDED.contact_value;
    END IF;
  END IF;

  -- Update preferredContactMethod in user_contacts
  IF p_updates ? 'preferredContactMethod' THEN
    UPDATE neiist.user_contacts SET is_preferred = FALSE WHERE user_istid = p_istid;
    UPDATE neiist.user_contacts
    SET is_preferred = TRUE
    WHERE user_istid = p_istid AND contact_type = (p_updates->>'preferredContactMethod')::neiist.contact_method_enum;
  END IF;

  -- Update courses in user_courses
  IF p_updates ? 'courses' THEN
    DELETE FROM neiist.user_courses WHERE user_istid = p_istid;
    IF jsonb_array_length(p_updates->'courses') > 0 THEN
      INSERT INTO neiist.user_courses (user_istid, course_name)
      SELECT p_istid, value::TEXT
      FROM jsonb_array_elements_text(p_updates->'courses')
      ON CONFLICT (user_istid, course_name) DO NOTHING;
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM neiist.get_user(p_istid);
END;
$$;
