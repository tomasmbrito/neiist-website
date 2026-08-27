-- TODO: Add blog tables. Add getter functions.

-- SCHEMA
CREATE SCHEMA IF NOT EXISTS neiist;

-- ROLES
CREATE ROLE neiist_app_user WITH LOGIN PASSWORD 'neiist_app_user_password';

-- PERMISSIONS
GRANT USAGE ON SCHEMA neiist TO neiist_app_user;
REVOKE ALL ON ALL TABLES IN SCHEMA neiist FROM neiist_app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA neiist FROM neiist_app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA neiist TO neiist_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA neiist GRANT EXECUTE ON FUNCTIONS TO neiist_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA neiist REVOKE ALL ON TABLES FROM neiist_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA neiist REVOKE ALL ON SEQUENCES FROM neiist_app_user;

-- ENUM TYPES
CREATE TYPE neiist.user_access_enum AS ENUM (
  'admin',
  'coordinator',
  'shop_manager',
  'member'
);

CREATE TYPE neiist.contact_method_enum AS ENUM (
  'email',
  'alt_email',
  'phone'
);

 CREATE TYPE neiist.shop_stock_type_enum AS ENUM (
  'limited',
  'on_demand'
);

CREATE TYPE neiist.shop_order_status_enum AS ENUM (
  'pending',
  'paid',
  'ready',
  'delivered',
  'cancelled'
);

-- USERS TABLE
CREATE TABLE neiist.users (
  istid VARCHAR(50) PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  github TEXT,
  linkedin TEXT,
  photo_path TEXT
);

-- COURSES TABLE
CREATE TABLE neiist.user_courses (
  user_istid VARCHAR(50) REFERENCES neiist.users(istid),
  course_name TEXT,
  PRIMARY KEY (user_istid, course_name)
);

-- CONTACTS TABLE
CREATE TABLE neiist.user_contacts (
  user_istid VARCHAR(50) REFERENCES neiist.users(istid),
  contact_type neiist.contact_method_enum,
  contact_value TEXT NOT NULL,
  is_preferred BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_istid, contact_type),
  CONSTRAINT valid_contact_value CHECK (
    CASE contact_type
      WHEN 'email' THEN contact_value ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
      WHEN 'alt_email' THEN contact_value ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
      WHEN 'phone' THEN contact_value ~ '^\+?[0-9\s\-\(\)]{7,20}$'
      ELSE TRUE
    END
  )
);

-- Ensure only one preferred contact per user
CREATE UNIQUE INDEX idx_user_preferred_contact
ON neiist.user_contacts (user_istid, is_preferred)
WHERE is_preferred = TRUE;

-- EMAIL TOKEN VERIFICATION
CREATE TABLE neiist.email_token (
  id SERIAL PRIMARY KEY,
  istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- DEPARTMENTS TABLE
CREATE TABLE neiist.departments (
  name VARCHAR(30) PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  department_type VARCHAR(20) CHECK (department_type IN ('team', 'admin_body'))
);

-- TEAMS TABLE
CREATE TABLE neiist.teams (
  name VARCHAR(30) PRIMARY KEY REFERENCES neiist.departments(name),
  description TEXT
);

-- ADMINISTRATION BODIES TABLE
CREATE TABLE neiist.admin_bodies (
  name VARCHAR(30) PRIMARY KEY REFERENCES neiist.departments(name)
);

-- VALID (DEPARTMENT | ROLE) COMBINATIONS TABLE
CREATE TABLE neiist.valid_department_roles (
  department_name VARCHAR(30) REFERENCES neiist.departments(name),
  role_name VARCHAR(40) NOT NULL,
  PRIMARY KEY (department_name, role_name),
  access neiist.user_access_enum NOT NULL DEFAULT 'member',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Does holding this role make someone a member of the Direção? (#217)
  --
  -- Orthogonal to `access` on purpose: it says who they ARE, not how much of the workspace their
  -- role opens. A Diretor de Atividades is on the board and is a `coordinator`; the Tesoureiro is
  -- on the board and is a `member`. Collapsing the two facts into one is what made the board
  -- signature miss the Diretores de Atividades in the first place.
  board_member BOOLEAN NOT NULL DEFAULT FALSE
);

-- MEMBERSHIP TABLE
CREATE TABLE neiist.membership (
  user_istid VARCHAR(50) REFERENCES neiist.users(istid),
  department_name VARCHAR(30) NOT NULL,
  role_name VARCHAR(40) NOT NULL,
  from_date DATE NOT NULL DEFAULT CURRENT_DATE,
  to_date DATE DEFAULT NULL,
  FOREIGN KEY (department_name, role_name)
    REFERENCES neiist.valid_department_roles(department_name, role_name),
  -- >= rather than >, so a membership added and removed the same day is a valid record of a
  -- correction (#181). The invariant that matters — an end never precedes a start — is kept.
  CONSTRAINT valid_member_dates CHECK (to_date IS NULL OR to_date >= from_date),
  PRIMARY KEY (user_istid, department_name, role_name)
);

-- DEPARTMENT MEMBERS HIERARCHY
CREATE TABLE IF NOT EXISTS neiist.department_role_order (
    id SERIAL PRIMARY KEY,
    department_name TEXT NOT NULL REFERENCES neiist.departments(name),
    role_name TEXT NOT NULL,
    position INTEGER NOT NULL,
    CONSTRAINT fk_valid_role FOREIGN KEY (department_name, role_name)
      REFERENCES neiist.valid_department_roles(department_name, role_name),
    UNIQUE (department_name, role_name)
);

-- Ensure perfomance to calculate the access level of a user
CREATE INDEX idx_membership_active ON neiist.membership (user_istid, to_date)
WHERE to_date IS NULL;
CREATE INDEX idx_membership_to_date ON neiist.membership (to_date)
WHERE to_date IS NOT NULL;

-- ACTIVITIES EVENTS TABLE
CREATE TABLE neiist.activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  location TEXT[],
  type TEXT,
  teams TEXT[],
  attendees TEXT[],
  start TIMESTAMPTZ,
  "end" TIMESTAMPTZ,
  all_day BOOLEAN DEFAULT FALSE,
  last_edited_time TIMESTAMPTZ NOT NULL,
  signup_enabled BOOLEAN DEFAULT FALSE,
  signup_deadline TIMESTAMPTZ,
  max_attendees INTEGER,
  custom_icon TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- EVENT SUBSCRIPTIONS
CREATE TABLE neiist.activities_sign_up (
  event_id TEXT NOT NULL REFERENCES neiist.activities(id),
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_istid)
);

-- SHOP CATEGORIES
CREATE TABLE neiist.categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE neiist.discount_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value >= 0),
  valid_product_ids INTEGER[],
  valid_istids TEXT[],
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_discount_codes_max_uses CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT chk_discount_codes_current_uses CHECK (current_uses >= 0)
);

-- PRODUCTS
CREATE TABLE neiist.products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  images TEXT[] NOT NULL DEFAULT '{}',
  category_id INTEGER REFERENCES neiist.categories(id),
  stock_type neiist.shop_stock_type_enum NOT NULL,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT chk_products_stock
    CHECK (
      (stock_type = 'limited' AND (stock_quantity IS NULL OR stock_quantity >= 0))
      OR (stock_type = 'on_demand')
    )
);

-- PRODUCTS VARIANTS
CREATE TABLE neiist.product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES neiist.products(id) ON DELETE CASCADE,
  sku TEXT UNIQUE,
  images TEXT[] NOT NULL DEFAULT '{}',
  price_modifier NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_quantity INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_variant_stock CHECK (stock_quantity IS NULL OR stock_quantity >= 0)
);

-- PRODUCTS VARIANTS OPTIONS
CREATE TABLE neiist.product_variant_options (
  variant_id INTEGER NOT NULL REFERENCES neiist.product_variants(id) ON DELETE CASCADE,
  option_name TEXT NOT NULL,
  option_value TEXT NOT NULL,
  PRIMARY KEY (variant_id, option_name)
);

-- Index for better search performance on products variants
CREATE INDEX idx_product_variants_product ON neiist.product_variants(product_id);
CREATE INDEX idx_variant_options_name ON neiist.product_variant_options(option_name);

-- ORDER NUMBER GENERATOR
CREATE SEQUENCE neiist.order_sequence;

CREATE OR REPLACE FUNCTION neiist.generate_order_number()
RETURNS TEXT AS $$
BEGIN
  RETURN to_char(clock_timestamp(), 'YYYYMMDD') || to_char(nextval('neiist.order_sequence'), 'FM999999');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ORDERS
CREATE TABLE neiist.orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE DEFAULT neiist.generate_order_number(),
  user_istid VARCHAR(50) REFERENCES neiist.users(istid),
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  nif TEXT,
  campus TEXT,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pickup_deadline TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  status neiist.shop_order_status_enum NOT NULL DEFAULT 'pending',
  CONSTRAINT orders_identity_mode_chk CHECK (
    user_istid IS NULL
    OR (customer_name IS NULL AND customer_email IS NULL AND customer_phone IS NULL)
  )
);

CREATE TABLE neiist.order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES neiist.orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES neiist.products(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES neiist.product_variants(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  variant_label TEXT,
  variant_options JSONB,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(10,2) NOT NULL
);

-- Index for better search performance of products on orders
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON neiist.order_items(product_id);

-- Index to speed up lookups by user on orders
CREATE INDEX IF NOT EXISTS idx_orders_user_istid ON neiist.orders(user_istid);

--Triggers

--Resotck Limited stock items on order cancellation
CREATE OR REPLACE FUNCTION neiist.restock_limited_items_on_order_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Defensive guard (trigger WHEN already enforces this transition)
  IF OLD.status = NEW.status OR NEW.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Restock product variants (limited stock only, items with variant_id)
  UPDATE neiist.product_variants AS product_variant
  SET stock_quantity = COALESCE(product_variant.stock_quantity, 0) + variant_restock.quantity_to_restock,
      updated_at = NOW()
  FROM (
    SELECT
      order_item.product_id AS product_id,
      order_item.variant_id AS variant_id,
      SUM(order_item.quantity)::INTEGER AS quantity_to_restock
    FROM neiist.order_items AS order_item
    JOIN neiist.products AS product
      ON product.id = order_item.product_id
    WHERE order_item.order_id = NEW.id
      AND order_item.variant_id IS NOT NULL
      AND product.stock_type = 'limited'
    GROUP BY order_item.product_id, order_item.variant_id
  ) AS variant_restock
  WHERE product_variant.id = variant_restock.variant_id
    AND product_variant.product_id = variant_restock.product_id;

  -- Restock base products (limited stock only, items without variant_id)
  UPDATE neiist.products AS product
  SET stock_quantity = COALESCE(product.stock_quantity, 0) + product_restock.quantity_to_restock
  FROM (
    SELECT
      order_item.product_id AS product_id,
      SUM(order_item.quantity)::INTEGER AS quantity_to_restock
    FROM neiist.order_items AS order_item
    JOIN neiist.products AS product_for_filter
      ON product_for_filter.id = order_item.product_id
    WHERE order_item.order_id = NEW.id
      AND order_item.variant_id IS NULL
      AND product_for_filter.stock_type = 'limited'
    GROUP BY order_item.product_id
  ) AS product_restock
  WHERE product.id = product_restock.product_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_restock_limited_on_cancel
AFTER UPDATE OF status ON neiist.orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'cancelled')
EXECUTE FUNCTION neiist.restock_limited_items_on_order_cancel();

-- Update the name of products on orders
CREATE OR REPLACE FUNCTION neiist.update_order_item_product_name_on_product_rename()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE neiist.order_items oi
    SET product_name = NEW.name
    WHERE oi.product_id = NEW.id
      AND oi.product_name = OLD.name;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_order_item_product_name_on_product_rename
AFTER UPDATE OF name ON neiist.products
FOR EACH ROW
WHEN (OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION neiist.update_order_item_product_name_on_product_rename();

-- FUNCTIONS

-- Get user
CREATE OR REPLACE FUNCTION neiist.get_user_by_email(u_email TEXT)
RETURNS VARCHAR(50) AS $$
  SELECT istid FROM neiist.users WHERE email = u_email LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION neiist.get_user(
  u_istid VARCHAR(50)
) RETURNS TABLE (
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
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.istid,
    u.name,
    u.email,
    (SELECT contact_value FROM neiist.user_contacts WHERE user_istid = u.istid AND contact_type = 'alt_email' LIMIT 1) AS alt_email,
    (SELECT contact_value FROM neiist.user_contacts WHERE user_istid = u.istid AND contact_type = 'phone' LIMIT 1) AS phone,
    (SELECT contact_type::TEXT FROM neiist.user_contacts WHERE user_istid = u.istid AND is_preferred = TRUE LIMIT 1) AS preferred_contact_method,
    u.photo_path,
    ARRAY(SELECT course_name FROM neiist.user_courses WHERE user_istid = u.istid) AS courses,
    COALESCE(derived_access.access_array, ARRAY[]::TEXT[]) AS roles,
    COALESCE(team_list.team_array, ARRAY[]::VARCHAR(30)[]) AS teams,
    u.github,
    u.linkedin
  FROM neiist.users u
  LEFT JOIN (
    SELECT
      m.user_istid,
      array_agg(DISTINCT vdr.access::TEXT) AS access_array
    FROM neiist.membership m
    JOIN neiist.valid_department_roles vdr ON m.department_name = vdr.department_name AND m.role_name = vdr.role_name
    WHERE m.user_istid = u_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND vdr.active = TRUE
    GROUP BY m.user_istid
  ) derived_access ON u.istid = derived_access.user_istid
  LEFT JOIN (
    SELECT
      m.user_istid,
      array_agg(DISTINCT m.department_name) AS team_array
    FROM neiist.membership m
    WHERE m.user_istid = u_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    GROUP BY m.user_istid
  ) team_list ON u.istid = team_list.user_istid
  WHERE u.istid = u_istid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add user
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

  -- Insert courses if provided. Fenix returns one registration per enrolment, so a student who
  -- re-registered for the same degree arrives with that course name twice; without the conflict
  -- clause the (user_istid, course_name) primary key aborts account creation entirely (#146).
  IF p_courses IS NOT NULL THEN
    INSERT INTO neiist.user_courses (user_istid, course_name)
    SELECT p_istid, unnest(p_courses)
    ON CONFLICT (user_istid, course_name) DO NOTHING;
  END IF;

  RETURN QUERY SELECT * FROM neiist.get_user(p_istid);
END;
$$;

-- Add department
CREATE OR REPLACE FUNCTION neiist.add_department(
  u_name VARCHAR(30),
  u_department_type VARCHAR(20)
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM neiist.departments WHERE name = u_name) THEN
    RAISE EXCEPTION 'O departamento "%" já existe.', u_name;
  END IF;

  IF u_department_type NOT IN ('team', 'admin_body') THEN
    RAISE EXCEPTION 'Tipo de departamento inválido. Deve ser "team" ou "admin_body".';
  END IF;
  INSERT INTO neiist.departments (name, department_type) VALUES (u_name, u_department_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove department
CREATE OR REPLACE FUNCTION neiist.remove_department(
  u_name VARCHAR(30)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = u_name) THEN
    RAISE EXCEPTION 'O departamento "%" não existe.', u_name;
  END IF;

  UPDATE neiist.departments SET active = FALSE WHERE name = u_name;
  UPDATE neiist.valid_department_roles SET active = FALSE WHERE department_name = u_name;
  UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE department_name = u_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add team
CREATE OR REPLACE FUNCTION neiist.add_team(
  u_name VARCHAR(30),
  u_description TEXT
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM neiist.teams WHERE name = u_name) THEN
    RAISE EXCEPTION 'A equipa "%" já existe.', u_name;
  END IF;

  INSERT INTO neiist.departments (name, department_type) VALUES (u_name, 'team');
  INSERT INTO neiist.teams (name, description) VALUES (u_name, u_description);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove team
CREATE OR REPLACE FUNCTION neiist.remove_team(
  u_name VARCHAR(30)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.teams WHERE name = u_name) THEN
    RAISE EXCEPTION 'A equipa "%" não existe.', u_name;
  END IF;

  UPDATE neiist.departments SET active = FALSE WHERE name = u_name;
  UPDATE neiist.valid_department_roles SET active = FALSE WHERE department_name = u_name;
  UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE department_name = u_name
    AND (to_date IS NULL OR to_date > CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add administration body
CREATE OR REPLACE FUNCTION neiist.add_admin_body(
  u_name VARCHAR(30)
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM neiist.admin_bodies WHERE name = u_name) THEN
    RAISE EXCEPTION 'O órgão de administração "%" já existe.', u_name;
  END IF;

  INSERT INTO neiist.departments (name, department_type) VALUES (u_name, 'admin_body');
  INSERT INTO neiist.admin_bodies (name) VALUES (u_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove administration body
CREATE OR REPLACE FUNCTION neiist.remove_admin_body(
  u_name VARCHAR(30)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.admin_bodies WHERE name = u_name) THEN
    RAISE EXCEPTION 'O órgão de administração "%" não existe.', u_name;
  END IF;

  UPDATE neiist.departments SET active = FALSE WHERE name = u_name;
  UPDATE neiist.valid_department_roles SET active = FALSE WHERE department_name = u_name;
  UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE department_name = u_name
    AND (to_date IS NULL OR to_date > CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add valid department role
CREATE OR REPLACE FUNCTION neiist.add_valid_department_role(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum DEFAULT 'member'
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = u_department_name AND active = TRUE) THEN
    RAISE EXCEPTION 'O departamento "%" não existe ou não está ativo.', u_department_name;
  END IF;

  INSERT INTO neiist.valid_department_roles (department_name, role_name, access)
  VALUES (u_department_name, u_role_name, u_access);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove valid department role
-- remove_valid_department_role and update_valid_department_role are defined at the end of
-- this file (#158): they depend on count_other_admin_roles.

-- Add team member
CREATE OR REPLACE FUNCTION neiist.add_team_member(
  u_user_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = u_user_istid) THEN
    RAISE EXCEPTION 'O utilizador "%" não existe.', u_user_istid;
  END IF;

  INSERT INTO neiist.membership (user_istid, department_name, role_name)
  VALUES (u_user_istid, u_department_name, u_role_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove team member
CREATE OR REPLACE FUNCTION neiist.remove_team_member(
  u_user_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.membership WHERE user_istid = u_user_istid
    AND department_name = u_department_name AND role_name = u_role_name AND (to_date IS NULL OR to_date > CURRENT_DATE)) THEN
    RAISE EXCEPTION 'O utilizador "%" não tem uma participação ativa como "%" no departamento "%".', u_user_istid, u_role_name, u_department_name;
  END IF;

  UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE user_istid = u_user_istid
    AND department_name = u_department_name AND role_name = u_role_name AND (to_date IS NULL OR to_date > CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get available roles for a department
CREATE OR REPLACE FUNCTION neiist.get_department_roles(u_department_name VARCHAR(30))
RETURNS TABLE (
  role_name VARCHAR(40),
  access neiist.user_access_enum,
  active BOOLEAN,
  board_member BOOLEAN
) AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = u_department_name) THEN
    RAISE EXCEPTION 'O departamento "%" não existe.', u_department_name;
  END IF;

  RETURN QUERY
  SELECT vdr.role_name, vdr.access, vdr.active, vdr.board_member
  FROM neiist.valid_department_roles vdr
  WHERE vdr.department_name = u_department_name
  ORDER BY vdr.access DESC, vdr.role_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get users with a specific access level
CREATE OR REPLACE FUNCTION neiist.get_users_by_access(u_access neiist.user_access_enum)
RETURNS TABLE (
  istid VARCHAR(50),
  name TEXT,
  email TEXT,
  phone VARCHAR(15),
  courses TEXT[],
  photo_path TEXT,
  github TEXT,
  linkedin TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT
    u.istid,
    u.name,
    u.email,
    (SELECT contact_value FROM neiist.user_contacts WHERE user_istid = u.istid AND contact_type = 'phone' LIMIT 1) AS phone,
    ARRAY(SELECT course_name FROM neiist.user_courses WHERE user_istid = u.istid) AS courses,
    u.photo_path,
    u.github,
    u.linkedin
  FROM neiist.users u
  JOIN neiist.membership m ON u.istid = m.user_istid
  JOIN neiist.valid_department_roles vdr ON m.department_name = vdr.department_name AND m.role_name = vdr.role_name
  WHERE vdr.access = u_access
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    AND vdr.active = TRUE
  ORDER BY u.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Gett all users TODO: send alt_email if is prefered contact as the email?
CREATE OR REPLACE FUNCTION neiist.get_all_users()
RETURNS TABLE (
  istid VARCHAR(50),
  name TEXT,
  email TEXT,
  phone TEXT,
  courses TEXT[],
  photo_path TEXT,
  roles TEXT[],
  teams VARCHAR(30)[],
  github TEXT,
  linkedin TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.istid,
    u.name,
    u.email,
    (SELECT contact_value FROM neiist.user_contacts WHERE user_istid = u.istid AND contact_type = 'phone' LIMIT 1) AS phone,
    ARRAY(SELECT course_name FROM neiist.user_courses WHERE user_istid = u.istid) AS courses,
    u.photo_path,
    COALESCE(derived_access.access_array, ARRAY[]::TEXT[]) AS roles,
    COALESCE(user_teams.teams_array, ARRAY[]::VARCHAR(30)[]) as teams,
    u.github,
    u.linkedin
  FROM neiist.users u
  LEFT JOIN (
    SELECT
      m.user_istid,
      array_agg(DISTINCT vdr.access::TEXT) as access_array
    FROM neiist.membership m
    JOIN neiist.valid_department_roles vdr ON m.department_name = vdr.department_name AND m.role_name = vdr.role_name
    WHERE (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND vdr.active = TRUE
    GROUP BY m.user_istid
  ) derived_access ON u.istid = derived_access.user_istid
  LEFT JOIN (
    SELECT
      m.user_istid,
      array_agg(DISTINCT m.department_name) as teams_array
    FROM neiist.membership m
    WHERE m.to_date IS NULL OR m.to_date > CURRENT_DATE
    GROUP BY m.user_istid
  ) user_teams ON u.istid = user_teams.user_istid
  ORDER BY
    CASE
      WHEN 'admin' = ANY(COALESCE(derived_access.access_array, ARRAY[]::TEXT[])) THEN 1
      WHEN 'coordinator' = ANY(COALESCE(derived_access.access_array, ARRAY[]::TEXT[])) THEN 2
      WHEN 'member' = ANY(COALESCE(derived_access.access_array, ARRAY[]::TEXT[])) THEN 3
      ELSE 4
    END,
    u.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update user data
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

-- Update user photo path
CREATE OR REPLACE FUNCTION neiist.update_user_photo(
  p_istid VARCHAR(50),
  p_photo_data TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE neiist.users
  SET photo_path = p_photo_data
  WHERE istid = p_istid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User with istid % not found', p_istid;
  END IF;
END;
$$;

-- Create a new email verification request
CREATE OR REPLACE FUNCTION neiist.add_email_verification(
  p_istid VARCHAR(50),
  p_email TEXT,
  p_token TEXT,
  p_expires_at TIMESTAMPTZ
) RETURNS VOID AS $$
BEGIN
  INSERT INTO neiist.email_token (istid, email, token, expires_at)
  VALUES (p_istid, p_email, p_token, p_expires_at);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get verification request by token
CREATE OR REPLACE FUNCTION neiist.get_email_verification(
  p_token TEXT
) RETURNS TABLE(istid VARCHAR(50), email TEXT, expires_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY SELECT email_token.istid, email_token.email, email_token.expires_at
  FROM neiist.email_token
  WHERE email_token.token = p_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove a verification request
CREATE OR REPLACE FUNCTION neiist.delete_email_verification(
  p_token TEXT
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.email_token WHERE token = p_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get verification request by user
CREATE OR REPLACE FUNCTION neiist.get_email_verification_by_user(
  p_istid VARCHAR(50)
) RETURNS TABLE(email TEXT, expires_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  SELECT email_token.email, email_token.expires_at
  FROM neiist.email_token
  WHERE email_token.istid = p_istid
    AND email_token.expires_at > NOW()
  ORDER BY email_token.expires_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all departments
CREATE OR REPLACE FUNCTION neiist.get_all_departments()
RETURNS TABLE (
  name VARCHAR(30),
  department_type VARCHAR(20),
  active BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT d.name, d.department_type, d.active
  FROM neiist.departments d
  ORDER BY d.department_type, d.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all teams
CREATE OR REPLACE FUNCTION neiist.get_all_teams()
RETURNS TABLE (
  name VARCHAR(30),
  description TEXT,
  active BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT t.name, t.description, d.active
    FROM neiist.teams t
    JOIN neiist.departments d ON t.name = d.name
    ORDER BY t.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all admin bodies
CREATE OR REPLACE FUNCTION neiist.get_all_admin_bodies()
RETURNS TABLE (
  name VARCHAR(30),
  active BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT ab.name, d.active
    FROM neiist.admin_bodies ab
    JOIN neiist.departments d ON ab.name = d.name
    ORDER BY ab.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all valid department roles (useful for admin interface)
CREATE OR REPLACE FUNCTION neiist.get_all_valid_department_roles()
RETURNS TABLE (
  department_name VARCHAR(30),
  department_type VARCHAR(20),
  role_name VARCHAR(40),
  access neiist.user_access_enum,
  active BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT vdr.department_name, d.department_type, vdr.role_name, vdr.access, vdr.active
  FROM neiist.valid_department_roles vdr
  JOIN neiist.departments d ON vdr.department_name = d.name
  ORDER BY d.department_type, vdr.department_name, vdr.access DESC, vdr.role_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all memberships (useful for admin interface)
CREATE OR REPLACE FUNCTION neiist.get_all_memberships()
RETURNS TABLE (
  user_istid VARCHAR(50),
  user_name TEXT,
  department_name VARCHAR(30),
  department_type VARCHAR(20),
  role_name VARCHAR(40),
  from_date DATE,
  to_date DATE,
  active BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.user_istid,
    u.name as user_name,
    m.department_name,
    d.department_type,
    m.role_name,
    m.from_date,
    m.to_date,
    CASE
      WHEN m.to_date IS NULL OR m.to_date > CURRENT_DATE THEN TRUE
      ELSE FALSE
    END as active
  FROM neiist.membership m
  JOIN neiist.users u ON m.user_istid = u.istid
  JOIN neiist.departments d ON m.department_name = d.name
  ORDER BY u.name, d.department_type, m.department_name, m.role_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get hierarchy for a department
CREATE OR REPLACE FUNCTION neiist.get_department_role_order(
    p_department TEXT
) RETURNS TABLE(role_name TEXT, "position" INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT department_role_order.role_name, department_role_order."position"
    FROM neiist.department_role_order
    WHERE department_role_order.department_name = p_department;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Set hierarchy for a department
CREATE OR REPLACE FUNCTION neiist.set_department_role_order(
    p_department TEXT,
    p_roles TEXT[]
) RETURNS VOID AS $$
BEGIN
    DELETE FROM neiist.department_role_order
    WHERE department_name = p_department;

    INSERT INTO neiist.department_role_order (department_name, role_name, position)
    SELECT p_department, role, idx
    FROM unnest(p_roles) WITH ORDINALITY AS t(role, idx);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update Activities/Events
CREATE OR REPLACE FUNCTION neiist.update_activities(
  p_id TEXT,
  p_title TEXT,
  p_description TEXT,
  p_url TEXT,
  p_location TEXT[],
  p_type TEXT,
  p_teams TEXT[],
  p_attendees TEXT[],
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_all_day BOOLEAN,
  p_last_edited_time TIMESTAMPTZ
) RETURNS VOID AS $$
BEGIN
  INSERT INTO neiist.activities (
    id, title, description, url, location, type, teams, attendees,
    start, "end", all_day, last_edited_time, updated_at
  )
  VALUES (
    p_id, p_title, p_description, p_url, p_location, p_type, p_teams, p_attendees,
    p_start, p_end, p_all_day, p_last_edited_time, NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    description = COALESCE(neiist.activities.description, EXCLUDED.description),
    url = EXCLUDED.url,
    location = EXCLUDED.location,
    type = EXCLUDED.type,
    teams = EXCLUDED.teams,
    attendees = EXCLUDED.attendees,
    start = EXCLUDED.start,
    "end" = EXCLUDED."end",
    all_day = EXCLUDED.all_day,
    last_edited_time = EXCLUDED.last_edited_time,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Subscribe user to event
CREATE OR REPLACE FUNCTION neiist.sign_up_to_event(
  p_event_id TEXT,
  p_user_istid VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.activities WHERE id = p_event_id) THEN
    RAISE EXCEPTION 'Event % does not exist', p_event_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = p_user_istid) THEN
    RAISE EXCEPTION 'User % does not exist', p_user_istid;
  END IF;

  INSERT INTO neiist.activities_sign_up (event_id, user_istid)
  VALUES (p_event_id, p_user_istid)
  ON CONFLICT (event_id, user_istid) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unsubscribe user from event
CREATE OR REPLACE FUNCTION neiist.remove_sign_up_from_event(
  p_event_id TEXT,
  p_user_istid VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.activities_sign_up
  WHERE event_id = p_event_id AND user_istid = p_user_istid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all activities/events
CREATE OR REPLACE FUNCTION neiist.get_all_activities()
RETURNS TABLE (
  id TEXT,
  title TEXT,
  description TEXT,
  url TEXT,
  location TEXT[],
  type TEXT,
  teams TEXT[],
  attendees TEXT[],
  start TIMESTAMPTZ,
  "end" TIMESTAMPTZ,
  all_day BOOLEAN,
  last_edited_time TIMESTAMPTZ,
  signup_enabled BOOLEAN,
  signup_deadline TIMESTAMPTZ,
  max_attendees INTEGER,
  custom_icon TEXT,
  subscribers VARCHAR(50)[],
  subscriber_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.title,
    e.description,
    e.url,
    e.location,
    e.type,
    e.teams,
    e.attendees,
    e.start,
    e."end",
    e.all_day,
    e.last_edited_time,
    e.signup_enabled,
    e.signup_deadline,
    e.max_attendees,
    e.custom_icon,
    COALESCE(
      ARRAY_AGG(es.user_istid ORDER BY es.signed_up_at) FILTER (WHERE es.user_istid IS NOT NULL),
      ARRAY[]::VARCHAR(50)[]
    ) AS subscribers,
    COUNT(es.user_istid) AS subscriber_count
  FROM neiist.activities e
  LEFT JOIN neiist.activities_sign_up es ON e.id = es.event_id
  WHERE e.start IS NOT NULL
  GROUP BY e.id, e.title, e.description, e.url, e.location, e.type,
           e.teams, e.attendees, e.start, e."end", e.all_day, e.last_edited_time,
           e.signup_enabled, e.signup_deadline, e.max_attendees, e.custom_icon
  ORDER BY e.start ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update event properties (admin only)
CREATE OR REPLACE FUNCTION neiist.update_activity_properties(
  p_id TEXT,
  p_signup_enabled BOOLEAN,
  p_signup_deadline TIMESTAMPTZ,
  p_max_attendees INTEGER,
  p_custom_icon TEXT,
  p_description TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.activities
  SET
    signup_enabled = p_signup_enabled,
    signup_deadline = p_signup_deadline,
    max_attendees = p_max_attendees,
    custom_icon = p_custom_icon,
    description = COALESCE(p_description, description),
    updated_at = NOW()
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get subscribers for an event with user details
CREATE OR REPLACE FUNCTION neiist.get_event_subscribers(p_event_id TEXT)
RETURNS TABLE (
  istid VARCHAR(50),
  name TEXT,
  email TEXT,
  signed_up_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.istid,
    u.name,
    COALESCE(
      CASE
        WHEN uc.is_preferred = TRUE AND uc.contact_type = 'alt_email'
        THEN uc.contact_value
        ELSE u.email
      END,
      u.email
    ) AS email,
    es.signed_up_at as signed_up_at
  FROM neiist.activities_sign_up es
  JOIN neiist.users u ON es.user_istid = u.istid
  LEFT JOIN neiist.user_contacts uc ON u.istid = uc.user_istid
    AND uc.contact_type = 'alt_email'
    AND uc.is_preferred = TRUE
  WHERE es.event_id = p_event_id
  ORDER BY es.signed_up_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete activity/event by ID
CREATE OR REPLACE FUNCTION neiist.delete_activities(p_id TEXT)
RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.activities WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- GET OR CREATE A CATEGORY
CREATE OR REPLACE FUNCTION neiist.get_or_create_category(p_name TEXT)
RETURNS TABLE (
  category_id INTEGER,
  category_name TEXT
) AS $$
DECLARE
  v_category_id INTEGER;
  v_clean_name TEXT;
BEGIN
  v_clean_name := BTRIM(p_name);
  IF v_clean_name IS NULL OR LENGTH(v_clean_name) = 0 THEN
    RETURN;
  END IF;
  SELECT c.id INTO v_category_id
  FROM neiist.categories c
  WHERE LOWER(c.name) = LOWER(v_clean_name);
  IF v_category_id IS NULL THEN
    INSERT INTO neiist.categories (name)
    VALUES (v_clean_name)
    RETURNING neiist.categories.id INTO v_category_id;
  END IF;

  RETURN QUERY
  SELECT v_category_id, v_clean_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a new product and varients if existent
CREATE OR REPLACE FUNCTION neiist.add_product(
  p_name TEXT,
  p_description TEXT,
  p_price NUMERIC(10,2),
  p_images TEXT[],
  p_category TEXT,
  p_stock_type neiist.shop_stock_type_enum,
  p_stock_quantity INTEGER,
  p_order_deadline TIMESTAMPTZ,
  p_active BOOLEAN DEFAULT TRUE
) RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  variants JSONB
) AS $$
DECLARE
  v_cat_id INTEGER;
  v_id INTEGER;
BEGIN
  IF p_category IS NOT NULL AND length(trim(p_category)) > 0 THEN
   SELECT category_id INTO v_cat_id FROM neiist.get_or_create_category(p_category);
  END IF;

  INSERT INTO neiist.products(
    name, description, price, images, category_id, stock_type, stock_quantity,
    order_deadline, active
  ) VALUES (
    p_name, p_description, p_price, COALESCE(p_images,'{}'),
    v_cat_id, p_stock_type, p_stock_quantity, p_order_deadline, COALESCE(p_active, TRUE)
  )
  RETURNING products.id INTO v_id;

  RETURN QUERY
  SELECT
    pr.id,
    pr.name,
    pr.description,
    pr.price,
    pr.images,
    c.name AS category,
    pr.stock_type::TEXT,
    pr.stock_quantity,
    pr.order_deadline,
    '[]'::JSONB AS variants
  FROM neiist.products pr
  LEFT JOIN neiist.categories c ON c.id = pr.category_id
  WHERE pr.id = v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add a new product varient
CREATE OR REPLACE FUNCTION neiist.add_product_variant(
  p_product_id INTEGER,
  p_sku TEXT,
  p_images TEXT[],
  p_price_modifier NUMERIC(10,2),
  p_stock_quantity INTEGER,
  p_active BOOLEAN DEFAULT TRUE,
  p_options JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  variants JSONB
) AS $$
DECLARE
  v_product neiist.products%ROWTYPE;
  v_category TEXT;
  v_variant_id INTEGER;
  kv RECORD;
BEGIN
  SELECT * INTO v_product
  FROM neiist.products p
  WHERE p.id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;

  INSERT INTO neiist.product_variants(
    product_id, sku, images, price_modifier, stock_quantity, active
  ) VALUES (
    p_product_id, NULLIF(p_sku,''), COALESCE(p_images, '{}'),
    COALESCE(p_price_modifier, 0), p_stock_quantity, COALESCE(p_active, TRUE)
  )
  RETURNING neiist.product_variants.id INTO v_variant_id;

  IF p_options IS NOT NULL AND jsonb_typeof(p_options) = 'object' THEN
    FOR kv IN SELECT key, value FROM jsonb_each(p_options)
    LOOP
      INSERT INTO neiist.product_variant_options(variant_id, option_name, option_value)
      VALUES (v_variant_id, kv.key, kv.value #>> '{}')
      ON CONFLICT (variant_id, option_name) DO UPDATE
      SET option_value = EXCLUDED.option_value;
    END LOOP;
  END IF;

  SELECT c.name INTO v_category
  FROM neiist.categories c
  WHERE c.id = v_product.category_id;

  RETURN QUERY
  SELECT
    v_product.id,
    v_product.name,
    v_product.description,
    v_product.price,
    v_product.images,
    v_category,
    v_product.stock_type::TEXT,
    v_product.stock_quantity,
    v_product.order_deadline,
    (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', pv.id,
          'sku', pv.sku,
          'images', pv.images,
          'price_modifier', pv.price_modifier,
          'stock_quantity', pv.stock_quantity,
          'active', pv.active,
          'options', COALESCE((
              SELECT jsonb_object_agg(pvo.option_name, pvo.option_value)
              FROM neiist.product_variant_options pvo
              WHERE pvo.variant_id = pv.id
            ), '{}'::jsonb),
          'label', NULLIF((
              SELECT string_agg(pvo.option_name || ': ' || pvo.option_value, ' | ' ORDER BY pvo.option_name)
              FROM neiist.product_variant_options pvo
              WHERE pvo.variant_id = pv.id
            ), '')
        )
      ORDER BY pv.id), '[]'::JSONB)
      FROM neiist.product_variants pv
      WHERE pv.product_id = v_product.id
    ) AS variants;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all available products
CREATE OR REPLACE FUNCTION neiist.get_all_products()
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  variants JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.name, p.description, p.price, p.images,
    c.name AS category,
    p.stock_type::TEXT, p.stock_quantity, p.order_deadline,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'sku', v.sku,
          'images', v.images,
          'price_modifier', v.price_modifier,
          'stock_quantity', v.stock_quantity,
          'active', v.active,
          'options', COALESCE((
              SELECT jsonb_object_agg(vo.option_name, vo.option_value)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '{}'::jsonb),
          'label', NULLIF((
              SELECT string_agg(vo.option_name || ': ' || vo.option_value, ' | ' ORDER BY vo.option_name)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '')
        )
        ORDER BY v.id
      )
      FROM neiist.product_variants v
      WHERE v.product_id = p.id
    ), '[]'::JSONB) AS variants
  FROM neiist.products p
  LEFT JOIN neiist.categories c ON c.id = p.category_id
  WHERE p.active = TRUE
  ORDER BY p.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get a product
CREATE OR REPLACE FUNCTION neiist.get_product(p_product_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  variants JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.name, p.description, p.price, p.images,
    c.name AS category,
    p.stock_type::TEXT, p.stock_quantity, p.order_deadline,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'sku', v.sku,
          'images', v.images,
          'price_modifier', v.price_modifier,
          'stock_quantity', v.stock_quantity,
          'active', v.active,
          'options', COALESCE((
              SELECT jsonb_object_agg(vo.option_name, vo.option_value)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '{}'::jsonb),
          'label', NULLIF((
              SELECT string_agg(vo.option_name || ': ' || vo.option_value, ' | ' ORDER BY vo.option_name)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '')
        )
        ORDER BY v.id
      )
      FROM neiist.product_variants v
      WHERE v.product_id = p.id
    ), '[]'::JSONB) AS variants
  FROM neiist.products p
  LEFT JOIN neiist.categories c ON c.id = p.category_id
  WHERE p.id = p_product_id
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update a product data
CREATE OR REPLACE FUNCTION neiist.update_product(
  p_product_id INTEGER,
  p_updates JSONB
) RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  variants JSONB
) AS $$
DECLARE
  v_cat_id INTEGER;
BEGIN
  IF p_updates ? 'category' AND p_updates->>'category' IS NOT NULL AND TRIM(p_updates->>'category') != '' THEN
    SELECT category_id INTO v_cat_id FROM neiist.get_or_create_category(p_updates->>'category');
    UPDATE neiist.products SET category_id = v_cat_id WHERE products.id = p_product_id;
  END IF;

  IF p_updates ? 'name' THEN
    UPDATE neiist.products SET name = p_updates->>'name' WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'description' THEN
    UPDATE neiist.products SET description = NULLIF(p_updates->>'description','') WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'price' THEN
    UPDATE neiist.products SET price = (p_updates->>'price')::NUMERIC WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'images' THEN
    UPDATE neiist.products SET images = COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_updates->'images')), '{}') WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'stock_type' THEN
    UPDATE neiist.products SET stock_type = (p_updates->>'stock_type')::neiist.shop_stock_type_enum WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'stock_quantity' THEN
    UPDATE neiist.products SET stock_quantity = NULLIF(p_updates->>'stock_quantity','')::INTEGER WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'order_deadline' THEN
    UPDATE neiist.products SET order_deadline = NULLIF(p_updates->>'order_deadline','')::TIMESTAMPTZ WHERE products.id = p_product_id;
  END IF;
  IF p_updates ? 'active' THEN
    UPDATE neiist.products SET active = (p_updates->>'active')::BOOLEAN WHERE products.id = p_product_id;
  END IF;

  RETURN QUERY SELECT * FROM neiist.get_product(p_product_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update a product varient data
CREATE OR REPLACE FUNCTION neiist.update_product_variant(
  p_variant_id INTEGER,
  p_updates JSONB
) RETURNS TABLE (
  id INTEGER,
  product_id INTEGER,
  sku TEXT,
  images TEXT[],
  price_modifier NUMERIC(10,2),
  stock_quantity INTEGER,
  active BOOLEAN,
  options JSONB,
  label TEXT
) AS $$
DECLARE
  kv RECORD;
BEGIN
  IF p_updates ? 'sku' THEN
    UPDATE neiist.product_variants SET sku = NULLIF(p_updates->>'sku','') WHERE product_variants.id = p_variant_id;
  END IF;
  IF p_updates ? 'images' THEN
    UPDATE neiist.product_variants SET images = COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_updates->'images')), '{}') WHERE product_variants.id = p_variant_id;
  END IF;
  IF p_updates ? 'price_modifier' THEN
    UPDATE neiist.product_variants SET price_modifier = (p_updates->>'price_modifier')::NUMERIC WHERE product_variants.id = p_variant_id;
  END IF;
  IF p_updates ? 'stock_quantity' THEN
    UPDATE neiist.product_variants SET stock_quantity = NULLIF(p_updates->>'stock_quantity','')::INTEGER WHERE product_variants.id = p_variant_id;
  END IF;
  IF p_updates ? 'active' THEN
    UPDATE neiist.product_variants SET active = (p_updates->>'active')::BOOLEAN WHERE product_variants.id = p_variant_id;
  END IF;

  IF p_updates ? 'options' THEN
    DELETE FROM neiist.product_variant_options WHERE variant_id = p_variant_id;
    IF p_updates->'options' IS NOT NULL AND jsonb_typeof(p_updates->'options') = 'object' THEN
      FOR kv IN SELECT key, value FROM jsonb_each(p_updates->'options')
      LOOP
      INSERT INTO neiist.product_variant_options(variant_id, option_name, option_value)
      VALUES (p_variant_id, kv.key, kv.value #>> '{}');
      END LOOP;
    END IF;
  END IF;

  UPDATE neiist.product_variants SET updated_at = NOW() WHERE product_variants.id = p_variant_id;

  RETURN QUERY
  SELECT
    v.id,
    v.product_id,
    v.sku,
    v.images,
    v.price_modifier,
    v.stock_quantity,
    v.active,
    COALESCE((
      SELECT jsonb_object_agg(vo.option_name, vo.option_value)
      FROM neiist.product_variant_options vo
      WHERE vo.variant_id = v.id
    ), '{}'::jsonb) AS options,
    NULLIF((
      SELECT string_agg(vo.option_name || ': ' || vo.option_value, ' | ' ORDER BY vo.option_name)
      FROM neiist.product_variant_options vo
      WHERE vo.variant_id = v.id
    ), '') AS label
  FROM neiist.product_variants v
  WHERE v.id = p_variant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all products including archived ones (admin view)
CREATE OR REPLACE FUNCTION neiist.get_all_products_including_archived()
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  description TEXT,
  price NUMERIC(10,2),
  images TEXT[],
  category TEXT,
  stock_type TEXT,
  stock_quantity INTEGER,
  order_deadline TIMESTAMPTZ,
  active BOOLEAN,
  variants JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.name, p.description, p.price, p.images,
    c.name AS category,
    p.stock_type::TEXT, p.stock_quantity, p.order_deadline,
    p.active,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'sku', v.sku,
          'images', v.images,
          'price_modifier', v.price_modifier,
          'stock_quantity', v.stock_quantity,
          'active', v.active,
          'options', COALESCE((
              SELECT jsonb_object_agg(vo.option_name, vo.option_value)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '{}'::jsonb),
          'label', NULLIF((
              SELECT string_agg(vo.option_name || ': ' || vo.option_value, ' | ' ORDER BY vo.option_name)
              FROM neiist.product_variant_options vo
              WHERE vo.variant_id = v.id
            ), '')
        )
        ORDER BY v.id
      )
      FROM neiist.product_variants v
      WHERE v.product_id = p.id
    ), '[]'::JSONB) AS variants
  FROM neiist.products p
  LEFT JOIN neiist.categories c ON c.id = p.category_id
  ORDER BY p.active DESC, p.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Permanently delete a product and all its variants (hard delete)
CREATE OR REPLACE FUNCTION neiist.delete_product(p_product_id INTEGER)
RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.products WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Permanently delete a single product variant (hard delete)
CREATE OR REPLACE FUNCTION neiist.delete_product_variant(p_variant_id INTEGER)
RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.product_variants WHERE id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Variant % not found', p_variant_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add discount code
CREATE OR REPLACE FUNCTION neiist.add_discount_code(
  p_code TEXT,
  p_discount_type TEXT,
  p_discount_value NUMERIC,
  p_valid_product_ids INTEGER[] DEFAULT NULL,
  p_valid_istids TEXT[] DEFAULT NULL,
  p_max_uses INTEGER DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_active BOOLEAN DEFAULT TRUE
) RETURNS TABLE (
  id INTEGER,
  code TEXT,
  discount_type TEXT,
  discount_value NUMERIC(10,2),
  valid_product_ids INTEGER[],
  valid_istids TEXT[],
  max_uses INTEGER,
  current_uses INTEGER,
  expires_at TIMESTAMPTZ,
  active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
DECLARE
  v_code TEXT;
BEGIN
  v_code := UPPER(BTRIM(p_code));

  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Discount code is required';
  END IF;

  IF p_discount_type NOT IN ('percentage', 'fixed') THEN
    RAISE EXCEPTION 'Invalid discount type';
  END IF;

  INSERT INTO neiist.discount_codes (
    code,
    discount_type,
    discount_value,
    valid_product_ids,
    valid_istids,
    max_uses,
    expires_at,
    active
  )
  VALUES (
    v_code,
    p_discount_type,
    ROUND(COALESCE(p_discount_value, 0), 2),
    NULLIF(p_valid_product_ids, '{}'),
    NULLIF(p_valid_istids, '{}'),
    p_max_uses,
    p_expires_at,
    COALESCE(p_active, TRUE)
  )
  RETURNING
    discount_codes.id,
    discount_codes.code,
    discount_codes.discount_type,
    discount_codes.discount_value,
    discount_codes.valid_product_ids,
    discount_codes.valid_istids,
    discount_codes.max_uses,
    discount_codes.current_uses,
    discount_codes.expires_at,
    discount_codes.active,
    discount_codes.created_at,
    discount_codes.updated_at
  INTO
    id,
    code,
    discount_type,
    discount_value,
    valid_product_ids,
    valid_istids,
    max_uses,
    current_uses,
    expires_at,
    active,
    created_at,
    updated_at;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update discount code
CREATE OR REPLACE FUNCTION neiist.update_discount_code(
  p_discount_code_id INTEGER,
  p_updates JSONB
) RETURNS TABLE (
  id INTEGER,
  code TEXT,
  discount_type TEXT,
  discount_value NUMERIC(10,2),
  valid_product_ids INTEGER[],
  valid_istids TEXT[],
  max_uses INTEGER,
  current_uses INTEGER,
  expires_at TIMESTAMPTZ,
  active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  UPDATE neiist.discount_codes
  SET
    code = COALESCE(UPPER(BTRIM(NULLIF(p_updates->>'code', ''))), code),
    discount_type = COALESCE(NULLIF(p_updates->>'discount_type', ''), discount_type),
    discount_value = COALESCE(ROUND(NULLIF(p_updates->>'discount_value', '')::NUMERIC, 2), discount_value),
    valid_product_ids = CASE
      WHEN p_updates ? 'valid_product_ids' THEN (
        SELECT COALESCE(array_agg(value::INTEGER), '{}'::INTEGER[])
        FROM jsonb_array_elements_text(COALESCE(p_updates->'valid_product_ids', '[]'::jsonb)) AS value
      )
      ELSE valid_product_ids
    END,
    valid_istids = CASE
      WHEN p_updates ? 'valid_istids' THEN (
        SELECT COALESCE(array_agg(value::TEXT), '{}'::TEXT[])
        FROM jsonb_array_elements_text(COALESCE(p_updates->'valid_istids', '[]'::jsonb)) AS value
      )
      ELSE valid_istids
    END,
    max_uses = COALESCE(NULLIF(p_updates->>'max_uses', '')::INTEGER, max_uses),
    expires_at = CASE
      WHEN p_updates ? 'expires_at' THEN NULLIF(p_updates->>'expires_at', '')::TIMESTAMPTZ
      ELSE expires_at
    END,
    active = COALESCE(NULLIF(p_updates->>'active', '')::BOOLEAN, active),
    updated_at = NOW()
  WHERE id = p_discount_code_id
  RETURNING
    discount_codes.id,
    discount_codes.code,
    discount_codes.discount_type,
    discount_codes.discount_value,
    discount_codes.valid_product_ids,
    discount_codes.valid_istids,
    discount_codes.max_uses,
    discount_codes.current_uses,
    discount_codes.expires_at,
    discount_codes.active,
    discount_codes.created_at,
    discount_codes.updated_at
  INTO
    id,
    code,
    discount_type,
    discount_value,
    valid_product_ids,
    valid_istids,
    max_uses,
    current_uses,
    expires_at,
    active,
    created_at,
    updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discount code % not found', p_discount_code_id;
  END IF;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete discount code
CREATE OR REPLACE FUNCTION neiist.delete_discount_code(
  p_discount_code_id INTEGER
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.discount_codes WHERE id = p_discount_code_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discount code % not found', p_discount_code_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all discount codes
CREATE OR REPLACE FUNCTION neiist.get_all_discount_codes()
RETURNS TABLE (
  id INTEGER,
  code TEXT,
  discount_type TEXT,
  discount_value NUMERIC,
  valid_product_ids INTEGER[],
  valid_istids TEXT[],
  max_uses INTEGER,
  current_uses INTEGER,
  expires_at TIMESTAMPTZ,
  active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    discount_codes.id,
    discount_codes.code,
    discount_codes.discount_type,
    discount_codes.discount_value,
    discount_codes.valid_product_ids,
    discount_codes.valid_istids,
    discount_codes.max_uses,
    discount_codes.current_uses,
    discount_codes.expires_at,
    discount_codes.active,
    discount_codes.created_at,
    discount_codes.updated_at
  FROM neiist.discount_codes
  ORDER BY id DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Validate discount code
CREATE OR REPLACE FUNCTION neiist.validate_discount_code(
  p_code TEXT,
  p_user_istid VARCHAR(50),
  p_cart_items JSONB
) RETURNS TABLE (
  is_valid BOOLEAN,
  discount_code_id INTEGER,
  discount_code TEXT,
  discount_type TEXT,
  discount_value NUMERIC(10,2),
  discount_amount NUMERIC(10,2),
  error TEXT
) AS $$
DECLARE
  v_code TEXT;
  v_discount neiist.discount_codes%ROWTYPE;
  it JSONB;
  v_pid INTEGER;
  v_vid INTEGER;
  v_qty INTEGER;
  v_price NUMERIC(10,2);
  v_modifier NUMERIC(10,2);
  v_unit NUMERIC(10,2);
  v_eligible_total NUMERIC(10,2) := 0;
  v_has_cart BOOLEAN := FALSE;
  v_matching_items BOOLEAN := FALSE;
BEGIN
  v_code := UPPER(BTRIM(COALESCE(p_code, '')));

  IF v_code = '' THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, NULL::TEXT, NULL::TEXT, NULL::NUMERIC(10,2), 0::NUMERIC(10,2), 'Discount code is required';
    RETURN;
  END IF;

  SELECT * INTO v_discount
  FROM neiist.discount_codes
  WHERE UPPER(code) = v_code;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, v_code, NULL::TEXT, NULL::NUMERIC(10,2), 0::NUMERIC(10,2), 'Discount code not found';
    RETURN;
  END IF;

  IF NOT v_discount.active THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code not found or inactive';
    RETURN;
  END IF;

  IF v_discount.expires_at IS NOT NULL AND NOW() > v_discount.expires_at THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code expired';
    RETURN;
  END IF;

  IF v_discount.max_uses IS NOT NULL AND v_discount.current_uses >= v_discount.max_uses THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code max uses reached';
    RETURN;
  END IF;

  IF v_discount.valid_istids IS NOT NULL AND COALESCE(array_length(v_discount.valid_istids, 1), 0) > 0 THEN
    IF p_user_istid IS NULL OR NOT EXISTS (
      SELECT 1
      FROM unnest(v_discount.valid_istids) AS allowed_istid
      WHERE LOWER(BTRIM(allowed_istid)) = LOWER(BTRIM(p_user_istid))
    ) THEN
      RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code not valid for user';
      RETURN;
    END IF;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_cart_items, '[]'::jsonb))
  LOOP
    v_has_cart := TRUE;
    v_pid := (it->>'product_id')::INTEGER;
    v_vid := NULLIF(it->>'variant_id', '')::INTEGER;
    v_qty := COALESCE((it->>'quantity')::INTEGER, 0);

    IF v_qty <= 0 THEN
      RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Invalid quantity in cart';
      RETURN;
    END IF;

    SELECT p.price
      INTO v_price
    FROM neiist.products p
    WHERE p.id = v_pid AND p.active = TRUE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Product not found or inactive';
      RETURN;
    END IF;

    v_unit := ROUND(v_price, 2);

    IF v_vid IS NOT NULL THEN
      SELECT pv.price_modifier
        INTO v_modifier
      FROM neiist.product_variants pv
      WHERE pv.id = v_vid
        AND pv.product_id = v_pid
        AND pv.active = TRUE;

      IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Variant not found or inactive';
        RETURN;
      END IF;

      v_unit := ROUND(v_unit + COALESCE(v_modifier, 0), 2);
    END IF;

    IF v_discount.valid_product_ids IS NULL OR COALESCE(array_length(v_discount.valid_product_ids, 1), 0) = 0 OR v_pid = ANY(v_discount.valid_product_ids) THEN
      v_eligible_total := v_eligible_total + (v_unit * v_qty);
      v_matching_items := TRUE;
    END IF;
  END LOOP;

  IF NOT v_has_cart THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Cart is empty';
    RETURN;
  END IF;

  IF v_discount.valid_product_ids IS NOT NULL AND COALESCE(array_length(v_discount.valid_product_ids, 1), 0) > 0 AND NOT v_matching_items THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code not applicable to these products';
    RETURN;
  END IF;

  IF v_discount.discount_type = 'percentage' THEN
    v_eligible_total := ROUND(v_eligible_total * (v_discount.discount_value / 100.0), 2);
  ELSE
    v_eligible_total := ROUND(LEAST(v_eligible_total, v_discount.discount_value), 2);
  END IF;

  IF v_eligible_total <= 0 THEN
    RETURN QUERY SELECT FALSE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, 0::NUMERIC(10,2), 'Discount code not applicable to these products';
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, v_discount.id, v_discount.code, v_discount.discount_type, v_discount.discount_value, v_eligible_total, NULL::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- New order created
CREATE OR REPLACE FUNCTION neiist.new_order(
  p_user_istid VARCHAR(50),
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_nif TEXT,
  p_campus TEXT,
  p_notes TEXT,
  p_payment_method TEXT,
  p_payment_reference TEXT,
  p_created_by TEXT,
  p_items JSONB,
  p_discount_code TEXT DEFAULT NULL,
  p_stock_override BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id INTEGER,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  pickup_deadline TIMESTAMPTZ,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status TEXT
) AS $$
DECLARE
  v_order_id INTEGER;
  v_customer_name TEXT;
  v_customer_email TEXT;
  v_customer_phone TEXT;
  it JSONB;
  v_pid INTEGER;
  v_vid INTEGER;
  v_qty INTEGER;
  v_base NUMERIC(10,2);
  v_unit NUMERIC(10,2);
  v_total NUMERIC(10,2) := 0;
  v_stock_type neiist.shop_stock_type_enum;
  v_order_deadline TIMESTAMPTZ;
  v_variant_stock INTEGER;
  v_product_stock INTEGER;
  v_pname TEXT;
  v_v_label TEXT;
  v_v_opts JSONB;
  v_discount_code TEXT := NULL;
  v_discount_amount NUMERIC(10,2) := 0;
  v_discount_result RECORD;
BEGIN
  v_customer_name := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_name), '')
  END;

  v_customer_email := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_email), '')
  END;

  v_customer_phone := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_phone), '')
  END;

  INSERT INTO neiist.orders(
    user_istid,
    customer_name,
    customer_email,
    customer_phone,
    nif,
    campus,
    notes,
    discount_code,
    discount_amount,
    payment_method,
    payment_reference,
    created_by
  )
  VALUES (
    p_user_istid,
    v_customer_name,
    v_customer_email,
    v_customer_phone,
    p_nif,
    p_campus,
    p_notes,
    NULL,
    NULL,
    p_payment_method,
    p_payment_reference,
    p_created_by
  )
  RETURNING orders.id INTO v_order_id;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_pid := (it->>'product_id')::INTEGER;
    v_vid := NULLIF(it->>'variant_id','')::INTEGER;
    v_qty := (it->>'quantity')::INTEGER;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity for product_id %', v_pid;
    END IF;

    SELECT p.name, p.price, p.stock_type, p.stock_quantity, p.order_deadline
      INTO v_pname, v_base, v_stock_type, v_product_stock, v_order_deadline
    FROM neiist.products p
    WHERE p.id = v_pid AND p.active = TRUE;

    IF v_pname IS NULL THEN
      RAISE EXCEPTION 'Product % not found or inactive', v_pid;
    END IF;

    IF NOT p_stock_override THEN
      -- Every stock type, not just on_demand (#174). Stock is replenishable; the deadline is a
        -- separate promise about when the production order is placed, and it is shown to
        -- students per product. p_stock_override still bypasses it, for POS sales.
        IF v_order_deadline IS NOT NULL AND NOW() > v_order_deadline THEN
        RAISE EXCEPTION 'Order deadline has passed for product % (%)', v_pid, v_pname;
      END IF;
    END IF;

    IF v_vid IS NOT NULL THEN
      -- Lock variant row for stock check
      PERFORM 1 FROM neiist.product_variants WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid AND product_variants.active = TRUE FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant % for product % not found or inactive', v_vid, v_pid;
      END IF;

      SELECT
        NULLIF((
          SELECT string_agg(pvo.option_name || ': ' || pvo.option_value, ' | ' ORDER BY pvo.option_name)
          FROM neiist.product_variant_options pvo
          WHERE pvo.variant_id = pv.id
        ), '') AS label,
        COALESCE((
          SELECT jsonb_object_agg(pvo.option_name, pvo.option_value)
          FROM neiist.product_variant_options pvo
          WHERE pvo.variant_id = pv.id
        ), '{}'::jsonb) AS options,
        pv.price_modifier,
        pv.stock_quantity
      INTO v_v_label, v_v_opts, v_unit, v_variant_stock
      FROM neiist.product_variants pv
      WHERE pv.id = v_vid AND pv.product_id = v_pid;

      v_unit := ROUND(v_base + COALESCE(v_unit,0), 2);

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        IF v_variant_stock IS NULL OR v_variant_stock < v_qty THEN
          RAISE EXCEPTION 'Insufficient variant stock (product %, variant %, have %, need %)',
            v_pid, v_vid, COALESCE(v_variant_stock, -1), v_qty;
        END IF;

        UPDATE neiist.product_variants
          SET stock_quantity = stock_quantity - v_qty,
              updated_at = NOW()
          WHERE product_variants.id = v_vid;
      ELSIF v_stock_type = 'limited' AND p_stock_override THEN
        NULL;
      END IF;
    ELSE
      v_v_label := NULL;
      v_v_opts := NULL;
      v_unit := ROUND(v_base, 2);

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        SELECT p.stock_quantity INTO v_product_stock
        FROM neiist.products p
        WHERE p.id = v_pid FOR UPDATE;

        IF v_product_stock IS NULL OR v_product_stock < v_qty THEN
          RAISE EXCEPTION 'Insufficient product stock (product %, have %, need %)',
            v_pid, COALESCE(v_product_stock, -1), v_qty;
        END IF;

        UPDATE neiist.products p
        SET stock_quantity = stock_quantity - v_qty
        WHERE p.id = v_pid;
      ELSIF v_stock_type = 'limited' AND p_stock_override THEN
        NULL;
      END IF;
    END IF;

    v_total := v_total + v_unit * v_qty;

    INSERT INTO neiist.order_items(
      order_id, product_id, variant_id, product_name, variant_label, variant_options,
      quantity, unit_price, total_price
    ) VALUES (
      v_order_id, v_pid, v_vid, v_pname, v_v_label, v_v_opts,
      v_qty, v_unit, v_unit * v_qty
    );
  END LOOP;

  IF NULLIF(BTRIM(COALESCE(p_discount_code, '')), '') IS NOT NULL THEN
    SELECT * INTO v_discount_result
    FROM neiist.validate_discount_code(p_discount_code, p_user_istid, p_items);

    IF NOT COALESCE(v_discount_result.is_valid, FALSE) THEN
      RAISE EXCEPTION '%', COALESCE(v_discount_result.error, 'Invalid discount code');
    END IF;

    UPDATE neiist.discount_codes
    SET current_uses = neiist.discount_codes.current_uses + 1,
        updated_at = NOW()
    WHERE neiist.discount_codes.id = v_discount_result.discount_code_id
      AND neiist.discount_codes.active = TRUE
      AND (neiist.discount_codes.expires_at IS NULL OR neiist.discount_codes.expires_at > NOW())
      AND (neiist.discount_codes.max_uses IS NULL OR neiist.discount_codes.current_uses < neiist.discount_codes.max_uses)
    RETURNING neiist.discount_codes.code INTO v_discount_code;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Discount code max uses reached';
    END IF;

    v_discount_amount := LEAST(v_total, COALESCE(v_discount_result.discount_amount, 0));
  END IF;

  UPDATE neiist.orders
  SET
    discount_code = v_discount_code,
    discount_amount = CASE WHEN v_discount_code IS NULL THEN NULL ELSE ROUND(v_discount_amount, 2) END,
    total_amount = ROUND(v_total - COALESCE(v_discount_amount, 0), 2),
    updated_at = NOW(),
    updated_by = p_created_by
  WHERE orders.id = v_order_id;

  RETURN QUERY
  SELECT
    o.id, o.order_number,
    CASE
      WHEN o.user_istid IS NULL THEN COALESCE(o.customer_name, '')
      ELSE COALESCE(u.name, '')
    END AS customer_name,
    o.user_istid,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_email
      ELSE u.email
    END AS customer_email,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_phone
      ELSE (
        SELECT c.contact_value
        FROM neiist.user_contacts c
        WHERE c.user_istid = o.user_istid AND c.contact_type = 'phone'
        LIMIT 1
      )
    END AS customer_phone,
    o.nif AS customer_nif,
     o.campus,
    o.pickup_deadline,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id,
        'product_name', oi.product_name,
        'variant_id', oi.variant_id,
        'variant_label', oi.variant_label,
        'variant_options', oi.variant_options,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'total_price', oi.total_price
      ) ORDER BY oi.id)
      FROM neiist.order_items oi
      WHERE oi.order_id = o.id
    ), '[]'::JSONB) AS items,
    o.notes, o.discount_code, o.discount_amount, o.total_amount, o.payment_method, o.payment_reference,
    o.created_by,
    o.created_at, o.paid_at, o.payment_checked_by, o.delivered_at, o.delivered_by, o.updated_at, o.updated_by,
    o.status::TEXT
  FROM neiist.orders o
  LEFT JOIN neiist.users u ON u.istid = o.user_istid
  WHERE o.id = v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get an order by ID or order_number
CREATE OR REPLACE FUNCTION neiist.get_order(
  p_order_id INT DEFAULT NULL,
  p_order_number TEXT DEFAULT NULL
)
RETURNS TABLE (
  id INT,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  pickup_deadline TIMESTAMPTZ,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status neiist.shop_order_status_enum
) AS $$
BEGIN
  IF (p_order_id IS NULL AND p_order_number IS NULL) THEN
    RAISE EXCEPTION 'Provide order_id or order_number';
  END IF;

  IF (p_order_id IS NOT NULL AND p_order_number IS NOT NULL) THEN
    RAISE EXCEPTION 'Provide only one of order_id or order_number';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.order_number,
    CASE
      WHEN o.user_istid IS NULL THEN COALESCE(o.customer_name, '')
      ELSE COALESCE(u.name, '')
    END AS customer_name,
    o.user_istid,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_email
      ELSE u.email
    END AS customer_email,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_phone
      ELSE (
        SELECT c.contact_value
        FROM neiist.user_contacts c
        WHERE c.user_istid = o.user_istid
          AND c.contact_type = 'phone'
        LIMIT 1
      )
    END AS customer_phone,
    o.nif AS customer_nif,
    o.campus,
    o.pickup_deadline,
    (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'product_id', oi.product_id,
          'product_name', oi.product_name,
          'variant_id', oi.variant_id,
          'variant_label', oi.variant_label,
          'variant_options', oi.variant_options,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'total_price', oi.total_price
        )
        ORDER BY oi.id
      ), '[]'::jsonb)
      FROM neiist.order_items oi
      WHERE oi.order_id = o.id
    ) AS items,
    o.notes,
    o.discount_code,
    o.discount_amount,
    o.total_amount,
    o.payment_method,
    o.payment_reference,
    o.created_by,
    o.created_at,
    o.paid_at,
    o.payment_checked_by,
    o.delivered_at,
    o.delivered_by,
    o.updated_at,
    o.updated_by,
    o.status
  FROM neiist.orders o
  LEFT JOIN neiist.users u ON u.istid = o.user_istid
  WHERE
    (p_order_id IS NOT NULL AND o.id = p_order_id)
    OR
    (p_order_number IS NOT NULL AND o.order_number = p_order_number)
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all orders data
CREATE OR REPLACE FUNCTION neiist.get_all_orders()
RETURNS TABLE (
  id INT,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  pickup_deadline TIMESTAMPTZ,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status neiist.shop_order_status_enum
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.order_number,
    CASE
      WHEN o.user_istid IS NULL THEN COALESCE(o.customer_name, '')
      ELSE COALESCE(u.name, '')
    END AS customer_name,
    o.user_istid,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_email
      ELSE u.email
    END AS customer_email,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_phone
      ELSE (
        SELECT c.contact_value
        FROM neiist.user_contacts c
        WHERE c.user_istid = o.user_istid AND c.contact_type = 'phone'
        LIMIT 1
      )
    END AS customer_phone,
    o.nif AS customer_nif,
    o.campus,
    o.pickup_deadline,
    (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'product_id', oi.product_id,
          'product_name', oi.product_name,
          'variant_id', oi.variant_id,
          'variant_label', oi.variant_label,
          'variant_options', oi.variant_options,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'total_price', oi.total_price
        )
        ORDER BY oi.id
      ), '[]'::jsonb)
      FROM neiist.order_items oi
      WHERE oi.order_id = o.id
    ) AS items,
    o.notes,
    o.discount_code,
    o.discount_amount,
    o.total_amount,
    o.payment_method,
    o.payment_reference,
    o.created_by,
    o.created_at,
    o.paid_at,
    o.payment_checked_by,
    o.delivered_at,
    o.delivered_by,
    o.updated_at,
    o.updated_by,
    o.status
  FROM neiist.orders o
  LEFT JOIN neiist.users u ON u.istid = o.user_istid
  ORDER BY o.created_at DESC, o.id DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update order details
CREATE OR REPLACE FUNCTION neiist.update_order(
  p_order_id INTEGER,
  p_updates JSONB,
  p_stock_override BOOLEAN DEFAULT FALSE,
  p_user_istid TEXT DEFAULT NULL
) RETURNS TABLE (
  id INTEGER,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  pickup_deadline TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status TEXT
) AS $$
DECLARE
  it JSONB;
  v_pid INTEGER;
  v_vid INTEGER;
  v_qty INTEGER;
  v_base NUMERIC(10,2);
  v_unit NUMERIC(10,2);
  v_total NUMERIC(10,2) := 0;
  v_stock_type neiist.shop_stock_type_enum;
  v_order_deadline TIMESTAMPTZ;
  v_variant_stock INTEGER;
  v_product_stock INTEGER;
  v_pname TEXT;
  v_v_label TEXT;
  v_v_opts JSONB;
  v_existing_discount_amount NUMERIC(10,2) := 0;
BEGIN
  SELECT COALESCE(o.discount_amount, 0)
    INTO v_existing_discount_amount
  FROM neiist.orders o
  WHERE o.id = p_order_id;

  IF p_updates ? 'user_istid' THEN
    UPDATE neiist.orders SET user_istid = NULLIF(p_updates->>'user_istid','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'nif' THEN
    UPDATE neiist.orders SET nif = p_updates->>'nif' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'campus' THEN
    UPDATE neiist.orders SET campus = p_updates->>'campus' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'notes' THEN
    UPDATE neiist.orders SET notes = p_updates->>'notes' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_method' THEN
    UPDATE neiist.orders SET payment_method = p_updates->>'payment_method' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_reference' THEN
    UPDATE neiist.orders SET payment_reference = p_updates->>'payment_reference' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'created_by' THEN
    UPDATE neiist.orders SET created_by = NULLIF(p_updates->>'created_by','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_checked_by' THEN
    UPDATE neiist.orders SET payment_checked_by = NULLIF(p_updates->>'payment_checked_by','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'pickup_deadline' THEN
    UPDATE neiist.orders SET pickup_deadline = NULLIF(p_updates->>'pickup_deadline','')::timestamptz WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'delivered_by' THEN
    UPDATE neiist.orders SET delivered_by = NULLIF(p_updates->>'delivered_by','') WHERE neiist.orders.id = p_order_id;
  END IF;

  IF p_updates ? 'items' THEN
    -- Restock previous limited-stock items before replacing the order lines.
    FOR v_pid, v_vid, v_qty IN
      SELECT oi.product_id, oi.variant_id, oi.quantity
      FROM neiist.order_items oi
      WHERE oi.order_id = p_order_id
    LOOP
      SELECT p.stock_type
        INTO v_stock_type
      FROM neiist.products p
      WHERE p.id = v_pid FOR UPDATE;

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        IF v_vid IS NOT NULL THEN
          UPDATE neiist.product_variants
            SET stock_quantity = COALESCE(stock_quantity, 0) + v_qty,
                updated_at = NOW()
          WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid;
        ELSE
          UPDATE neiist.products
          SET stock_quantity = COALESCE(stock_quantity, 0) + v_qty
          WHERE products.id = v_pid;
        END IF;
      END IF;
    END LOOP;

    DELETE FROM neiist.order_items WHERE order_id = p_order_id;

    FOR it IN SELECT * FROM jsonb_array_elements(p_updates->'items')
    LOOP
      v_pid := (it->>'product_id')::INTEGER;
      v_vid := NULLIF(it->>'variant_id','')::INTEGER;
      v_qty := (it->>'quantity')::INTEGER;

      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Invalid quantity for product_id %', v_pid;
      END IF;

      SELECT p.name, p.price, p.stock_type, p.order_deadline
        INTO v_pname, v_base, v_stock_type, v_order_deadline
      FROM neiist.products p
      WHERE p.id = v_pid AND p.active = TRUE;

      IF v_pname IS NULL THEN
        RAISE EXCEPTION 'Product % not found or inactive', v_pid;
      END IF;

      IF NOT p_stock_override THEN
        -- Every stock type, not just on_demand (#174). Stock is replenishable; the deadline is a
        -- separate promise about when the production order is placed, and it is shown to
        -- students per product. p_stock_override still bypasses it, for POS sales.
        IF v_order_deadline IS NOT NULL AND NOW() > v_order_deadline THEN
          RAISE EXCEPTION 'Order deadline has passed for product % (%)', v_pid, v_pname;
        END IF;
      END IF;

      IF v_vid IS NOT NULL THEN
        -- Lock variant row for stock check
        PERFORM 1 FROM neiist.product_variants WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid AND product_variants.active = TRUE FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Variant % for product % not found or inactive', v_vid, v_pid;
        END IF;

        SELECT
          NULLIF((
            SELECT string_agg(pvo.option_name || ': ' || pvo.option_value, ' | ' ORDER BY pvo.option_name)
            FROM neiist.product_variant_options pvo
            WHERE pvo.variant_id = pv.id
          ), '') AS label,
          COALESCE((
            SELECT jsonb_object_agg(pvo.option_name, pvo.option_value)
            FROM neiist.product_variant_options pvo
            WHERE pvo.variant_id = pv.id
          ), '{}'::jsonb) AS options,
          pv.price_modifier,
          pv.stock_quantity
        INTO v_v_label, v_v_opts, v_unit, v_variant_stock
        FROM neiist.product_variants pv
        WHERE pv.id = v_vid AND pv.product_id = v_pid;

        v_unit := ROUND(v_base + COALESCE(v_unit, 0), 2);

        IF v_stock_type = 'limited' AND NOT p_stock_override THEN
          IF v_variant_stock IS NULL OR v_variant_stock < v_qty THEN
            RAISE EXCEPTION 'Insufficient variant stock (product %, variant %, have %, need %)',
              v_pid, v_vid, COALESCE(v_variant_stock, -1), v_qty;
          END IF;

          UPDATE neiist.product_variants
            SET stock_quantity = stock_quantity - v_qty,
                updated_at = NOW()
            WHERE product_variants.id = v_vid;
        ELSIF v_stock_type = 'limited' AND p_stock_override THEN
          NULL;
        END IF;
      ELSE
        v_v_label := NULL;
        v_v_opts := NULL;
        v_unit := ROUND(v_base, 2);

        IF v_stock_type = 'limited' AND NOT p_stock_override THEN
          SELECT p.stock_quantity INTO v_product_stock
          FROM neiist.products p
          WHERE p.id = v_pid FOR UPDATE;

          IF v_product_stock IS NULL OR v_product_stock < v_qty THEN
            RAISE EXCEPTION 'Insufficient product stock (product %, have %, need %)',
              v_pid, COALESCE(v_product_stock, -1), v_qty;
          END IF;

          UPDATE neiist.products p
          SET stock_quantity = stock_quantity - v_qty
          WHERE p.id = v_pid;
        ELSIF v_stock_type = 'limited' AND p_stock_override THEN
          NULL;
        END IF;
      END IF;

      v_total := v_total + v_unit * v_qty;

      INSERT INTO neiist.order_items(
        order_id, product_id, variant_id, product_name, variant_label, variant_options,
        quantity, unit_price, total_price
      ) VALUES (
        p_order_id, v_pid, v_vid, v_pname, v_v_label, v_v_opts,
        v_qty, v_unit, v_unit * v_qty
      );
    END LOOP;

    UPDATE neiist.orders SET total_amount = ROUND(v_total - COALESCE(v_existing_discount_amount, 0), 2), updated_by = p_user_istid WHERE neiist.orders.id = p_order_id;
  END IF;

  UPDATE neiist.orders SET updated_at = NOW(), updated_by = p_user_istid WHERE neiist.orders.id = p_order_id;

  RETURN QUERY
  SELECT
    g.id,
    g.order_number,
    g.customer_name,
    g.user_istid,
    g.customer_email,
    g.customer_phone,
    g.customer_nif,
    g.campus,
    g.items,
    g.notes,
    g.discount_code,
    g.discount_amount,
    g.total_amount,
    g.payment_method,
    g.payment_reference,
    g.created_by,
    g.created_at,
    g.paid_at,
    g.payment_checked_by,
    g.pickup_deadline,
    g.delivered_at,
    g.delivered_by,
    g.updated_at,
    g.updated_by,
    g.status::TEXT
  FROM neiist.get_all_orders() g
  WHERE g.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update the status of an order
-- Guarded order status transitions (#78). The definition lives in
-- docker/migrations/003_order_transitions_and_cap.sql and is repeated at the end of this file,
-- because is_valid_order_transition and get_order must exist before it.

-- Get all non-cancelled ordered quantities by product for a user within a category
CREATE OR REPLACE FUNCTION neiist.get_user_ordered_products_in_category(
  p_user_istid VARCHAR(50),
  p_category_name TEXT
) RETURNS TABLE(product_id INTEGER, total INTEGER) AS $$
  SELECT oi.product_id, SUM(oi.quantity)::INT AS total
  FROM neiist.order_items oi
  JOIN neiist.orders o ON oi.order_id = o.id
  JOIN neiist.products p ON oi.product_id = p.id
  JOIN neiist.categories c ON p.category_id = c.id
  WHERE o.user_istid = p_user_istid
    AND o.status <> 'cancelled'
    AND lower(c.name) = lower(p_category_name)
  GROUP BY oi.product_id;
$$ LANGUAGE sql SECURITY DEFINER;

-- Get all available product categories
CREATE OR REPLACE FUNCTION neiist.get_all_categories()
RETURNS TABLE (
  id INTEGER,
  name TEXT
) AS $$
BEGIN
  RETURN QUERY SELECT c.id, c.name FROM neiist.categories c ORDER BY c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON neiist.orders(created_at);
CREATE INDEX IF NOT EXISTS idx_activities_dates ON neiist.activities(start, "end");
CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON neiist.discount_codes(code);


CREATE OR REPLACE FUNCTION neiist.payment_method_requires_reference(p_method TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  -- Only the SumUp-backed methods carry an external transaction id. Everything else is
  -- confirmed by a human, who may have nothing to record. NULL is treated as manual.
  SELECT lower(COALESCE(p_method, '')) IN ('card', 'sumup', 'sumup-tpa');
$$;

CREATE OR REPLACE FUNCTION neiist.finalize_paid_order(
  p_order_id          INTEGER,
  p_payment_reference TEXT,
  p_actor             TEXT
) RETURNS TABLE (
  finalized          BOOLEAN,
  previous_status    TEXT,
  id                 INT,
  order_number       TEXT,
  customer_name      TEXT,
  user_istid         VARCHAR(50),
  customer_email     TEXT,
  customer_phone     TEXT,
  customer_nif       TEXT,
  campus             TEXT,
  pickup_deadline    TIMESTAMPTZ,
  items              JSONB,
  notes              TEXT,
  discount_code      TEXT,
  discount_amount    NUMERIC(10,2),
  total_amount       NUMERIC(10,2),
  payment_method     TEXT,
  payment_reference  TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at       TIMESTAMPTZ,
  delivered_by       TEXT,
  updated_at         TIMESTAMPTZ,
  updated_by         TEXT,
  status             TEXT
) AS $$
DECLARE
  v_current   neiist.shop_order_status_enum;
  v_method    TEXT;
  v_reference TEXT := NULLIF(BTRIM(COALESCE(p_payment_reference, '')), '');
  v_rows      INTEGER;
  v_finalized BOOLEAN := FALSE;
BEGIN
  -- One winner. Every other concurrent finalization blocks here and, on waking, re-reads the row
  -- it now holds the lock on (READ COMMITTED re-evaluates FOR UPDATE against the latest committed
  -- version), so it sees 'paid' and takes the replay branch below.
  --
  -- DO NOT add any network call between this lock and the end of the function. All SumUp HTTP
  -- already happens before it. Moving one inside turns a 200ms lock into a 30s one and stalls
  -- every concurrent finalization for the same order.
  SELECT o.status, o.payment_method INTO v_current, v_method
  FROM neiist.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'NEI01';
  END IF;

  IF v_current = 'cancelled' THEN
    RAISE EXCEPTION 'Order % is cancelled and cannot be finalized as paid', p_order_id
      USING ERRCODE = 'NEI04';
  END IF;

  IF v_current IN ('paid', 'ready', 'delivered') THEN
    -- Replayed webhook or a second entry point for the same purchase. Success, no side effects:
    -- the caller must not email or re-run the after-purchase action.
    v_finalized := FALSE;
  ELSE
    IF neiist.payment_method_requires_reference(v_method) AND v_reference IS NULL THEN
      RAISE EXCEPTION 'Payment reference is required for order %', p_order_id
        USING ERRCODE = 'NEI05';
    END IF;

    UPDATE neiist.orders o
    SET status             = 'paid',
        -- COALESCE, not NOW(): preserve when the money actually arrived if this ever runs twice.
        paid_at            = COALESCE(o.paid_at, NOW()),
        payment_checked_by = COALESCE(o.payment_checked_by, p_actor),
        -- Keep an existing reference rather than blanking it when a manual finalization carries
        -- none. A reference that was recorded is evidence; absence of one is not.
        payment_reference  = COALESCE(v_reference, o.payment_reference),
        updated_at         = NOW(),
        updated_by         = COALESCE(p_actor, o.updated_by)
    WHERE o.id = p_order_id
      AND o.status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_finalized := (v_rows = 1);
  END IF;

  RETURN QUERY
  SELECT
    v_finalized, v_current::TEXT,
    g.id, g.order_number, g.customer_name, g.user_istid, g.customer_email, g.customer_phone,
    g.customer_nif, g.campus, g.pickup_deadline, g.items, g.notes, g.discount_code,
    g.discount_amount, g.total_amount, g.payment_method, g.payment_reference, g.created_by,
    g.created_at, g.paid_at, g.payment_checked_by, g.delivered_at, g.delivered_by,
    g.updated_at, g.updated_by, g.status::TEXT
  FROM neiist.get_order(p_order_id, NULL) g;   -- single-row read; NOT get_all_orders()
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.finalize_paid_order(INTEGER, TEXT, TEXT) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.payment_method_requires_reference(TEXT) TO neiist_app_user;

-- The FK every order read joins on, absent until now (schema.sql indexes order_items.product_id,
-- not order_id). Free to add while the order functions are being reworked anyway.
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON neiist.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON neiist.orders(status, created_at);

-- ---------------------------------------------------------------------------------------------
-- #78
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.is_valid_order_transition(
  p_from neiist.shop_order_status_enum,
  p_to   neiist.shop_order_status_enum
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to        THEN TRUE   -- idempotent no-op; bulk operations rely on it
    WHEN p_from = 'cancelled' THEN FALSE  -- terminal: the stock has already been returned
    WHEN p_from = 'pending'   THEN p_to IN ('paid', 'cancelled')
    WHEN p_from = 'paid'      THEN p_to IN ('ready', 'delivered', 'cancelled')
    -- Backward steps touch no stock and no money; they are how a manager undoes a misclick.
    -- Forbidding them would be stricter than today with no integrity benefit.
    WHEN p_from = 'ready'     THEN p_to IN ('paid', 'delivered', 'cancelled')
    WHEN p_from = 'delivered' THEN p_to IN ('paid', 'ready', 'cancelled')
    ELSE FALSE
  END;
$$;

-- A function is identified by name + argument types, so adding a 4th parameter with a default
-- would leave the unguarded 3-argument version in place AND make every 3-argument call ambiguous.
-- The old signature has to go. The runner wraps this file in one transaction, so the swap is
-- atomic and no call can land in the gap.
DROP FUNCTION IF EXISTS neiist.set_order_state(
  INTEGER, neiist.shop_order_status_enum, TEXT
);

CREATE OR REPLACE FUNCTION neiist.set_order_state(
  p_order_id        INTEGER,
  p_status          neiist.shop_order_status_enum,
  p_user_istid      TEXT DEFAULT NULL,
  p_expected_status neiist.shop_order_status_enum DEFAULT NULL
) RETURNS TABLE (
  changed            BOOLEAN,
  previous_status    TEXT,
  id                 INTEGER,
  order_number       TEXT,
  customer_name      TEXT,
  user_istid         VARCHAR(50),
  customer_email     TEXT,
  customer_phone     TEXT,
  customer_nif       TEXT,
  campus             TEXT,
  pickup_deadline    TIMESTAMPTZ,
  items              JSONB,
  notes              TEXT,
  discount_code      TEXT,
  discount_amount    NUMERIC(10,2),
  total_amount       NUMERIC(10,2),
  payment_method     TEXT,
  payment_reference  TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at       TIMESTAMPTZ,
  delivered_by       TEXT,
  updated_at         TIMESTAMPTZ,
  updated_by         TEXT,
  status             TEXT
) AS $$
DECLARE
  v_current neiist.shop_order_status_enum;
  v_rows    INTEGER;
  v_changed BOOLEAN := FALSE;
BEGIN
  -- Serialise every concurrent decision about this order behind one row lock.
  SELECT o.status INTO v_current
  FROM neiist.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'NEI01';
  END IF;

  -- Stale caller: the order moved since the decision was made. Zero rows, not an exception —
  -- for the auto-cancel sweep this is the expected outcome, not a failure.
  IF p_expected_status IS NOT NULL AND v_current <> p_expected_status THEN
    RETURN;
  END IF;

  IF v_current = p_status THEN
    v_changed := FALSE;
  ELSE
    IF NOT neiist.is_valid_order_transition(v_current, p_status) THEN
      RAISE EXCEPTION 'Invalid order status transition % -> % for order %',
        v_current, p_status, p_order_id
        USING ERRCODE = 'NEI02';
    END IF;

    UPDATE neiist.orders o
    SET status = p_status,
        -- COALESCE, not NOW(): a later ready->paid correction must not rewrite when the money
        -- actually arrived.
        paid_at = CASE
          WHEN p_status = 'paid' THEN COALESCE(o.paid_at, NOW())
          ELSE o.paid_at
        END,
        payment_checked_by = CASE
          WHEN p_status = 'paid' THEN COALESCE(o.payment_checked_by, p_user_istid)
          ELSE o.payment_checked_by
        END,
        delivered_at = CASE
          WHEN p_status = 'delivered' THEN COALESCE(o.delivered_at, NOW())
          -- Explicitly undoing a delivery clears the record. A cancellation after delivery
          -- (a return) keeps it: that history is wanted.
          WHEN v_current = 'delivered' AND p_status IN ('paid', 'ready') THEN NULL
          ELSE o.delivered_at
        END,
        delivered_by = CASE
          WHEN p_status = 'delivered' THEN COALESCE(o.delivered_by, p_user_istid)
          WHEN v_current = 'delivered' AND p_status IN ('paid', 'ready') THEN NULL
          ELSE o.delivered_by
        END,
        updated_at = NOW(),
        updated_by = COALESCE(p_user_istid, o.updated_by)
    WHERE o.id = p_order_id
      AND o.status = v_current;   -- belt and braces; the row lock already guarantees it

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := (v_rows = 1);
  END IF;

  RETURN QUERY
  SELECT
    v_changed, v_current::TEXT,
    g.id, g.order_number, g.customer_name, g.user_istid, g.customer_email, g.customer_phone,
    g.customer_nif, g.campus, g.pickup_deadline, g.items, g.notes, g.discount_code,
    g.discount_amount, g.total_amount, g.payment_method, g.payment_reference, g.created_by,
    g.created_at, g.paid_at, g.payment_checked_by, g.delivered_at, g.delivered_by,
    g.updated_at, g.updated_by, g.status::TEXT
  -- get_order(), NOT get_all_orders(). The old body read EVERY order and ran a jsonb_agg over
  -- order_items per row just to return one, which made the auto-cancel sweep O(orders^2).
  FROM neiist.get_order(p_order_id, NULL) g;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.is_valid_order_transition(
  neiist.shop_order_status_enum, neiist.shop_order_status_enum
) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.set_order_state(
  INTEGER, neiist.shop_order_status_enum, TEXT, neiist.shop_order_status_enum
) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- #100
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.new_order_capped(
  p_user_istid              VARCHAR(50),
  p_customer_name           TEXT,
  p_customer_email          TEXT,
  p_customer_phone          TEXT,
  p_nif                     TEXT,
  p_campus                  TEXT,
  p_notes                   TEXT,
  p_payment_method          TEXT,
  p_payment_reference       TEXT,
  p_created_by              TEXT,
  p_items                   JSONB,
  p_discount_code           TEXT    DEFAULT NULL,
  p_stock_override          BOOLEAN DEFAULT FALSE,
  p_max_quantity_per_user   INTEGER DEFAULT NULL,
  p_quantity_limit_category TEXT    DEFAULT NULL
) RETURNS TABLE (
  id INTEGER, order_number TEXT, customer_name TEXT, user_istid VARCHAR(50),
  customer_email TEXT, customer_phone TEXT, customer_nif TEXT, campus TEXT,
  pickup_deadline TIMESTAMPTZ, items JSONB, notes TEXT, discount_code TEXT,
  discount_amount NUMERIC(10,2), total_amount NUMERIC(10,2), payment_method TEXT,
  payment_reference TEXT, created_by TEXT, created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
  payment_checked_by TEXT, delivered_at TIMESTAMPTZ, delivered_by TEXT,
  updated_at TIMESTAMPTZ, updated_by TEXT, status TEXT
) AS $$
DECLARE
  v_category         TEXT := NULLIF(BTRIM(COALESCE(p_quantity_limit_category, '')), '');
  v_cap_product_name TEXT;
  v_cap_total        INTEGER;
BEGIN
  IF p_max_quantity_per_user IS NOT NULL AND p_user_istid IS NOT NULL AND v_category IS NOT NULL
  THEN
    -- Transaction-scoped: released on COMMIT *or* ROLLBACK, so the RAISE below cannot leak it.
    -- Keyed on user+category, so two different students never contend. This is the only place
    -- the lock is taken, and it is always taken before new_order's product/variant row locks,
    -- so it cannot participate in a lock-ordering cycle.
    PERFORM pg_advisory_xact_lock(
      hashtext('neiist.order_user_quantity_cap'),
      hashtext(lower(p_user_istid) || '|' || lower(v_category))
    );
  END IF;

  -- Delegate. Everything about stock, discounts and totals stays in one place.
  RETURN QUERY
  SELECT * FROM neiist.new_order(
    p_user_istid, p_customer_name, p_customer_email, p_customer_phone, p_nif, p_campus,
    p_notes, p_payment_method, p_payment_reference, p_created_by, p_items, p_discount_code,
    p_stock_override
  );

  IF p_max_quantity_per_user IS NOT NULL AND p_user_istid IS NOT NULL AND v_category IS NOT NULL
  THEN
    -- Counts the rows just inserted: they are visible to this transaction. The predicate matches
    -- neiist.get_user_ordered_products_in_category exactly, including status <> 'cancelled', so
    -- the authority and the route's fast pre-check agree.
    SELECT MAX(oi.product_name), SUM(oi.quantity)::INT
      INTO v_cap_product_name, v_cap_total
    FROM neiist.order_items oi
    JOIN neiist.orders     o ON o.id = oi.order_id
    JOIN neiist.products   p ON p.id = oi.product_id
    JOIN neiist.categories c ON c.id = p.category_id
    WHERE o.user_istid = p_user_istid
      AND o.status <> 'cancelled'
      AND lower(c.name) = lower(v_category)
    GROUP BY oi.product_id
    HAVING SUM(oi.quantity) > p_max_quantity_per_user
    LIMIT 1;

    IF FOUND THEN
      -- Aborts the whole transaction: the order row, its items, the stock decrements and any
      -- discount redemption all roll back together.
      RAISE EXCEPTION
        'Per-user quantity limit reached for % : % ordered, limit %',
        COALESCE(v_cap_product_name, 'product'), v_cap_total, p_max_quantity_per_user
        USING ERRCODE = 'NEI03';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.new_order_capped(
  VARCHAR(50), TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN,
  INTEGER, TEXT
) TO neiist_app_user;

-- Number of people who currently hold a given department role. Used by the UI to say "this
-- affects N members" before an access level is changed, so the consequence is visible.
CREATE OR REPLACE FUNCTION neiist.count_department_role_members(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS INTEGER
-- SECURITY DEFINER because the app calls this directly and neiist_app_user has no table
-- privileges by design (schema.sql:11-16). Caught by a test: "permission denied for table
-- membership".
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER
  FROM neiist.membership m
  WHERE m.department_name = u_department_name
    AND m.role_name = u_role_name
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE);
$$;

-- How many active roles still grant admin, excluding one (department, role) pair. The exclusion
-- is what lets both callers below ask "if I change/remove this one, is anything left?".
CREATE OR REPLACE FUNCTION neiist.count_other_admin_roles(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER
  FROM neiist.valid_department_roles v
  WHERE v.access = 'admin'
    AND v.active
    AND NOT (v.department_name = u_department_name AND v.role_name = u_role_name);
$$;

CREATE OR REPLACE FUNCTION neiist.update_valid_department_role(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
DECLARE
  v_current neiist.user_access_enum;
BEGIN
  SELECT v.access INTO v_current
  FROM neiist.valid_department_roles v
  WHERE v.department_name = u_department_name AND v.role_name = u_role_name AND v.active
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A posição "%" para o departamento "%" não existe.',
      u_role_name, u_department_name
      USING ERRCODE = 'NEI06';
  END IF;

  -- Demoting the last admin-level role is the lockout, so it is refused here as well as in
  -- remove: "change it to member" and "delete it" have the same effect on who can administer.
  IF v_current = 'admin' AND u_access <> 'admin'
     AND neiist.count_other_admin_roles(u_department_name, u_role_name) = 0 THEN
    RAISE EXCEPTION
      'Não é possível remover o último cargo com acesso de administrador — ficaria sem administradores.'
      USING ERRCODE = 'NEI07';
  END IF;

  UPDATE neiist.valid_department_roles v
  SET access = u_access
  WHERE v.department_name = u_department_name AND v.role_name = u_role_name AND v.active;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unchanged except for the guard. Body copied so the migration is self-contained and reviewable
-- rather than a diff against something the reader has to go and find.
CREATE OR REPLACE FUNCTION neiist.remove_valid_department_role(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM neiist.valid_department_roles WHERE department_name = u_department_name
      AND role_name = u_role_name) THEN
    RAISE EXCEPTION 'A posição "%" para o departamento "%" não existe.', u_role_name, u_department_name
      USING ERRCODE = 'NEI06';
  END IF;

  IF EXISTS (
    SELECT 1 FROM neiist.valid_department_roles
    WHERE department_name = u_department_name AND role_name = u_role_name
      AND access = 'admin' AND active
  ) AND neiist.count_other_admin_roles(u_department_name, u_role_name) = 0 THEN
    RAISE EXCEPTION
      'Não é possível remover o último cargo com acesso de administrador — ficaria sem administradores.'
      USING ERRCODE = 'NEI07';
  END IF;

  UPDATE neiist.valid_department_roles SET active = FALSE
    WHERE department_name = u_department_name AND role_name = u_role_name;
  UPDATE neiist.membership SET to_date = CURRENT_DATE
    WHERE department_name = u_department_name AND role_name = u_role_name
      AND (to_date IS NULL OR to_date > CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.count_department_role_members(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.count_other_admin_roles(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.update_valid_department_role(VARCHAR(30), VARCHAR(40), neiist.user_access_enum) TO neiist_app_user;

-- Indexes and integrity constraints (#85). Kept at the end of the file because the ON DELETE
-- change replaces a foreign key declared with the table above.
-- ---------------------------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------------------------

-- FK with ON DELETE SET NULL and no index: deleting a variant scans the whole table.
CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON neiist.order_items(variant_id);

-- FK joined by get_user_ordered_products_in_category, which backs the per-user purchase cap.
CREATE INDEX IF NOT EXISTS idx_products_category_id ON neiist.products(category_id);

-- Composite FK joined by get_user (on the path serverCheckRoles runs for every guarded page)
-- and by get_all_memberships.
CREATE INDEX IF NOT EXISTS idx_membership_department_role
  ON neiist.membership(department_name, role_name);

-- PK is (event_id, user_istid), so "which events has this person signed up to" scans.
CREATE INDEX IF NOT EXISTS idx_activities_sign_up_user
  ON neiist.activities_sign_up(user_istid);

-- Every email-verification lookup filters on token; neither column was indexed.
CREATE INDEX IF NOT EXISTS idx_email_token_token ON neiist.email_token(token);
CREATE INDEX IF NOT EXISTS idx_email_token_istid ON neiist.email_token(istid);

-- validate_discount_code filters WHERE UPPER(code) = …, which cannot use idx_discount_codes_code.
-- Making it UNIQUE also closes a case-collision hole: 'save10' and 'SAVE10' both satisfy the
-- case-sensitive UNIQUE(code) yet collide at validation time, so one of them silently shadows
-- the other.
--
-- Created non-unique first would be pointless; if this fails, two codes already differ only by
-- case and a human has to choose which survives. Deliberately not IF NOT EXISTS-guarded away
-- from that failure — a silent skip would leave the hole open.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code_upper
  ON neiist.discount_codes (UPPER(code));

-- ---------------------------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------------------------

DO $$
BEGIN
  -- Money cannot be negative. #81 documents how update_order can currently produce a negative
  -- total: it subtracts a fixed discount from a recomputed line total without re-validating the
  -- discount against the new items, so editing €25 of goods down to €3 with a €20 code yields
  -- -17.00. That value then reaches SumUp, whose amount <= 0 guard rejects it, leaving an order
  -- that cannot be paid. This constraint makes the database refuse the write instead.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_amount_non_negative') THEN
    ALTER TABLE neiist.orders
      ADD CONSTRAINT orders_total_amount_non_negative CHECK (total_amount >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_amount_non_negative') THEN
    ALTER TABLE neiist.orders
      ADD CONSTRAINT orders_discount_amount_non_negative CHECK (discount_amount >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_price_non_negative') THEN
    ALTER TABLE neiist.products
      ADD CONSTRAINT products_price_non_negative CHECK (price >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_prices_non_negative') THEN
    ALTER TABLE neiist.order_items
      ADD CONSTRAINT order_items_prices_non_negative
      CHECK (unit_price >= 0 AND total_price >= 0) NOT VALID;
  END IF;

  -- A percentage discount above 100 is free goods: new_order clamps with LEAST, so the total
  -- lands at exactly 0.00 rather than erroring. discount_value already has CHECK (>= 0) but no
  -- upper bound, so nothing stopped an admin typing 500.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discount_codes_percentage_max') THEN
    ALTER TABLE neiist.discount_codes
      ADD CONSTRAINT discount_codes_percentage_max
      CHECK (discount_type <> 'percentage' OR discount_value <= 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activities_end_after_start') THEN
    ALTER TABLE neiist.activities
      ADD CONSTRAINT activities_end_after_start CHECK ("end" >= start) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- ON DELETE: order line items are financial records
-- ---------------------------------------------------------------------------------------------

-- order_items.order_id was ON DELETE CASCADE, so deleting an order silently destroyed its line
-- items — the record of what was actually bought and for how much. Orders are cancelled, never
-- deleted: nothing in the codebase issues DELETE FROM neiist.orders, so RESTRICT costs nothing
-- today and turns a future accident into an error rather than lost financial history.
ALTER TABLE neiist.order_items DROP CONSTRAINT IF EXISTS order_items_order_id_fkey;
ALTER TABLE neiist.order_items
  ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES neiist.orders(id) ON DELETE RESTRICT;

-- Per-team access resolution (#180); see migration 008.
-- neiist.get_user_team_scopes now lives at the end of this file: since #184 it reads
-- neiist.team_access_grants, so it must be created after that table and is_grant_active.


-- Access level a role grants inside a department, for comparing what is being handed out against
-- what the assigner holds (see mayAssignAccess).
--
-- SECURITY DEFINER because neiist_app_user has no table privileges by design
-- (schema.sql:11-16) — a direct SELECT on valid_department_roles fails with aclcheck_error.
-- Learned the same way as count_department_role_members in 004.
CREATE OR REPLACE FUNCTION neiist.get_department_role_access(
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40)
) RETURNS neiist.user_access_enum
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT v.access
  FROM neiist.valid_department_roles v
  WHERE v.department_name = u_department_name
    AND v.role_name = u_role_name
    AND v.active
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION
  neiist.get_department_role_access(VARCHAR(30), VARCHAR(40)) TO neiist_app_user;

-- Account lookup for the Google login path (#124); see migration 007.
CREATE OR REPLACE FUNCTION neiist.find_user_by_any_email(u_email TEXT)
RETURNS TABLE (
  istid VARCHAR(50),
  matched_primary_email BOOLEAN
) AS $$
  -- Primary (Fenix) email first: an exact match there is the account, unambiguously.
  SELECT u.istid, TRUE
  FROM neiist.users u
  WHERE lower(u.email) = lower(u_email)
  UNION ALL
  -- Otherwise a verified alternative email. LIMIT 1 on the whole thing keeps the primary match
  -- winning when an address is somehow both.
  SELECT c.user_istid, FALSE
  FROM neiist.user_contacts c
  WHERE c.contact_type = 'alt_email'
    AND lower(c.contact_value) = lower(u_email)
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.find_user_by_any_email(TEXT) TO neiist_app_user;

-- Temporary, delegable team access grants (#184).
--
-- The requirement: the board lends someone access to a team they are not in, and a team's
-- coordinator can pass their own loan on to one of their own members. Both expire.
--
-- Grants union into `get_user_team_scopes` (rewritten at the bottom of this file), so every
-- existing guard honours them with no call-site change. The price of that reach is that a grant
-- must not be able to do everything a membership does — see `source` in permissions.ts and
-- invariant 5 below.
--
-- Rows are NEVER deleted: expiry and revocation are recorded, not erased. This table is the audit
-- record for grants, and #160's `permission_audit_log` will use the action names `grant.create`
-- and `grant.revoke` so the two agree without a later rename.
CREATE TABLE IF NOT EXISTS neiist.team_access_grants (
  id                SERIAL PRIMARY KEY,
  grantee_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  access            neiist.user_access_enum NOT NULL,
  granted_by_istid  VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  -- A delegated grant points at the board grant it was carved out of. NULL = a root grant made by
  -- the board. Depth is capped at one (invariant 3): board -> coordinator -> member, no further.
  parent_grant_id   INT REFERENCES neiist.team_access_grants(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_by_istid  VARCHAR(50) REFERENCES neiist.users(istid),
  revoke_reason     TEXT,

  -- `_ADMIN` is ORGANISATION_WIDE: canForTeam short-circuits on it before it looks at the
  -- department at all. A "team" grant carrying admin would therefore be a global grant wearing a
  -- team's name. Refused in the type system, in the function, and here.
  CONSTRAINT team_access_grants_never_admin CHECK (access <> 'admin'),
  CONSTRAINT team_access_grants_expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT team_access_grants_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT team_access_grants_not_self CHECK (grantee_istid <> granted_by_istid),
  -- Revocation is all-or-nothing: a revoked row must say who and when.
  CONSTRAINT team_access_grants_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by_istid IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_istid IS NOT NULL)
  )
);

-- The read path: "every live grant for this istid". Partial on the liveness condition that
-- get_user_team_scopes applies, so the union below stays cheap on the hot path.
CREATE INDEX IF NOT EXISTS idx_team_access_grants_live
  ON neiist.team_access_grants (grantee_istid, department_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_team_access_grants_parent
  ON neiist.team_access_grants (parent_grant_id)
  WHERE parent_grant_id IS NOT NULL;

-- Rank for comparing access levels.
--
-- The enum's own ordinal order is DESCENDING authority and puts shop_manager above member
-- (schema.sql:19-24), so `access < 'member'` does not mean what it looks like. This mirrors
-- ACCESS_RANK in src/lib/auth/permissions.ts, and a test pins the two together — it is one policy
-- written in two languages, which is a thing that drifts unless something checks.
CREATE OR REPLACE FUNCTION neiist.access_rank(a neiist.user_access_enum)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE a
    WHEN 'admin'        THEN 3
    WHEN 'coordinator'  THEN 2
    WHEN 'shop_manager' THEN 1
    WHEN 'member'       THEN 1
  END;
$$;

GRANT EXECUTE ON FUNCTION neiist.access_rank(neiist.user_access_enum) TO neiist_app_user;

-- Is this grant live right now? One definition, used by the read path, the delegation check and
-- the UI, so "active" cannot come to mean three slightly different things.
CREATE OR REPLACE FUNCTION neiist.is_grant_active(g neiist.team_access_grants)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT g.revoked_at IS NULL AND g.expires_at > NOW();
$$;

GRANT EXECUTE ON FUNCTION neiist.is_grant_active(neiist.team_access_grants) TO neiist_app_user;

-- Create a grant. SECURITY DEFINER, and the granter's authority is derived HERE from the
-- database — never passed in as an argument. The route hands over the caller's istid and nothing
-- else about who they are, so a compromised or careless route cannot claim authority it lacks.
--
-- Every check RAISEs rather than returning a falsy value, because ~58 of ~64 query functions in
-- this repo still `catch { return null }` (CLAUDE.md §8): a guard that reports failure by
-- returning something can be swallowed by a caller that was written before the guard existed.
CREATE OR REPLACE FUNCTION neiist.create_team_access_grant(
  g_actor_istid    VARCHAR(50),
  g_grantee_istid  VARCHAR(50),
  g_department     VARCHAR(30),
  g_access         neiist.user_access_enum,
  g_expires_at     TIMESTAMPTZ,
  g_reason         TEXT,
  g_parent_id      INT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_parent        neiist.team_access_grants;
  v_dept_type     VARCHAR(20);
  v_dept_active   BOOLEAN;
  v_new_id        INT;
BEGIN
  -- 5. Never admin. Checked before anything else because it is the one that would silently
  --    convert a team grant into an organisation-wide one.
  IF g_access = 'admin' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode conceder permissões de administrador.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 10. Not to yourself.
  IF g_grantee_istid = g_actor_istid THEN
    RAISE EXCEPTION 'Não é possível conceder acesso temporário a si próprio.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 6. Bounded in time, and bounded in how far ahead. The cap is what stops "temporary" from
  --    being permanent under another name.
  IF g_expires_at IS NULL OR g_expires_at <= NOW() THEN
    RAISE EXCEPTION 'A data de fim tem de ser no futuro.' USING ERRCODE = 'NEI11';
  END IF;
  IF g_expires_at > NOW() + INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode durar mais de 90 dias.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 7. A reason, always. This table is the audit record; a blank reason makes it useless.
  IF g_reason IS NULL OR btrim(g_reason) = '' THEN
    RAISE EXCEPTION 'É obrigatório indicar o motivo do acesso temporário.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 8. Only real, active teams. Admin bodies (Direção, Mesa da Assembleia Geral, Conselho Fiscal)
  --    hold the board's own material and are deliberately not lendable.
  SELECT d.department_type, d.active INTO v_dept_type, v_dept_active
  FROM neiist.departments d WHERE d.name = g_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A equipa "%" não existe.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF NOT v_dept_active THEN
    RAISE EXCEPTION 'A equipa "%" está inativa.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF v_dept_type <> 'team' THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a equipas.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 9. The grantee must already be a NEIIST member. Without this a grant would turn a non-member
  --    into someone `isNeiistMember` accepts, which is exactly the boundary #183 exists to hold:
  --    a grant lends access to ANOTHER team, it does not admit someone to the núcleo.
  IF NOT EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = g_grantee_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a membros do NEIIST.'
      USING ERRCODE = 'NEI11';
  END IF;

  IF g_parent_id IS NULL THEN
    -- 1. A ROOT grant creates new authority, so only the board may make one. This is the SQL
    --    mirror of ORGANISATION_WIDE = [_ADMIN] in permissions.ts, and it is membership-derived:
    --    a grant can never be the thing that lets you make grants.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = g_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
    ) THEN
      RAISE EXCEPTION 'Apenas a direção pode conceder acesso temporário a uma equipa.'
        USING ERRCODE = 'NEI08';
    END IF;
  ELSE
    SELECT * INTO v_parent FROM neiist.team_access_grants WHERE id = g_parent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'O acesso temporário de origem não existe.' USING ERRCODE = 'NEI09';
    END IF;

    -- 2. You may only pass on a grant that is yours and still live.
    IF v_parent.grantee_istid <> g_actor_istid THEN
      RAISE EXCEPTION 'Só pode delegar um acesso temporário que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF NOT neiist.is_grant_active(v_parent) THEN
      RAISE EXCEPTION 'O acesso temporário de origem já não está ativo.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF v_parent.department_name <> g_department THEN
      RAISE EXCEPTION 'Um acesso delegado tem de ser para a mesma equipa do acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF neiist.access_rank(g_access) > neiist.access_rank(v_parent.access) THEN
      RAISE EXCEPTION 'Não pode delegar mais acesso do que aquele que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF g_expires_at > v_parent.expires_at THEN
      RAISE EXCEPTION 'Um acesso delegado não pode durar mais do que o acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 3. Depth capped at one. Board -> coordinator -> member, and no further: an unbounded chain
    --    would make the original grant's blast radius impossible to reason about.
    IF v_parent.parent_grant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Um acesso já delegado não pode ser delegado novamente.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 4. "He should be able to give access to a member of HIS team." Both halves are
    --    membership-derived: the delegator must hold coordinator-or-higher somewhere by
    --    membership, and the grantee must be a member of that same department. A grant cannot
    --    bootstrap the authority to delegate.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership dm
      JOIN neiist.valid_department_roles dv
        ON dv.department_name = dm.department_name AND dv.role_name = dm.role_name
      JOIN neiist.membership gm
        ON gm.department_name = dm.department_name
       AND (gm.to_date IS NULL OR gm.to_date > CURRENT_DATE)
      WHERE dm.user_istid = g_actor_istid
        AND gm.user_istid = g_grantee_istid
        AND (dm.to_date IS NULL OR dm.to_date > CURRENT_DATE)
        AND dv.active
        AND neiist.access_rank(dv.access) >= neiist.access_rank('coordinator')
    ) THEN
      RAISE EXCEPTION
        'Só pode delegar acesso a um membro de uma equipa que coordena.'
        USING ERRCODE = 'NEI10';
    END IF;
  END IF;

  INSERT INTO neiist.team_access_grants
    (grantee_istid, department_name, access, granted_by_istid, parent_grant_id, reason, expires_at)
  VALUES
    (g_grantee_istid, g_department, g_access, g_actor_istid, g_parent_id, btrim(g_reason),
     g_expires_at)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_team_access_grant(
  VARCHAR(50), VARCHAR(50), VARCHAR(30), neiist.user_access_enum, TIMESTAMPTZ, TEXT, INT
) TO neiist_app_user;

-- Revoke a grant, and with it anything delegated from it.
--
-- Permitted to the person who granted it, to anyone organisation-wide, or to the grantee giving
-- it back. Revoking a parent revokes its children in the same statement: leaving a delegated
-- grant alive after its source was withdrawn is exactly the orphaned-authority case the depth cap
-- exists to keep thinkable.
CREATE OR REPLACE FUNCTION neiist.revoke_team_access_grant(
  r_actor_istid VARCHAR(50),
  r_grant_id    INT,
  r_reason      TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_grant neiist.team_access_grants;
BEGIN
  SELECT * INTO v_grant FROM neiist.team_access_grants WHERE id = r_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O acesso temporário não existe.' USING ERRCODE = 'NEI01';
  END IF;

  IF v_grant.revoked_at IS NOT NULL THEN
    -- Idempotent: revoking twice is not an error, it is the same outcome.
    RETURN;
  END IF;

  IF NOT (
    v_grant.granted_by_istid = r_actor_istid
    OR v_grant.grantee_istid = r_actor_istid
    OR EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = r_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
    )
  ) THEN
    RAISE EXCEPTION 'Não tem permissão para revogar este acesso temporário.'
      USING ERRCODE = 'NEI12';
  END IF;

  UPDATE neiist.team_access_grants
  SET revoked_at = NOW(), revoked_by_istid = r_actor_istid, revoke_reason = btrim(r_reason)
  WHERE id = r_grant_id OR (parent_grant_id = r_grant_id AND revoked_at IS NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.revoke_team_access_grant(VARCHAR(50), INT, TEXT) TO neiist_app_user;

-- Grants on a team, for the coordinator's screen. Newest first; revoked and expired rows are
-- included because the point of an audit record is that it still shows you what happened.
CREATE OR REPLACE FUNCTION neiist.get_team_access_grants(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  grantee_istid    VARCHAR(50),
  grantee_name     VARCHAR(100),
  access           neiist.user_access_enum,
  granted_by_istid VARCHAR(50),
  granted_by_name  VARCHAR(100),
  parent_grant_id  INT,
  reason           TEXT,
  granted_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  is_active        BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.grantee_istid, gu.name, g.access, g.granted_by_istid, au.name,
         g.parent_grant_id, g.reason, g.granted_at, g.expires_at, g.revoked_at,
         neiist.is_grant_active(g)
  FROM neiist.team_access_grants g
  JOIN neiist.users gu ON gu.istid = g.grantee_istid
  JOIN neiist.users au ON au.istid = g.granted_by_istid
  WHERE g.department_name = g_department
  ORDER BY g.granted_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_access_grants(VARCHAR(30)) TO neiist_app_user;

-- The grants this person holds and could pass on. Used by the UI to offer delegation only when
-- there is actually something to delegate.
CREATE OR REPLACE FUNCTION neiist.get_user_active_grants(u_istid VARCHAR(50))
RETURNS TABLE (
  id              INT,
  department_name VARCHAR(30),
  access          neiist.user_access_enum,
  parent_grant_id INT,
  expires_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.department_name, g.access, g.parent_grant_id, g.expires_at
  FROM neiist.team_access_grants g
  WHERE g.grantee_istid = u_istid AND neiist.is_grant_active(g)
  ORDER BY g.expires_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_user_active_grants(VARCHAR(50)) TO neiist_app_user;

-- Rewritten: memberships UNION live grants (#184).
--
-- Unioned HERE, at the source, rather than consulted separately by each guard. Every guard that
-- exists — canForTeam, visibleWorkspaceTeams, isNeiistMember, requireTeamWorkspace — and every
-- guard written for #129/#130/#131 then honours grants by construction. The alternative is a rule
-- written twice that eventually disagrees with itself, which is the exact shape of #97, #117
-- and #180.
--
-- `source` comes back so TypeScript can tell the two apart: a grant deliberately does NOT confer
-- everything a membership does (it cannot assign permanent roles, and it only satisfies the
-- permissions in GRANTABLE_TEAM_PERMISSIONS). Returning it is what makes that distinction
-- possible at all.
--
-- Expiry needs no job and no cleanup: scopes are re-read from the database on every request and
-- the JWT carries none, so the first request after expires_at simply comes back with fewer rows.

-- neiist.get_user_team_scopes now lives at the end of this file: since #184 it reads
-- neiist.team_access_grants, so it must be created after that table and is_grant_active.

-- Temporary, delegable team access grants (#184).
--
-- The requirement: the board lends someone access to a team they are not in, and a team's
-- coordinator can pass their own loan on to one of their own members. Both expire.
--
-- Grants union into `get_user_team_scopes` (rewritten at the bottom of this file), so every
-- existing guard honours them with no call-site change. The price of that reach is that a grant
-- must not be able to do everything a membership does — see `source` in permissions.ts and
-- invariant 5 below.
--
-- Rows are NEVER deleted: expiry and revocation are recorded, not erased. This table is the audit
-- record for grants, and #160's `permission_audit_log` will use the action names `grant.create`
-- and `grant.revoke` so the two agree without a later rename.
CREATE TABLE IF NOT EXISTS neiist.team_access_grants (
  id                SERIAL PRIMARY KEY,
  grantee_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  access            neiist.user_access_enum NOT NULL,
  granted_by_istid  VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  -- A delegated grant points at the board grant it was carved out of. NULL = a root grant made by
  -- the board. Depth is capped at one (invariant 3): board -> coordinator -> member, no further.
  parent_grant_id   INT REFERENCES neiist.team_access_grants(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoked_by_istid  VARCHAR(50) REFERENCES neiist.users(istid),
  revoke_reason     TEXT,

  -- `_ADMIN` is ORGANISATION_WIDE: canForTeam short-circuits on it before it looks at the
  -- department at all. A "team" grant carrying admin would therefore be a global grant wearing a
  -- team's name. Refused in the type system, in the function, and here.
  CONSTRAINT team_access_grants_never_admin CHECK (access <> 'admin'),
  CONSTRAINT team_access_grants_expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT team_access_grants_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT team_access_grants_not_self CHECK (grantee_istid <> granted_by_istid),
  -- Revocation is all-or-nothing: a revoked row must say who and when.
  CONSTRAINT team_access_grants_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by_istid IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_istid IS NOT NULL)
  )
);

-- The read path: "every live grant for this istid". Partial on the liveness condition that
-- get_user_team_scopes applies, so the union below stays cheap on the hot path.
CREATE INDEX IF NOT EXISTS idx_team_access_grants_live
  ON neiist.team_access_grants (grantee_istid, department_name)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_team_access_grants_parent
  ON neiist.team_access_grants (parent_grant_id)
  WHERE parent_grant_id IS NOT NULL;

-- Rank for comparing access levels.
--
-- The enum's own ordinal order is DESCENDING authority and puts shop_manager above member
-- (schema.sql:19-24), so `access < 'member'` does not mean what it looks like. This mirrors
-- ACCESS_RANK in src/lib/auth/permissions.ts, and a test pins the two together — it is one policy
-- written in two languages, which is a thing that drifts unless something checks.
CREATE OR REPLACE FUNCTION neiist.access_rank(a neiist.user_access_enum)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE a
    WHEN 'admin'        THEN 3
    WHEN 'coordinator'  THEN 2
    WHEN 'shop_manager' THEN 1
    WHEN 'member'       THEN 1
    -- ELSE 0, not NULL. Without it a future `ALTER TYPE … ADD VALUE` makes this return NULL,
    -- and `IF NULL > x THEN RAISE` is treated as false — so the delegation ceiling below would
    -- fail OPEN and silently allow an over-privileged delegation.
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION neiist.access_rank(neiist.user_access_enum) TO neiist_app_user;

-- Is this grant live right now? One definition, used by the read path, the delegation check and
-- the UI, so "active" cannot come to mean three slightly different things.
-- STABLE, not IMMUTABLE: it reads NOW(), which is STABLE. Declaring it IMMUTABLE is a false
-- contract that entitles Postgres to constant-fold the result — and this one predicate is the
-- entire expiry model, so a folded "true" would keep an expired grant granting forever.
CREATE OR REPLACE FUNCTION neiist.is_grant_active(g neiist.team_access_grants)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT g.revoked_at IS NULL AND g.expires_at > NOW();
$$;

GRANT EXECUTE ON FUNCTION neiist.is_grant_active(neiist.team_access_grants) TO neiist_app_user;

-- Create a grant. SECURITY DEFINER, and the granter's authority is derived HERE from the
-- database — never passed in as an argument. The route hands over the caller's istid and nothing
-- else about who they are, so a compromised or careless route cannot claim authority it lacks.
--
-- Every check RAISEs rather than returning a falsy value, because ~58 of ~64 query functions in
-- this repo still `catch { return null }` (CLAUDE.md §8): a guard that reports failure by
-- returning something can be swallowed by a caller that was written before the guard existed.
CREATE OR REPLACE FUNCTION neiist.create_team_access_grant(
  g_actor_istid    VARCHAR(50),
  g_grantee_istid  VARCHAR(50),
  g_department     VARCHAR(30),
  g_access         neiist.user_access_enum,
  g_expires_at     TIMESTAMPTZ,
  g_reason         TEXT,
  g_parent_id      INT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_parent        neiist.team_access_grants;
  v_dept_type     VARCHAR(20);
  v_dept_active   BOOLEAN;
  v_new_id        INT;
BEGIN
  -- 5. Never admin. Checked before anything else because it is the one that would silently
  --    convert a team grant into an organisation-wide one.
  IF g_access = 'admin' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode conceder permissões de administrador.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 10. Not to yourself.
  IF g_grantee_istid = g_actor_istid THEN
    RAISE EXCEPTION 'Não é possível conceder acesso temporário a si próprio.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 6. Bounded in time, and bounded in how far ahead. The cap is what stops "temporary" from
  --    being permanent under another name.
  IF g_expires_at IS NULL OR g_expires_at <= NOW() THEN
    RAISE EXCEPTION 'A data de fim tem de ser no futuro.' USING ERRCODE = 'NEI11';
  END IF;
  IF g_expires_at > NOW() + INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Um acesso temporário não pode durar mais de 90 dias.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 7. A reason, always. This table is the audit record; a blank reason makes it useless.
  IF g_reason IS NULL OR btrim(g_reason) = '' THEN
    RAISE EXCEPTION 'É obrigatório indicar o motivo do acesso temporário.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 8. Only real, active teams. Admin bodies (Direção, Mesa da Assembleia Geral, Conselho Fiscal)
  --    hold the board's own material and are deliberately not lendable.
  SELECT d.department_type, d.active INTO v_dept_type, v_dept_active
  FROM neiist.departments d WHERE d.name = g_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A equipa "%" não existe.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF NOT v_dept_active THEN
    RAISE EXCEPTION 'A equipa "%" está inativa.', g_department USING ERRCODE = 'NEI11';
  END IF;
  IF v_dept_type <> 'team' THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a equipas.'
      USING ERRCODE = 'NEI11';
  END IF;

  -- 9. The grantee must already be a NEIIST member. Without this a grant would turn a non-member
  --    into someone `isNeiistMember` accepts, which is exactly the boundary #183 exists to hold:
  --    a grant lends access to ANOTHER team, it does not admit someone to the núcleo.
  IF NOT EXISTS (
    SELECT 1 FROM neiist.membership m
    WHERE m.user_istid = g_grantee_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Só é possível conceder acesso temporário a membros do NEIIST.'
      USING ERRCODE = 'NEI11';
  END IF;

  IF g_parent_id IS NULL THEN
    -- 1. A ROOT grant creates new authority, so only the board may make one. This is the SQL
    --    mirror of ORGANISATION_WIDE = [_ADMIN] in permissions.ts, and it is membership-derived:
    --    a grant can never be the thing that lets you make grants.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.departments d ON d.name = m.department_name
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = g_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
        -- The authority must come from an ADMIN BODY, not from any role that happens to grant
        -- `admin`. Checking only `access = 'admin'` made this claim false against the real seed:
        -- `Dev-Team / Coordenador` is deliberately `admin` (#189), so one team's coordinator
        -- satisfied "only the board may create new authority" and could mint 90-day grants on
        -- every other team. Reading their department's type is what makes the sentence true.
        AND d.department_type <> 'team'
    ) THEN
      RAISE EXCEPTION 'Apenas a direção pode conceder acesso temporário a uma equipa.'
        USING ERRCODE = 'NEI08';
    END IF;
  ELSE
    -- FOR SHARE, so a concurrent revoke_team_access_grant (which takes FOR UPDATE on the same
    -- row) cannot commit between this read and the INSERT below. Without it, READ COMMITTED
    -- lets a child be created against a parent that is being revoked in another transaction:
    -- the revoke's cascading UPDATE never sees the new row, and the child outlives its source
    -- with no parent left to revoke it through.
    SELECT * INTO v_parent FROM neiist.team_access_grants WHERE id = g_parent_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'O acesso temporário de origem não existe.' USING ERRCODE = 'NEI09';
    END IF;

    -- 2. You may only pass on a grant that is yours and still live.
    IF v_parent.grantee_istid <> g_actor_istid THEN
      RAISE EXCEPTION 'Só pode delegar um acesso temporário que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF NOT neiist.is_grant_active(v_parent) THEN
      RAISE EXCEPTION 'O acesso temporário de origem já não está ativo.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF v_parent.department_name <> g_department THEN
      RAISE EXCEPTION 'Um acesso delegado tem de ser para a mesma equipa do acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF neiist.access_rank(g_access) > neiist.access_rank(v_parent.access) THEN
      RAISE EXCEPTION 'Não pode delegar mais acesso do que aquele que lhe foi concedido.'
        USING ERRCODE = 'NEI09';
    END IF;
    IF g_expires_at > v_parent.expires_at THEN
      RAISE EXCEPTION 'Um acesso delegado não pode durar mais do que o acesso de origem.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 3. Depth capped at one. Board -> coordinator -> member, and no further: an unbounded chain
    --    would make the original grant's blast radius impossible to reason about.
    IF v_parent.parent_grant_id IS NOT NULL THEN
      RAISE EXCEPTION 'Um acesso já delegado não pode ser delegado novamente.'
        USING ERRCODE = 'NEI09';
    END IF;

    -- 4. "He should be able to give access to a member of HIS team." Both halves are
    --    membership-derived: the delegator must hold coordinator-or-higher somewhere by
    --    membership, and the grantee must be a member of that same department. A grant cannot
    --    bootstrap the authority to delegate.
    IF NOT EXISTS (
      SELECT 1
      FROM neiist.membership dm
      JOIN neiist.valid_department_roles dv
        ON dv.department_name = dm.department_name AND dv.role_name = dm.role_name
      JOIN neiist.membership gm
        ON gm.department_name = dm.department_name
       AND (gm.to_date IS NULL OR gm.to_date > CURRENT_DATE)
      WHERE dm.user_istid = g_actor_istid
        AND gm.user_istid = g_grantee_istid
        AND (dm.to_date IS NULL OR dm.to_date > CURRENT_DATE)
        AND dv.active
        AND neiist.access_rank(dv.access) >= neiist.access_rank('coordinator')
    ) THEN
      RAISE EXCEPTION
        'Só pode delegar acesso a um membro de uma equipa que coordena.'
        USING ERRCODE = 'NEI10';
    END IF;
  END IF;

  INSERT INTO neiist.team_access_grants
    (grantee_istid, department_name, access, granted_by_istid, parent_grant_id, reason, expires_at)
  VALUES
    (g_grantee_istid, g_department, g_access, g_actor_istid, g_parent_id, btrim(g_reason),
     g_expires_at)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.create_team_access_grant(
  VARCHAR(50), VARCHAR(50), VARCHAR(30), neiist.user_access_enum, TIMESTAMPTZ, TEXT, INT
) TO neiist_app_user;

-- Revoke a grant, and with it anything delegated from it.
--
-- Permitted to the person who granted it, to anyone organisation-wide, or to the grantee giving
-- it back. Revoking a parent revokes its children in the same statement: leaving a delegated
-- grant alive after its source was withdrawn is exactly the orphaned-authority case the depth cap
-- exists to keep thinkable.
CREATE OR REPLACE FUNCTION neiist.revoke_team_access_grant(
  r_actor_istid VARCHAR(50),
  r_grant_id    INT,
  r_reason      TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_grant neiist.team_access_grants;
BEGIN
  SELECT * INTO v_grant FROM neiist.team_access_grants WHERE id = r_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O acesso temporário não existe.' USING ERRCODE = 'NEI01';
  END IF;

  IF v_grant.revoked_at IS NOT NULL THEN
    -- Idempotent: revoking twice is not an error, it is the same outcome.
    RETURN;
  END IF;

  IF NOT (
    v_grant.granted_by_istid = r_actor_istid
    OR v_grant.grantee_istid = r_actor_istid
    OR EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = r_actor_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND v.access = 'admin'
    )
    -- The RECEIVING team's own coordinator, by membership. Without this the one person
    -- responsible for a team could not remove an outsider the board lent to it — they would see
    -- the grant on their own team's page and have no way to end it.
    OR EXISTS (
      SELECT 1
      FROM neiist.membership m
      JOIN neiist.valid_department_roles v
        ON v.department_name = m.department_name AND v.role_name = m.role_name
      WHERE m.user_istid = r_actor_istid
        AND m.department_name = v_grant.department_name
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
        AND v.active
        AND neiist.access_rank(v.access) >= neiist.access_rank('coordinator')
    )
  ) THEN
    RAISE EXCEPTION 'Não tem permissão para revogar este acesso temporário.'
      USING ERRCODE = 'NEI12';
  END IF;

  UPDATE neiist.team_access_grants
  SET revoked_at = NOW(), revoked_by_istid = r_actor_istid, revoke_reason = btrim(r_reason)
  WHERE id = r_grant_id OR (parent_grant_id = r_grant_id AND revoked_at IS NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.revoke_team_access_grant(VARCHAR(50), INT, TEXT) TO neiist_app_user;

-- Grants on a team, for the coordinator's screen. Newest first; revoked and expired rows are
-- included because the point of an audit record is that it still shows you what happened.
CREATE OR REPLACE FUNCTION neiist.get_team_access_grants(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  grantee_istid    VARCHAR(50),
  grantee_name     VARCHAR(100),
  access           neiist.user_access_enum,
  granted_by_istid VARCHAR(50),
  granted_by_name  VARCHAR(100),
  parent_grant_id  INT,
  reason           TEXT,
  granted_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  is_active        BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.grantee_istid, gu.name, g.access, g.granted_by_istid, au.name,
         g.parent_grant_id, g.reason, g.granted_at, g.expires_at, g.revoked_at,
         neiist.is_grant_active(g)
  FROM neiist.team_access_grants g
  JOIN neiist.users gu ON gu.istid = g.grantee_istid
  JOIN neiist.users au ON au.istid = g.granted_by_istid
  WHERE g.department_name = g_department
  ORDER BY g.granted_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_access_grants(VARCHAR(30)) TO neiist_app_user;

-- The grants this person holds and could pass on. Used by the UI to offer delegation only when
-- there is actually something to delegate.
CREATE OR REPLACE FUNCTION neiist.get_user_active_grants(u_istid VARCHAR(50))
RETURNS TABLE (
  id              INT,
  department_name VARCHAR(30),
  access          neiist.user_access_enum,
  parent_grant_id INT,
  expires_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.id, g.department_name, g.access, g.parent_grant_id, g.expires_at
  FROM neiist.team_access_grants g
  WHERE g.grantee_istid = u_istid AND neiist.is_grant_active(g)
  ORDER BY g.expires_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_user_active_grants(VARCHAR(50)) TO neiist_app_user;

-- Rewritten: memberships UNION live grants (#184).
--
-- Unioned HERE, at the source, rather than consulted separately by each guard. Every guard that
-- exists — canForTeam, visibleWorkspaceTeams, isNeiistMember, requireTeamWorkspace — and every
-- guard written for #129/#130/#131 then honours grants by construction. The alternative is a rule
-- written twice that eventually disagrees with itself, which is the exact shape of #97, #117
-- and #180.
--
-- `source` comes back so TypeScript can tell the two apart: a grant deliberately does NOT confer
-- everything a membership does (it cannot assign permanent roles, and it only satisfies the
-- permissions in GRANTABLE_TEAM_PERMISSIONS). Returning it is what makes that distinction
-- possible at all.
--
-- Expiry needs no job and no cleanup: scopes are re-read from the database on every request and
-- the JWT carries none, so the first request after expires_at simply comes back with fewer rows.

CREATE OR REPLACE FUNCTION neiist.get_user_team_scopes(u_istid VARCHAR(50))
RETURNS TABLE (
  department_name VARCHAR(30),
  department_type VARCHAR(20),
  access          neiist.user_access_enum,
  source          TEXT
) AS $$
  -- Current memberships only: to_date IS NULL, or still in the future. This is the same
  -- liveness rule get_user applies, and idx_membership_active indexes exactly it.
  --
  -- DISTINCT because a person can hold several roles in one department that map to the same
  -- access level; the caller wants the set of levels they have there, not a row per role.
  SELECT DISTINCT
    m.department_name,
    d.department_type,
    v.access,
    'membership'::TEXT
  FROM neiist.membership m
  JOIN neiist.departments d ON d.name = m.department_name
  JOIN neiist.valid_department_roles v
    ON v.department_name = m.department_name
   AND v.role_name = m.role_name
  WHERE m.user_istid = u_istid
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    AND d.active
    AND v.active

  UNION

  SELECT DISTINCT
    g.department_name,
    d.department_type,
    g.access,
    'grant'::TEXT
  FROM neiist.team_access_grants g
  JOIN neiist.departments d ON d.name = g.department_name
  WHERE g.grantee_istid = u_istid
    AND neiist.is_grant_active(g)
    AND d.active
    -- A grant is strictly ADDITIVE to membership, never a substitute for it.
    --
    -- `create_team_access_grant` already refuses a grant to a non-member, but that is checked
    -- once, at INSERT. Checking it only there meant a grant kept working after the grantee left
    -- the núcleo: offboarding ends their membership row, the membership branch above returns
    -- nothing, and this branch alone would still return a scope — making `isNeiistMember`
    -- (`scopes.length > 0`) true for an ex-member and handing them another team's internal
    -- workspace for up to 90 more days, with nothing in the admin UI showing why.
    --
    -- Enforced on the READ path because that is the only place that can react to a membership
    -- ending, which is an event this table never sees.
    AND EXISTS (
      SELECT 1
      FROM neiist.membership m
      WHERE m.user_istid = g.grantee_istid
        AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.get_user_team_scopes(VARCHAR(50)) TO neiist_app_user;

-- 011: a coordinator can no longer promote a role to `admin` (#193).
--
-- `members.roles.manage` is held by [_ADMIN, _COORDINATOR], `PATCH /api/admin/roles` checked only
-- that, and `update_valid_department_role` took **no actor argument at all** — so nothing anywhere
-- asked "may this person grant `admin`?". A coordinator pointed the endpoint at their own role,
-- raised it to `admin`, and became organisation-wide admin: the full user directory (real student
-- PII), department and role management, the shop's admin surface, and every team's workspace.
--
-- Demonstrated end to end before this fix. It is a different escalation from #180/#181, which
-- covered assigning yourself a *membership*; this one never touches `membership`, it changes what
-- a role the person already holds is worth. The last-admin guard (#158) is the opposite direction
-- — it refuses removing the last admin, and says nothing about creating one.
--
-- The rule lives here rather than in the route because the route is not the only caller, and
-- because ~58 of ~64 query functions still `catch { return null }`: a guard that reports failure
-- by returning something falsy is a guard that can be swallowed.

-- May this person hand out organisation-wide access? Only someone who already holds it.
--
-- Membership-derived, deliberately: this must not be satisfiable by anything that a caller could
-- themselves have been given temporarily (#184 grants are not in `membership`).
CREATE OR REPLACE FUNCTION neiist.may_grant_admin_access(a_istid VARCHAR(50))
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = a_istid
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.access = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.may_grant_admin_access(VARCHAR(50)) TO neiist_app_user;

-- Guarded overloads. The actor is the FIRST parameter and has no default, so a call site cannot
-- omit it and silently get the unguarded behaviour — the mistake that made this possible.
--
-- A NULL actor is permitted and means "no admin authority". Two internal call sites
-- (`addMember`, `addCollaborator`) create roles at fixed non-admin levels and have no actor to
-- thread; passing NULL there is safe *because* it fails closed — NULL can never satisfy
-- `may_grant_admin_access`, so a NULL actor can create a `member` or `coordinator` role and can
-- never create an `admin` one.
CREATE OR REPLACE FUNCTION neiist.update_valid_department_role(
  u_actor_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
BEGIN
  IF u_access = 'admin' AND NOT neiist.may_grant_admin_access(u_actor_istid) THEN
    RAISE EXCEPTION
      'Apenas um administrador pode atribuir o nível de acesso de administrador a um cargo.'
      USING ERRCODE = 'NEI13';
  END IF;
  PERFORM neiist.update_valid_department_role(u_department_name, u_role_name, u_access);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION neiist.add_valid_department_role(
  u_actor_istid VARCHAR(50),
  u_department_name VARCHAR(30),
  u_role_name VARCHAR(40),
  u_access neiist.user_access_enum
) RETURNS VOID AS $$
BEGIN
  IF u_access = 'admin' AND NOT neiist.may_grant_admin_access(u_actor_istid) THEN
    RAISE EXCEPTION
      'Apenas um administrador pode criar um cargo com o nível de acesso de administrador.'
      USING ERRCODE = 'NEI13';
  END IF;
  PERFORM neiist.add_valid_department_role(u_department_name, u_role_name, u_access);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.update_valid_department_role(
  VARCHAR(50), VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.add_valid_department_role(
  VARCHAR(50), VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) TO neiist_app_user;

-- Close the back door. The three-argument forms have no actor and therefore cannot be guarded;
-- they stay because `docker/init.sql` seeds through them as the OWNER role, but the application
-- role must not be able to reach them — otherwise the guarded overload is advice, not a boundary.
--
-- `schema.sql:13-14` grants EXECUTE on everything in the schema to neiist_app_user, so this
-- REVOKE has to come after, and any future function of this shape has to remember the same.
-- FROM PUBLIC as well as from the app role. Postgres grants EXECUTE on every new function to
-- PUBLIC by default, so revoking from neiist_app_user alone leaves the privilege intact through
-- PUBLIC — `has_function_privilege` still answered true, which is how this was caught.
REVOKE EXECUTE ON FUNCTION neiist.update_valid_department_role(
  VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) FROM PUBLIC, neiist_app_user;
REVOKE EXECUTE ON FUNCTION neiist.add_valid_department_role(
  VARCHAR(30), VARCHAR(40), neiist.user_access_enum
) FROM PUBLIC, neiist_app_user;

-- 012: internal events and meetings (#129, slice A of Phase 1).
--
-- The first piece of NEIIST's Notion operations to actually move. `/workspace/[team]` has been
-- rendering a placeholder saying "as páginas do Notion serão migradas para aqui"; this is what
-- fills it.
--
-- Numbered 012, not 011: 011 is claimed by open PR #195 (the admin-grant guard). Likewise the
-- SQLSTATEs here are NEI14/NEI15 — NEI01-NEI12 are on main and NEI13 belongs to #195.
--
-- Deliberately NOT in this migration: anything touching `neiist.activities`, the Notion sync, or
-- Google Calendar. `is_public` exists and is enforced, but nothing reads it publicly yet — that
-- is slice C, and keeping it out means this cannot break the public calendar.

-- The event itself.
--
-- `owner_department_name`, not the `owner_team_id` the issue sketched: this repo has no
-- `teams.id`, teams are keyed by name, and `canForTeam` compares `departments.name` **exactly**.
-- Storing that same string is what lets the existing guard authorize these rows with no
-- translation step — and a translation step between the value authorized and the value written
-- is exactly how a check and its effect come apart (#180).
--
-- It references `departments`, not `teams`, so Direção and the Mesa da Assembleia Geral can own
-- meetings too. That is safe rather than a loophole: #184 forbids grants on non-team departments,
-- so no borrowed scope can ever reach an admin body's meetings.
CREATE TABLE IF NOT EXISTS neiist.internal_events (
  id                    SERIAL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('event', 'meeting')),
  name                  TEXT NOT NULL CHECK (btrim(name) <> ''),
  description           TEXT,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ,
  -- Default FALSE, always. A row that reaches the public calendar by forgetting a field is the
  -- failure this whole column exists to prevent.
  is_public             BOOLEAN NOT NULL DEFAULT FALSE,
  owner_department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  created_by_istid      VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT internal_events_ends_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

-- The team page lists a team's events by date; that is the only read shape slice A has.
CREATE INDEX IF NOT EXISTS idx_internal_events_by_team
  ON neiist.internal_events (owner_department_name, starts_at DESC);

-- Partial, for the public calendar slice C will add. Cheap now, and it documents the intent.
CREATE INDEX IF NOT EXISTS idx_internal_events_public
  ON neiist.internal_events (starts_at) WHERE is_public;

-- Every Notion multi-select becomes a join table. No comma-joined strings.
CREATE TABLE IF NOT EXISTS neiist.event_locations (
  event_id INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  location TEXT NOT NULL CHECK (btrim(location) <> ''),
  PRIMARY KEY (event_id, location)
);

-- Attendees resolve to real users, not free text — an acceptance criterion of #129, and what
-- makes "who was at that meeting" answerable later.
CREATE TABLE IF NOT EXISTS neiist.event_attendees (
  event_id   INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  response   TEXT NOT NULL DEFAULT 'invited'
             CHECK (response IN ('invited', 'accepted', 'declined', 'attended')),
  PRIMARY KEY (event_id, user_istid)
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_user
  ON neiist.event_attendees (user_istid);

-- Create an event with its locations and attendees, atomically.
--
-- One plpgsql function rather than `withTransaction` from the route: a single call is already one
-- implicit transaction, and it keeps the write indivisible for every caller, not only the one
-- that remembers to wrap it. #129 requires this — a half-written event with no locations is not a
-- state anything should be able to observe.
--
-- Authorization is NOT here. Unlike the grant functions (#184), which decide who may create new
-- authority, this decides nothing about permissions: `canForTeam` in the route and page owns that,
-- because the question is "may this caller act for this team", which the existing guard already
-- answers correctly and which duplicating would let drift.
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

-- One team's events. **Takes a department and filters on it** — that is the structural half of
-- the `is_public` boundary: there is no "all events" reader in slice A at all, so a caller cannot
-- accidentally receive another team's internal meetings by omitting a filter.
DROP FUNCTION IF EXISTS neiist.get_team_internal_events(VARCHAR(30));

-- Delete. Returns the owning department so the caller can authorize against the row's real owner
-- rather than one supplied in the request — the IDOR shape.
CREATE OR REPLACE FUNCTION neiist.get_internal_event_owner(e_id INT)
RETURNS VARCHAR(30) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT owner_department_name FROM neiist.internal_events WHERE id = e_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_internal_event_owner(INT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.delete_internal_event(e_id INT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM neiist.internal_events WHERE id = e_id;
$$;

GRANT EXECUTE ON FUNCTION neiist.delete_internal_event(INT) TO neiist_app_user;

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

-- 014: the public calendar and the member view read internal events (#129, slice C).
--
-- This is the first time a **student-facing page** stops depending on Notion at request time.
--
-- Slice A established an invariant: no row-returning function may read `internal_events` without
-- either a department parameter or `WHERE is_public`, pinned by a `pg_proc` introspection test.
-- This migration adds the one function that satisfies the second half of that rule — deliberately,
-- once, with tests — and one member-scoped reader that satisfies the first.

-- The public calendar. **`WHERE is_public` is the entire authorization**: this function is callable
-- by anyone, so the column is what stands between an internal meeting and the front page.
--
-- Meetings are excluded on top of that, belt and braces. `kind = 'event'` is not a security
-- control — a public meeting would already be a deliberate act — but nothing in the núcleo's
-- workflow wants an internal coordination meeting on the students' calendar even if someone ticks
-- the box by mistake, and the mistake is one checkbox away.
DROP FUNCTION IF EXISTS neiist.get_public_internal_events();

-- The member's own internal view on /activities.
--
-- Scoped to the teams this person actually belongs to — via `get_user_team_scopes`, so temporary
-- grants (#184) are honoured for free. This is **narrower than what it replaces**: the Notion view
-- (#127) showed every team's internal events to anyone holding `activities.viewInternal`, which
-- predates the team boundary #183 established. Tightening it is the point, not a side effect.
DROP FUNCTION IF EXISTS neiist.get_member_internal_events(VARCHAR(50));

-- 015: the public event reader also returns `updated_at` (#129, slice D).
--
-- Google Calendar sync decides whether an existing entry needs rewriting by comparing a stored
-- timestamp (`extendedProperties.private.notionLastEdited`). Without a change timestamp on the
-- workspace side, editing an event in the workspace would leave the calendar entry stale forever:
-- the sync would see an id it already has and skip it.
--
-- `CREATE OR REPLACE` cannot change a function's return type, so this drops first. Safe: the only
-- callers are `getPublicInternalEvents` and `/activities`, both of which ship in the same release,
-- and a `DROP ... IF EXISTS` followed by `CREATE` inside one migration transaction is never
-- observable as "missing" by anything else.
DROP FUNCTION IF EXISTS neiist.get_public_internal_events();

-- `updated_at` was only ever set by `update_event_notes`. An event whose name, date or locations
-- change would not have moved it, so the calendar would keep the old entry.
CREATE OR REPLACE FUNCTION neiist.touch_internal_event() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_internal_events_touch ON neiist.internal_events;
CREATE TRIGGER trg_internal_events_touch
  BEFORE UPDATE ON neiist.internal_events
  FOR EACH ROW EXECUTE FUNCTION neiist.touch_internal_event();

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

-- 019: recruitment applications (#134, slice A).
--
-- Replaces a "Candidata-te" button that pointed at https://google.com.
--
-- The modelling problem is that **one application has an independent outcome per team**. Someone
-- who applies to Dev-Team, Visuais and Fotografia may be accepted into one, two, all three, or
-- none — so the outcome cannot be a column on the application. It is a row per (application,
-- team), which is also what lets `canForTeam` authorize each decision separately.

-- A recruitment round. Applications belong to one, so "this year's candidates" is a filter rather
-- than a date range someone has to remember, and closing a round is one flag rather than a
-- convention.
CREATE TABLE IF NOT EXISTS neiist.recruitment_editions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (btrim(name) <> ''),
  opens_at   TIMESTAMPTZ NOT NULL,
  closes_at  TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT recruitment_editions_closes_after_opens CHECK (closes_at > opens_at)
);

-- Only one round may accept applications at a time: two open rounds means an applicant cannot
-- tell which they are applying to, and neither can the person reviewing.
--
-- NOT a partial unique index — `NOW()` is STABLE, not IMMUTABLE, and Postgres refuses it in an
-- index predicate. Correctly: an index whose membership changes with the clock is not an index.
-- The rule is enforced by this trigger instead, which is the right place for a constraint that
-- depends on time.
CREATE OR REPLACE FUNCTION neiist.check_one_open_edition() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM neiist.recruitment_editions e
    WHERE e.id <> coalesce(NEW.id, -1)
      AND tstzrange(e.opens_at, e.closes_at) && tstzrange(NEW.opens_at, NEW.closes_at)
  ) THEN
    RAISE EXCEPTION 'Já existe uma edição de recrutamento neste período.' USING ERRCODE = 'NEI20';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recruitment_editions_no_overlap ON neiist.recruitment_editions;
CREATE TRIGGER trg_recruitment_editions_no_overlap
  BEFORE INSERT OR UPDATE ON neiist.recruitment_editions
  FOR EACH ROW EXECUTE FUNCTION neiist.check_one_open_edition();

-- The application itself.
--
-- `istid` is NOT a foreign key to `neiist.users` on purpose: someone can apply before they have
-- ever logged in, and requiring an account first would put a Fenix login in front of a form that
-- should be open. It is captured so the acceptance flow can match them later.
--
-- Personal data lives here, and it belongs to people who may never become members. The retention
-- rule (6 months after rejection, decided 2026-08-25) is enforced by `purge_old_applications`
-- below rather than by anyone remembering.
CREATE TABLE IF NOT EXISTS neiist.recruitment_applications (
  id           SERIAL PRIMARY KEY,
  edition_id   INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL CHECK (btrim(full_name) <> ''),
  istid        VARCHAR(50) NOT NULL CHECK (btrim(istid) <> ''),
  email        TEXT NOT NULL CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone        TEXT,
  course       TEXT,
  year         INT CHECK (year IS NULL OR year BETWEEN 1 AND 10),
  motivation   TEXT,
  -- The application as a whole, distinct from the per-team outcomes below. `screened_out` is a
  -- rejection before any team looks; `closed` means every team has decided.
  status       TEXT NOT NULL DEFAULT 'submitted'
               CHECK (status IN ('submitted', 'screened_out', 'interviewing', 'closed')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,

  -- One application per person per round. A second attempt should edit the first, not create a
  -- rival that some teams see and others do not.
  CONSTRAINT recruitment_applications_one_per_edition UNIQUE (edition_id, istid)
);

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_edition
  ON neiist.recruitment_applications (edition_id, status);

-- The per-team half, and the reason this is not a status column.
--
-- `department_name` is the same key `internal_events` and `tasks` use, so `canForTeam` authorizes
-- these rows with no translation step — and a translation between the value authorized and the
-- value written is how a check and its effect come apart (#180).
CREATE TABLE IF NOT EXISTS neiist.recruitment_application_teams (
  application_id  INT NOT NULL REFERENCES neiist.recruitment_applications(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  outcome         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'accepted', 'rejected')),
  decided_by_istid VARCHAR(50) REFERENCES neiist.users(istid),
  decided_at      TIMESTAMPTZ,
  note            TEXT,

  PRIMARY KEY (application_id, department_name),

  -- A decision must say who made it and when; `pending` must not pretend to.
  CONSTRAINT recruitment_teams_decision_complete CHECK (
    (outcome = 'pending' AND decided_by_istid IS NULL AND decided_at IS NULL)
    OR (outcome <> 'pending' AND decided_by_istid IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_recruitment_teams_by_department
  ON neiist.recruitment_application_teams (department_name, outcome);

-- Submit an application with its team choices, atomically. Same pattern as create_internal_event.
--
-- Callable by ANYONE — this is the one public write in the workspace family — so every rule that
-- matters is here rather than in the route.
CREATE OR REPLACE FUNCTION neiist.submit_application(
  a_full_name  TEXT,
  a_istid      VARCHAR(50),
  a_email      TEXT,
  a_phone      TEXT,
  a_course     TEXT,
  a_year       INT,
  a_motivation TEXT,
  a_teams      VARCHAR(30)[]
) RETURNS INT AS $$
DECLARE
  v_edition INT;
  v_id      INT;
  v_teams   INT;
BEGIN
  IF a_full_name IS NULL OR btrim(a_full_name) = '' THEN
    RAISE EXCEPTION 'O nome é obrigatório.' USING ERRCODE = 'NEI19';
  END IF;
  IF a_istid IS NULL OR btrim(a_istid) = '' THEN
    RAISE EXCEPTION 'O número de aluno é obrigatório.' USING ERRCODE = 'NEI19';
  END IF;

  -- The open round. No open round means recruitment is closed, and saying so is better than
  -- silently accepting an application nobody will ever read.
  SELECT id INTO v_edition FROM neiist.recruitment_editions
  WHERE NOW() BETWEEN opens_at AND closes_at
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'As candidaturas estão fechadas de momento.' USING ERRCODE = 'NEI20';
  END IF;

  IF a_teams IS NULL OR array_length(a_teams, 1) IS NULL THEN
    RAISE EXCEPTION 'Escolhe pelo menos uma equipa.' USING ERRCODE = 'NEI19';
  END IF;

  -- Every chosen team must be a real, active team. An unknown name is a mistake worth showing,
  -- not something to drop silently — the applicant would never learn their choice vanished.
  SELECT count(*) INTO v_teams
  FROM unnest(a_teams) AS t(name)
  JOIN neiist.departments d ON d.name = t.name AND d.active AND d.department_type = 'team';

  IF v_teams <> array_length(a_teams, 1) THEN
    RAISE EXCEPTION 'Uma das equipas escolhidas não existe.' USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.recruitment_applications
    (edition_id, full_name, istid, email, phone, course, year, motivation)
  VALUES
    (v_edition, btrim(a_full_name), btrim(a_istid), lower(btrim(a_email)),
     NULLIF(btrim(coalesce(a_phone, '')), ''), NULLIF(btrim(coalesce(a_course, '')), ''),
     a_year, NULLIF(btrim(coalesce(a_motivation, '')), ''))
  RETURNING id INTO v_id;

  INSERT INTO neiist.recruitment_application_teams (application_id, department_name)
  SELECT v_id, t.name FROM unnest(a_teams) AS t(name)
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.submit_application(
  TEXT, VARCHAR(50), TEXT, TEXT, TEXT, INT, TEXT, VARCHAR(30)[]
) TO neiist_app_user;

-- The approvals themselves (#217).

-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS neiist.recruitment_application_approvals (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  -- Which half of the pair this is. Not a claim the caller makes — `record_application_approval`
  -- derives it from the actor's real memberships and refuses if they do not hold it.
  side            TEXT NOT NULL CHECK (side IN ('team', 'board')),
  decision        TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  actor_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note            TEXT,

  PRIMARY KEY (application_id, department_name, side),

  -- Cascades with the team row, which cascades with the application, which the 6-month retention
  -- purge deletes. An approval is a record about a candidate and must not outlive them (#134).
  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE,

  -- "Both" means two people. Someone who is a coordinator of the team AND on the board may fill
  -- either slot, but not both: the point is a second pair of eyes, and one person holding two
  -- hats is still one pair. Enforced here rather than in the UI because the UI is not a boundary.
  CONSTRAINT recruitment_approval_two_people
    UNIQUE (application_id, department_name, actor_istid)
);

-- The board's queue: everything waiting on a board signature, across all teams.
CREATE INDEX IF NOT EXISTS idx_recruitment_approvals_by_side
  ON neiist.recruitment_application_approvals (side, decided_at);

-- ---------------------------------------------------------------------------------------------
-- The outcome becomes derived.
-- ---------------------------------------------------------------------------------------------

-- Recompute one (application, team) outcome from its approvals, then re-derive the application's
-- status the same way #215 did.
--
-- The rule, from the quotation above: NOTHING is settled until both sides have spoken. A single
-- rejection does not settle it either — an email saying "no" is still an email, and Tomás asked
-- for both signatures on rejections as explicitly as on acceptances. So:
--
--     both sides accepted            -> accepted
--     both sides in, any rejection   -> rejected
--     anything else                  -> pending
--
-- `decided_by_istid` records whoever COMPLETED the pair, because the CHECK from #215 wants one
-- istid and the completing signature is the one that made it real. The full pair is in the
-- approvals table; this column is a summary, and is read as one.
CREATE OR REPLACE FUNCTION neiist.recompute_application_outcome() RETURNS TRIGGER AS $$
DECLARE
  v_app    INT;
  v_dept   VARCHAR(30);
  v_team   INT;
  v_board  INT;
  v_reject INT;
BEGIN
  v_app  := COALESCE(NEW.application_id, OLD.application_id);
  v_dept := COALESCE(NEW.department_name, OLD.department_name);

  SELECT count(*) FILTER (WHERE side = 'team'),
         count(*) FILTER (WHERE side = 'board'),
         count(*) FILTER (WHERE decision = 'reject')
    INTO v_team, v_board, v_reject
  FROM neiist.recruitment_application_approvals
  WHERE application_id = v_app AND department_name = v_dept;

  IF v_team = 0 OR v_board = 0 THEN
    UPDATE neiist.recruitment_application_teams
    SET outcome = 'pending', decided_by_istid = NULL, decided_at = NULL
    WHERE application_id = v_app AND department_name = v_dept;
  ELSE
    UPDATE neiist.recruitment_application_teams t
    SET outcome = CASE WHEN v_reject > 0 THEN 'rejected' ELSE 'accepted' END,
        decided_by_istid = last.actor_istid,
        decided_at = last.decided_at,
        -- The team's note is the one about the candidate's fit; the board's is a sign-off. The
        -- team's is what the summary carries, and both remain readable in the approvals table.
        note = (
          SELECT NULLIF(btrim(coalesce(a.note, '')), '')
          FROM neiist.recruitment_application_approvals a
          WHERE a.application_id = v_app AND a.department_name = v_dept AND a.side = 'team'
        )
    FROM (
      SELECT a.actor_istid, a.decided_at
      FROM neiist.recruitment_application_approvals a
      WHERE a.application_id = v_app AND a.department_name = v_dept
      ORDER BY a.decided_at DESC, a.side DESC
      LIMIT 1
    ) AS last
    WHERE t.application_id = v_app AND t.department_name = v_dept;
  END IF;

  -- Derived exactly as in #215: closed once no team is still pending. Recomputed in BOTH
  -- directions, because withdrawing an approval must reopen an application that had closed —
  -- otherwise a withdrawal would leave a 'closed' application with a 'pending' team.
  UPDATE neiist.recruitment_applications a
  SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM neiist.recruitment_application_teams t
          WHERE t.application_id = a.id AND t.outcome = 'pending'
        ) THEN 'closed'
        -- Reopening restores 'submitted' ONLY from 'closed'. Writing it unconditionally would
        -- erase 'interviewing' — someone withdrawing a signature would silently un-schedule the
        -- interview the candidate had already been invited to.
        WHEN a.status = 'closed' THEN 'submitted'
        ELSE a.status END,
      decided_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM neiist.recruitment_application_teams t
          WHERE t.application_id = a.id AND t.outcome = 'pending'
        ) THEN NULL ELSE NOW() END
  WHERE a.id = v_app AND a.status <> 'screened_out';

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_recompute_application_outcome
  ON neiist.recruitment_application_approvals;

CREATE TRIGGER trg_recompute_application_outcome
AFTER INSERT OR UPDATE OR DELETE ON neiist.recruitment_application_approvals
FOR EACH ROW EXECUTE FUNCTION neiist.recompute_application_outcome();

-- ---------------------------------------------------------------------------------------------
-- Recording an approval.
-- ---------------------------------------------------------------------------------------------

-- Which sides does this person actually hold, for this team?
--
-- 'board' is DATA, not a hardcoded list of names (#185): an active membership in a department
-- whose type is not 'team', with a role graded `admin`. Against the real seed that is exactly
-- Direção's Presidente, Vice-Presidente and Vogal — Conselho Fiscal and Mesa da Assembleia Geral
-- top out at `coordinator`, which is the whole reason Mesa "only has what we give them", and
-- Tesoureiro and Diretora SINFO are `member` on purpose. Change who signs off by editing
-- `valid_department_roles`, not this function.
--
-- Reading `department_type` matters and is not decoration: `Dev-Team / Coordenador` is graded
-- `admin` on purpose (#189), so a rule that checked only `access = 'admin'` would let one team's
-- coordinator supply the BOARD half of every other team's recruitment. That is #180 again.
CREATE OR REPLACE FUNCTION neiist.application_approval_sides(
  s_actor      VARCHAR(50),
  s_department VARCHAR(30)
) RETURNS TABLE (side TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT 'team'::TEXT
  WHERE EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = s_actor
      AND m.department_name = s_department
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.access IN ('coordinator', 'admin')
  )
  UNION ALL
  SELECT 'board'::TEXT
  WHERE EXISTS (
    SELECT 1
    FROM neiist.membership m
    JOIN neiist.valid_department_roles v
      ON v.department_name = m.department_name AND v.role_name = m.role_name
    WHERE m.user_istid = s_actor
      AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
      AND v.active
      AND v.board_member
  );
$$;

GRANT EXECUTE ON FUNCTION neiist.application_approval_sides(VARCHAR, VARCHAR) TO neiist_app_user;

-- Editable without a deploy, which is the whole #185 principle. Separate from
-- `update_valid_department_role` on purpose: that one carries the last-admin lockout guard
-- because it changes what a role can DO, and this changes who someone IS. Conflating them would
-- put an irrelevant guard on one and hide a relevant one from the other.
CREATE OR REPLACE FUNCTION neiist.set_role_board_membership(
  b_department_name VARCHAR(30),
  b_role_name       VARCHAR(40),
  b_board_member    BOOLEAN
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.valid_department_roles
  SET board_member = b_board_member
  WHERE department_name = b_department_name AND role_name = b_role_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O cargo "%" não existe no departamento "%".', b_role_name, b_department_name
      USING ERRCODE = 'NEI03';
  END IF;

  -- A team's role must never be board membership: that is the #180 shape exactly — a claim that
  -- belongs to one team becoming authority over all of them. The board is an admin body.
  IF b_board_member AND EXISTS (
    SELECT 1 FROM neiist.departments
    WHERE name = b_department_name AND department_type = 'team'
  ) THEN
    RAISE EXCEPTION 'Só os órgãos sociais podem ter cargos da direção.' USING ERRCODE = 'NEI03';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.set_role_board_membership(VARCHAR(30), VARCHAR(40), BOOLEAN)
  TO neiist_app_user;

-- Record one half of the pair.
--
-- `a_side` is a HINT, for the one person who holds both, not an instruction — it is checked
-- against `application_approval_sides` and refused if they do not hold it. A route that passed
-- 'board' for a team coordinator gets an error, not a board approval. This is the difference
-- between a check and its effect that #180 was about.
CREATE OR REPLACE FUNCTION neiist.record_application_approval(
  a_application INT,
  a_department  VARCHAR(30),
  a_decision    TEXT,
  a_actor       VARCHAR(50),
  a_side        TEXT DEFAULT NULL,
  a_note        TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_sides TEXT[];
  v_side  TEXT;
BEGIN
  IF a_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION 'Decisão inválida.' USING ERRCODE = 'NEI19';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM neiist.recruitment_application_teams
    WHERE application_id = a_application AND department_name = a_department
  ) THEN
    RAISE EXCEPTION 'Esta candidatura não inclui essa equipa.' USING ERRCODE = 'NEI20';
  END IF;

  SELECT array_agg(side) INTO v_sides
  FROM neiist.application_approval_sides(a_actor, a_department);

  IF v_sides IS NULL THEN
    RAISE EXCEPTION 'Não tens autoridade para decidir sobre esta candidatura.'
      USING ERRCODE = 'NEI21';
  END IF;

  IF a_side IS NOT NULL THEN
    IF NOT (a_side = ANY(v_sides)) THEN
      RAISE EXCEPTION 'Não podes assinar como %.', a_side USING ERRCODE = 'NEI21';
    END IF;
    v_side := a_side;
  ELSIF array_length(v_sides, 1) = 1 THEN
    v_side := v_sides[1];
  ELSE
    -- Holds both. Fill whichever half is still open; if both are open the caller must choose,
    -- because picking for them would silently spend the signature they meant to give later.
    SELECT s INTO v_side FROM unnest(v_sides) AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM neiist.recruitment_application_approvals x
      WHERE x.application_id = a_application AND x.department_name = a_department AND x.side = s
    )
    LIMIT 1;

    IF v_side IS NULL OR (SELECT count(*) FROM unnest(v_sides) AS s
                          WHERE NOT EXISTS (
                            SELECT 1 FROM neiist.recruitment_application_approvals x
                            WHERE x.application_id = a_application
                              AND x.department_name = a_department AND x.side = s)) > 1 THEN
      RAISE EXCEPTION 'Indica se assinas pela equipa ou pela direção.' USING ERRCODE = 'NEI21';
    END IF;
  END IF;

  -- ON CONFLICT so someone may change their own mind; the UNIQUE on (application, team, actor)
  -- is what stops them changing somebody else's. A conflict on the actor constraint means one
  -- person is reaching for the second signature, and must fail loudly rather than overwrite.
  BEGIN
    INSERT INTO neiist.recruitment_application_approvals
      (application_id, department_name, side, decision, actor_istid, note)
    VALUES (a_application, a_department, v_side, a_decision, a_actor,
            NULLIF(btrim(coalesce(a_note, '')), ''))
    ON CONFLICT (application_id, department_name, side) DO UPDATE
    SET decision = EXCLUDED.decision,
        actor_istid = EXCLUDED.actor_istid,
        decided_at = NOW(),
        note = EXCLUDED.note;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'As duas aprovações têm de ser de pessoas diferentes.' USING ERRCODE = 'NEI22';
  END;

  RETURN v_side;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.record_application_approval(
  INT, VARCHAR, TEXT, VARCHAR, TEXT, TEXT
) TO neiist_app_user;

-- Withdraw a signature. Deliberately allowed while the decision is still forming, and it
-- reopens the application through the same trigger — a pair that can only be assembled and
-- never taken apart makes an accidental click permanent.
CREATE OR REPLACE FUNCTION neiist.withdraw_application_approval(
  w_application INT,
  w_department  VARCHAR(30),
  w_actor       VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.recruitment_application_approvals
  WHERE application_id = w_application
    AND department_name = w_department
    -- Only your own. Removing someone else's signature is how one person gets both halves.
    AND actor_istid = w_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não tens nenhuma aprovação registada nesta candidatura.'
      USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.withdraw_application_approval(INT, VARCHAR, VARCHAR)
  TO neiist_app_user;

-- There is deliberately NO function that writes `outcome` directly (#217). The single-click path
-- that #215 had does not exist here — it is derived from the two signatures above, and a caller
-- that could set it could record a decision two people never made.

-- ---------------------------------------------------------------------------------------------
-- Reads: what is waiting on whom.
-- ---------------------------------------------------------------------------------------------

-- Decision notifications, the transactional outbox (#223, slice C).
CREATE TABLE IF NOT EXISTS neiist.recruitment_decision_notifications (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),

  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Claimed, then sent. Two columns rather than one because the gap between them is exactly the
  -- window where a crash loses an email, and it should be visible rather than inferred.
  claimed_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,

  -- Acceptance only. Stored as a SHA-256 hash: this grants an onboarding flow to somebody who is
  -- NOT yet a member, so it is a credential, and a credential in a database column is one leak
  -- away from being usable. The plaintext exists only in the email.
  onboarding_token_hash TEXT UNIQUE,
  token_expires_at      TIMESTAMPTZ,
  token_used_at         TIMESTAMPTZ,

  -- One notification per (application, team), FOREVER. This is the honest model rather than a
  -- convenient one: a sent email cannot be unsent, so withdrawing a signature afterwards must not
  -- produce a second, contradicting message. The row stays, and the review screen shows that the
  -- candidate was already told.
  PRIMARY KEY (application_id, department_name),

  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE,

  CONSTRAINT decision_notification_token_only_on_accept CHECK (
    onboarding_token_hash IS NULL OR outcome = 'accepted'
  )
);

-- The drain queue: everything not yet sent, oldest first.
CREATE INDEX IF NOT EXISTS idx_decision_notifications_unsent
  ON neiist.recruitment_decision_notifications (queued_at)
  WHERE sent_at IS NULL;

-- Queue a notification the moment a team's outcome settles.
--
-- ON CONFLICT DO NOTHING is what makes this exactly-once at the queueing end: a decision that is
-- withdrawn and re-made does not queue a second email. Combined with the claim below, an email
-- is sent at most once for a given (application, team) for as long as the application exists.
CREATE OR REPLACE FUNCTION neiist.queue_decision_notification() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.outcome <> 'pending' AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    -- Screened-out applications never reached a team decision, so they are not notified here.
    IF EXISTS (
      SELECT 1 FROM neiist.recruitment_applications
      WHERE id = NEW.application_id AND status <> 'screened_out'
    ) THEN
      INSERT INTO neiist.recruitment_decision_notifications
        (application_id, department_name, outcome)
      VALUES (NEW.application_id, NEW.department_name, NEW.outcome)
      ON CONFLICT (application_id, department_name) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_queue_decision_notification
  ON neiist.recruitment_application_teams;

CREATE TRIGGER trg_queue_decision_notification
AFTER UPDATE ON neiist.recruitment_application_teams
FOR EACH ROW EXECUTE FUNCTION neiist.queue_decision_notification();

-- Claim everything ready to send, and return what the email needs.
--
-- The UPDATE is the claim, and it is the whole concurrency story: `WHERE sent_at IS NULL AND
-- claimed_at IS NULL` with RETURNING is atomic, so two concurrent drains partition the queue
-- between them instead of both sending it. `SKIP LOCKED` keeps the second caller from blocking on
-- the first rather than simply getting the rows the first did not take.
--
-- Deliberately returns the candidate's name and email — this is the one place they are needed
-- outside the reviewing team, and the function is called by the server, never by a route that
-- echoes it back.
CREATE OR REPLACE FUNCTION neiist.claim_decision_notifications(c_limit INT DEFAULT 50)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  outcome         TEXT,
  full_name       TEXT,
  email           TEXT,
  attempts        INT
) AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE neiist.recruitment_decision_notifications n
    SET claimed_at = NOW(), attempts = n.attempts + 1
    WHERE (n.application_id, n.department_name) IN (
      SELECT c.application_id, c.department_name
      FROM neiist.recruitment_decision_notifications c
      WHERE c.sent_at IS NULL AND c.claimed_at IS NULL
      ORDER BY c.queued_at
      LIMIT c_limit
      FOR UPDATE SKIP LOCKED
    )
    RETURNING n.application_id, n.department_name, n.outcome, n.attempts
  )
  SELECT c.application_id, c.department_name, c.outcome, a.full_name, a.email, c.attempts
  FROM claimed c
  JOIN neiist.recruitment_applications a ON a.id = c.application_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.claim_decision_notifications(INT) TO neiist_app_user;

-- The send worked. For an acceptance this is also where the onboarding token is recorded — after
-- the email is out, so a token can never exist for a message nobody received.
CREATE OR REPLACE FUNCTION neiist.mark_decision_notification_sent(
  m_application INT,
  m_department  VARCHAR(30),
  m_token_hash  TEXT DEFAULT NULL,
  m_expires_at  TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET sent_at = NOW(),
      last_error = NULL,
      onboarding_token_hash = m_token_hash,
      token_expires_at = m_expires_at
  WHERE application_id = m_application AND department_name = m_department;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não há notificação por enviar para esta candidatura.' USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.mark_decision_notification_sent(
  INT, VARCHAR(30), TEXT, TIMESTAMPTZ
) TO neiist_app_user;

-- The send failed. Release the claim so a later drain retries, and keep the reason.
--
-- The error is stored rather than logged because of the acceptance criterion that failures are
-- visible to the TEAM: a coordinator watching for a reply needs to know the email never left,
-- and a line in a server log is not something they will ever see.
CREATE OR REPLACE FUNCTION neiist.mark_decision_notification_failed(
  m_application INT,
  m_department  VARCHAR(30),
  m_error       TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET claimed_at = NULL,
      last_error = left(coalesce(m_error, 'Erro desconhecido.'), 500)
  WHERE application_id = m_application AND department_name = m_department
    AND sent_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.mark_decision_notification_failed(INT, VARCHAR(30), TEXT)
  TO neiist_app_user;

-- Look up a token, for the onboarding page (#224, slice D).
--
-- Takes the HASH, never the plaintext — the caller hashes what the visitor presented. Returns
-- nothing for a token that is unknown, expired, or already used, so the page cannot tell those
-- apart by probing and none of them is a way in.
CREATE OR REPLACE FUNCTION neiist.find_onboarding_token(t_hash TEXT)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  full_name       TEXT,
  email           TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT n.application_id, n.department_name, a.full_name, a.email
  FROM neiist.recruitment_decision_notifications n
  JOIN neiist.recruitment_applications a ON a.id = n.application_id
  WHERE n.onboarding_token_hash = t_hash
    AND n.outcome = 'accepted'
    AND n.token_used_at IS NULL
    AND (n.token_expires_at IS NULL OR n.token_expires_at > NOW());
$$;

GRANT EXECUTE ON FUNCTION neiist.find_onboarding_token(TEXT) TO neiist_app_user;

-- Spend a token. Conditional on it still being unused, so two simultaneous submissions cannot
-- both succeed — the second gets zero rows rather than a second run of whatever it guards.
CREATE OR REPLACE FUNCTION neiist.consume_onboarding_token(t_hash TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  UPDATE neiist.recruitment_decision_notifications
  SET token_used_at = NOW()
  WHERE onboarding_token_hash = t_hash
    AND outcome = 'accepted'
    AND token_used_at IS NULL
    AND (token_expires_at IS NULL OR token_expires_at > NOW())
  RETURNING TRUE INTO v_ok;

  RETURN coalesce(v_ok, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.consume_onboarding_token(TEXT) TO neiist_app_user;

CREATE OR REPLACE FUNCTION neiist.get_team_applications(a_department VARCHAR(30))
RETURNS TABLE (
  id            INT,
  full_name     TEXT,
  istid         VARCHAR(50),
  email         TEXT,
  phone         TEXT,
  course        TEXT,
  year          INT,
  motivation    TEXT,
  status        TEXT,
  submitted_at  TIMESTAMPTZ,
  outcome       TEXT,
  note          TEXT,
  other_teams   TEXT[],
  team_decision  TEXT,
  team_actor     TEXT,
  board_decision TEXT,
  board_actor    TEXT,
  notified_at    TIMESTAMPTZ,
  notify_error   TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, a.istid, a.email, a.phone, a.course, a.year, a.motivation,
         a.status, a.submitted_at, t.outcome, t.note,
         coalesce(
           (SELECT array_agg(o.department_name ORDER BY o.department_name)
            FROM neiist.recruitment_application_teams o
            WHERE o.application_id = a.id AND o.department_name <> a_department),
           ARRAY[]::TEXT[]),
         tm.decision, tmu.name, bd.decision, bdu.name,
         n.sent_at, n.last_error
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = a_department
  LEFT JOIN neiist.recruitment_application_approvals tm
    ON tm.application_id = a.id AND tm.department_name = a_department AND tm.side = 'team'
  LEFT JOIN neiist.users tmu ON tmu.istid = tm.actor_istid
  LEFT JOIN neiist.recruitment_application_approvals bd
    ON bd.application_id = a.id AND bd.department_name = a_department AND bd.side = 'board'
  LEFT JOIN neiist.users bdu ON bdu.istid = bd.actor_istid
  LEFT JOIN neiist.recruitment_decision_notifications n
    ON n.application_id = a.id AND n.department_name = a_department
  ORDER BY (t.outcome <> 'pending'), a.submitted_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_applications(VARCHAR(30)) TO neiist_app_user;

-- The board's queue: every application across every team where the TEAM has signed and the board
-- has not. Deliberately narrow — the board is not asked to review what the team has not looked at
-- yet, which is the practical reason the two signatures are ordered in the first place.
--
-- No motivation, phone or course here: this is a work queue, not the application. The board opens
-- the team's page for the detail, where the same authorization already applies. Handing over the
-- full record of every applicant to build a list would be collecting more than the list needs.
CREATE OR REPLACE FUNCTION neiist.get_board_pending_applications()
RETURNS TABLE (
  id              INT,
  full_name       TEXT,
  department_name VARCHAR(30),
  submitted_at    TIMESTAMPTZ,
  team_decision   TEXT,
  team_actor      TEXT,
  team_note       TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.id, a.full_name, t.department_name, a.submitted_at, tm.decision, u.name, tm.note
  FROM neiist.recruitment_applications a
  JOIN neiist.recruitment_application_teams t ON t.application_id = a.id
  JOIN neiist.recruitment_application_approvals tm
    ON tm.application_id = a.id AND tm.department_name = t.department_name AND tm.side = 'team'
  LEFT JOIN neiist.users u ON u.istid = tm.actor_istid
  WHERE a.status <> 'screened_out'
    AND NOT EXISTS (
      SELECT 1 FROM neiist.recruitment_application_approvals bd
      WHERE bd.application_id = a.id AND bd.department_name = t.department_name
        AND bd.side = 'board'
    )
  ORDER BY tm.decided_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_board_pending_applications() TO neiist_app_user;

-- Retention: 6 months after the application was decided (#134, decided 2026-08-25).
--
-- These are people who may never have joined NEIIST, and the GDPR exposure in Notion is a stated
-- motivation for the whole migration (#126) — importing that problem would defeat the point.
--
-- A function rather than a scheduled job because this database has no scheduler; calling it is
-- the deploy's or an operator's job, and it is idempotent so calling it twice is harmless.
CREATE OR REPLACE FUNCTION neiist.purge_old_applications()
RETURNS INT AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM neiist.recruitment_applications
  WHERE decided_at IS NOT NULL AND decided_at < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.purge_old_applications() TO neiist_app_user;

-- 020: collaborating teams and per-event visibility (#219).
--
-- Two corrections to the model built in #129, both from how NEIIST actually works — see
-- docs/ai-workflow/how-neiist-works.md.
--
-- 1. **An event is owned by one team but worked on by several.** An event starts in Organização de
--    Eventos (or with the board, for bigger ones) and grows collaborators as the work needs them:
--    a poster pulls in Visuais, a story pulls in Divulgação. Today a Visuais member brought in to
--    make the poster **cannot see the event they are working on**.
--
-- 2. **Visibility is a choice, not a boolean.** `is_public` has two states; the núcleo needs four,
--    and the missing one is "members" — "every member should see the Jantar de Curso, but it is
--    not for the public". That cannot be said today at all.
--
-- Both are additive. `owner_department_name` keeps its meaning (accountability), so every existing
-- guard keeps working unchanged.

-- Teams helping with an event, beyond the one that owns it.
CREATE TABLE IF NOT EXISTS neiist.event_collaborating_teams (
  event_id        INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, department_name)
);

-- The read path: "which events can this team see", for collaborators.
CREATE INDEX IF NOT EXISTS idx_event_collaborators_by_department
  ON neiist.event_collaborating_teams (department_name);

-- Visibility, replacing the boolean.
--
-- Added as a new column with a DERIVED default rather than a rewrite: `is_public` stays, and is
-- kept in step by the trigger below, so anything still reading it — the public calendar, the
-- Google sync — keeps working while this lands. #137 removes `is_public` once nothing reads it.
--
-- The order matters: 'public' is the widest and 'owner' the narrowest, and code that compares
-- them should use the helper below rather than the enum's ordinal, for the reason `access_rank`
-- exists (schema.sql's `user_access_enum` taught this the hard way).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_visibility_enum') THEN
    CREATE TYPE neiist.event_visibility_enum AS ENUM ('public', 'members', 'teams', 'owner');
  END IF;
END
$$;

ALTER TABLE neiist.internal_events
  ADD COLUMN IF NOT EXISTS visibility neiist.event_visibility_enum;

-- Backfill from the boolean, which is exactly what it meant.
UPDATE neiist.internal_events
SET visibility = CASE WHEN is_public THEN 'public'::neiist.event_visibility_enum
                      ELSE 'teams'::neiist.event_visibility_enum END
WHERE visibility IS NULL;

-- **No column DEFAULT, deliberately.** A default is applied before a BEFORE INSERT trigger runs,
-- so the trigger could never tell "the caller said nothing" from "the caller said teams" — and
-- that is exactly the distinction it needs to derive visibility from `is_public` for the callers
-- that still pass only the boolean. The trigger sets it in every path instead, which is why the
-- column can still be NOT NULL.
ALTER TABLE neiist.internal_events
  ALTER COLUMN visibility DROP DEFAULT;

-- NOT NULL only after the backfill, so the migration is safe on a populated database.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'neiist' AND table_name = 'internal_events'
      AND column_name = 'visibility' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE neiist.internal_events ALTER COLUMN visibility SET NOT NULL;
  END IF;
END
$$;

-- Keep `is_public` in step with `visibility`, in both directions.
--
-- Two columns meaning one thing is exactly what this repository keeps getting bitten by, so this
-- is deliberately temporary: it exists only so that the public calendar and the Google Calendar
-- sync — which still read `is_public` — cannot disagree with the workspace while #219 lands
-- across several PRs. Removing `is_public` is #137's job, and the trigger goes with it.
CREATE OR REPLACE FUNCTION neiist.sync_event_visibility() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit visibility wins; otherwise derive it from is_public so old callers still work.
    IF NEW.visibility IS NULL THEN
      NEW.visibility := CASE WHEN NEW.is_public THEN 'public' ELSE 'teams' END;
    END IF;
    NEW.is_public := (NEW.visibility = 'public');
    RETURN NEW;
  END IF;

  -- On update, whichever column actually changed is the one the caller meant.
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    NEW.is_public := (NEW.visibility = 'public');
  ELSIF NEW.is_public IS DISTINCT FROM OLD.is_public THEN
    NEW.visibility := CASE WHEN NEW.is_public THEN 'public' ELSE 'teams' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_internal_events_visibility ON neiist.internal_events;
CREATE TRIGGER trg_internal_events_visibility
  BEFORE INSERT OR UPDATE ON neiist.internal_events
  FOR EACH ROW EXECUTE FUNCTION neiist.sync_event_visibility();

-- Teams that can see an event: the owner, plus collaborators.
-- Keyed by event id AND asking department, like every other read here (#126). Who else is working
-- on an event is itself internal: it says which teams NEIIST pulled in and therefore what the
-- event involves. An id belonging to an unrelated team returns zero rows.
CREATE OR REPLACE FUNCTION neiist.event_teams(e_id INT, asking_department VARCHAR(30))
RETURNS TABLE (department_name VARCHAR(30))
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH teams AS (
    SELECT owner_department_name AS name FROM neiist.internal_events WHERE id = e_id
    UNION
    SELECT c.department_name FROM neiist.event_collaborating_teams c WHERE c.event_id = e_id
  )
  SELECT name FROM teams
  WHERE EXISTS (SELECT 1 FROM teams t WHERE t.name = asking_department);
$$;

GRANT EXECUTE ON FUNCTION neiist.event_teams(INT, VARCHAR) TO neiist_app_user;

-- Add or remove a collaborating team.
--
-- Refuses the owner (it is already there, and a row saying otherwise would make `event_teams`
-- return a duplicate) and refuses an unknown department, rather than silently doing nothing —
-- the person adding Visuais to the poster needs to know if it did not take.
CREATE OR REPLACE FUNCTION neiist.set_event_collaborator(
  c_event_id   INT,
  c_department VARCHAR(30),
  c_add        BOOLEAN
) RETURNS VOID AS $$
DECLARE
  v_owner VARCHAR(30);
BEGIN
  SELECT owner_department_name INTO v_owner FROM neiist.internal_events WHERE id = c_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O evento não existe.' USING ERRCODE = 'NEI15';
  END IF;

  IF c_add THEN
    IF c_department = v_owner THEN
      RAISE EXCEPTION 'A equipa responsável já tem acesso ao evento.' USING ERRCODE = 'NEI14';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = c_department AND active) THEN
      RAISE EXCEPTION 'A equipa "%" não existe ou está inativa.', c_department
        USING ERRCODE = 'NEI15';
    END IF;
    INSERT INTO neiist.event_collaborating_teams (event_id, department_name)
    VALUES (c_event_id, c_department)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM neiist.event_collaborating_teams
    WHERE event_id = c_event_id AND department_name = c_department;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_event_collaborator(INT, VARCHAR(30), BOOLEAN) TO neiist_app_user;

-- The team reader, widened to collaborators.
--
-- Replaces #129's version, which matched `owner_department_name` only. Still takes a department
-- and still filters on it, so the structural invariant holds: no row-returning function reads
-- `internal_events` without either a department parameter or a visibility filter.
CREATE OR REPLACE FUNCTION neiist.get_team_internal_events(e_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  kind             TEXT,
  name             TEXT,
  description      TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  is_public        BOOLEAN,
  visibility       TEXT,
  is_owner         BOOLEAN,
  created_by_istid VARCHAR(50),
  created_by_name  VARCHAR(100),
  locations        TEXT[],
  attendee_count   INT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.description, e.starts_at, e.ends_at, e.is_public,
         e.visibility::TEXT,
         -- So the UI can show a collaborator that this is not their event to delete.
         (e.owner_department_name = e_department),
         e.created_by_istid, u.name,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[]),
         count(DISTINCT a.user_istid)::INT
  FROM neiist.internal_events e
  JOIN neiist.users u ON u.istid = e.created_by_istid
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  LEFT JOIN neiist.event_attendees a ON a.event_id = e.id
  WHERE e.owner_department_name = e_department
     -- Collaborators see it too, EXCEPT when the owner has narrowed it to themselves.
     OR (e.visibility <> 'owner' AND EXISTS (
          SELECT 1 FROM neiist.event_collaborating_teams c
          WHERE c.event_id = e.id AND c.department_name = e_department))
  GROUP BY e.id, u.name
  ORDER BY e.starts_at DESC;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_internal_events(VARCHAR(30)) TO neiist_app_user;

-- The member view, widened the same way, plus the new `members` visibility level.
--
-- A member now sees: their own teams' events (owner or collaborator), AND anything marked
-- `members` or `public` regardless of team — which is what that level is for.
CREATE OR REPLACE FUNCTION neiist.get_member_internal_events(
  u_istid       VARCHAR(50),
  u_include_past BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id              INT,
  kind            TEXT,
  name            TEXT,
  department_name VARCHAR(30),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  is_public       BOOLEAN,
  visibility      TEXT,
  locations       TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.owner_department_name, e.starts_at, e.ends_at, e.is_public,
         e.visibility::TEXT,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE (
      -- Their own teams, as owner or collaborator.
      e.owner_department_name IN (
        SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s
      )
      OR (e.visibility <> 'owner' AND EXISTS (
            SELECT 1 FROM neiist.event_collaborating_teams c
            WHERE c.event_id = e.id
              AND c.department_name IN (
                SELECT s.department_name FROM neiist.get_user_team_scopes(u_istid) s)))
      -- Or anything the núcleo as a whole is meant to see.
      OR e.visibility IN ('members', 'public')
    )
    -- Unchanged, and the important half: a caller with no scopes gets nothing. `members` events
    -- are for members, and someone with zero scopes is not one.
    AND EXISTS (SELECT 1 FROM neiist.get_user_team_scopes(u_istid) s2)
    AND (u_include_past OR e.starts_at >= NOW() - INTERVAL '1 day')
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_member_internal_events(VARCHAR(50), BOOLEAN)
  TO neiist_app_user;


-- The public reader, unchanged in behaviour but stated in the new vocabulary.
--
-- Still the ONLY function allowed to read `internal_events` without a department, and it still
-- earns that by filtering — `visibility = 'public'` where it used to say `is_public`. The
-- `pg_proc` allow-list test is updated to match.
CREATE OR REPLACE FUNCTION neiist.get_public_internal_events()
RETURNS TABLE (
  id          INT,
  name        TEXT,
  description TEXT,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  locations   TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.name, e.description, e.starts_at, e.ends_at, e.updated_at,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  WHERE e.visibility = 'public'
    AND e.kind = 'event'
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_public_internal_events() TO neiist_app_user;

-- Interview availability and booking (#218). The claim is one conditional UPDATE whose
-- success IS the reservation; see docker/migrations/024 for why that shape and not another.
-- Availability belongs to a PERSON, not a team: three coordinators of one team have three
-- different calendars, and a candidate is meeting one of them. `department_name` is carried too,
-- because the same person may coordinate for one team and merely help in another, and a candidate
-- applying to Visuais must not be offered a Fotografia interview.
CREATE TABLE IF NOT EXISTS neiist.interview_slots (
  id                SERIAL PRIMARY KEY,
  edition_id        INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE CASCADE,
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  coordinator_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid) ON DELETE CASCADE,
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  location          TEXT,

  -- A soft hold, taken when a candidate picks the slot. It becomes a booking once the interview
  -- event exists and the emails are out. Two columns rather than one because the gap between them
  -- is where a crash would otherwise lock a slot forever — an unconfirmed hold simply expires.
  held_by_application_id INT REFERENCES neiist.recruitment_applications(id) ON DELETE SET NULL,
  hold_expires_at        TIMESTAMPTZ,

  booked_application_id  INT REFERENCES neiist.recruitment_applications(id) ON DELETE SET NULL,
  booked_at              TIMESTAMPTZ,
  -- The interview itself is an `internal_event` (#129), not a second parallel calendar.
  event_id               INT REFERENCES neiist.internal_events(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT interview_slot_ends_after_start CHECK (ends_at > starts_at),
  -- One person cannot be in two places. This is also what stops a coordinator publishing the same
  -- hour twice by clicking twice.
  CONSTRAINT interview_slot_unique_per_coordinator UNIQUE (coordinator_istid, starts_at),
  -- A booking must say who and when; a free slot must not pretend to.
  CONSTRAINT interview_slot_booking_complete CHECK (
    (booked_application_id IS NULL AND booked_at IS NULL)
    OR (booked_application_id IS NOT NULL AND booked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_interview_slots_open
  ON neiist.interview_slots (edition_id, department_name, starts_at)
  WHERE booked_application_id IS NULL;

-- Publish one slot. Idempotent on (coordinator, start) so a double-click adds nothing.
CREATE OR REPLACE FUNCTION neiist.add_interview_slot(
  s_edition     INT,
  s_department  VARCHAR(30),
  s_coordinator VARCHAR(50),
  s_starts_at   TIMESTAMPTZ,
  s_ends_at     TIMESTAMPTZ,
  s_location    TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF s_ends_at <= s_starts_at THEN
    RAISE EXCEPTION 'O fim tem de ser depois do início.' USING ERRCODE = 'NEI19';
  END IF;

  INSERT INTO neiist.interview_slots
    (edition_id, department_name, coordinator_istid, starts_at, ends_at, location)
  VALUES (s_edition, s_department, s_coordinator, s_starts_at, s_ends_at,
          NULLIF(btrim(coalesce(s_location, '')), ''))
  ON CONFLICT (coordinator_istid, starts_at) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM neiist.interview_slots
    WHERE coordinator_istid = s_coordinator AND starts_at = s_starts_at;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.add_interview_slot(
  INT, VARCHAR(30), VARCHAR(50), TIMESTAMPTZ, TIMESTAMPTZ, TEXT
) TO neiist_app_user;

-- Withdraw a slot. Refuses once it is booked: the candidate has been told, and deleting the row
-- would leave them turning up to an interview nobody has.
CREATE OR REPLACE FUNCTION neiist.remove_interview_slot(
  s_id          INT,
  s_coordinator VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  DELETE FROM neiist.interview_slots
  WHERE id = s_id
    -- Only your own. A coordinator deleting a colleague's availability is not a thing anyone asked
    -- for, and scoping it here means the route cannot forget.
    AND coordinator_istid = s_coordinator
    AND booked_application_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não é possível remover: o horário não é teu ou já foi marcado.'
      USING ERRCODE = 'NEI20';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.remove_interview_slot(INT, VARCHAR(50)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- What a candidate is offered
-- ---------------------------------------------------------------------------------------------

-- Free slots for THIS candidate's team, in the round they applied to.
--
-- "Free" includes a slot whose hold has expired — otherwise somebody who opened the page and
-- wandered off would take an interview time out of circulation permanently.
--
-- Keyed by application, not by department, so a candidate cannot enumerate another team's
-- schedule by changing a parameter. The coordinator's name is returned because a candidate is
-- meeting a person and should know who; nothing else about them is.
CREATE OR REPLACE FUNCTION neiist.get_free_interview_slots(g_application INT)
RETURNS TABLE (
  id               INT,
  department_name  VARCHAR(30),
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, s.department_name, u.name, s.starts_at, s.ends_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  JOIN neiist.recruitment_applications a ON a.id = g_application
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = a.id AND t.department_name = s.department_name
  WHERE s.edition_id = a.edition_id
    AND s.starts_at > NOW()
    AND s.booked_application_id IS NULL
    AND (s.held_by_application_id IS NULL
         OR s.hold_expires_at < NOW()
         OR s.held_by_application_id = g_application)
  ORDER BY s.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_free_interview_slots(INT) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- The claim — the whole point of this file
-- ---------------------------------------------------------------------------------------------

-- Take a slot. ONE statement, whose WHERE clause is the availability test and whose success is
-- the reservation. There is deliberately no preceding "is it free?" SELECT: that gap is the race.
--
-- Returns the slot id on success and NULL when somebody else got there first, rather than raising
-- — losing a race is an ordinary outcome the page must render ("esse horário acabou de ser
-- ocupado"), not an error condition.
--
-- The hold lasts 15 minutes. Confirmation turns it into a booking; if the caller dies in between,
-- the slot returns to the pool by itself.
CREATE OR REPLACE FUNCTION neiist.claim_interview_slot(
  c_slot        INT,
  c_application INT
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  UPDATE neiist.interview_slots s
  SET held_by_application_id = c_application,
      hold_expires_at = NOW() + INTERVAL '15 minutes'
  WHERE s.id = c_slot
    AND s.starts_at > NOW()
    AND s.booked_application_id IS NULL
    AND (s.held_by_application_id IS NULL
         OR s.hold_expires_at < NOW()
         OR s.held_by_application_id = c_application)
    -- The slot must belong to a team this candidate actually applied to. Checked here rather than
    -- in the route because the claim is the only place that can be sure, and a candidate holding
    -- a slot id from another team is exactly what a guessed parameter looks like.
    AND EXISTS (
      SELECT 1 FROM neiist.recruitment_application_teams t
      JOIN neiist.recruitment_applications a ON a.id = t.application_id
      WHERE t.application_id = c_application
        AND t.department_name = s.department_name
        AND a.edition_id = s.edition_id
    )
  RETURNING s.id INTO v_id;

  -- One candidate, one interview per team: release any other hold they were carrying, so browsing
  -- back and forth does not silently reserve half the afternoon.
  IF v_id IS NOT NULL THEN
    UPDATE neiist.interview_slots
    SET held_by_application_id = NULL, hold_expires_at = NULL
    WHERE held_by_application_id = c_application
      AND id <> v_id
      AND booked_application_id IS NULL;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.claim_interview_slot(INT, INT) TO neiist_app_user;

-- Turn a held slot into a booking, once the interview event exists.
--
-- Conditional on the hold still being the caller's and still live, so a confirmation that arrives
-- after the hold expired and somebody else took the slot fails instead of double-booking.
CREATE OR REPLACE FUNCTION neiist.confirm_interview_slot(
  c_slot        INT,
  c_application INT,
  c_event       INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  UPDATE neiist.interview_slots
  SET booked_application_id = c_application,
      booked_at = NOW(),
      event_id = c_event,
      held_by_application_id = NULL,
      hold_expires_at = NULL
  WHERE id = c_slot
    AND booked_application_id IS NULL
    AND held_by_application_id = c_application
    AND hold_expires_at > NOW()
  RETURNING TRUE INTO v_ok;

  IF coalesce(v_ok, FALSE) THEN
    -- The application is now being interviewed. Derived from the booking rather than set by a
    -- caller, the same reasoning as `outcome` and `status` elsewhere in this pipeline.
    UPDATE neiist.recruitment_applications
    SET status = 'interviewing'
    WHERE id = c_application AND status = 'submitted';
  END IF;

  RETURN coalesce(v_ok, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.confirm_interview_slot(INT, INT, INT) TO neiist_app_user;

-- Cancel a booking; the slot goes back in the pool.
--
-- The interview event is deliberately NOT deleted here — it is the coordinator's calendar and
-- deleting from under them is worse than a stale entry they can remove. The link is cleared so a
-- re-booking cannot inherit it.
CREATE OR REPLACE FUNCTION neiist.cancel_interview_booking(
  c_slot        INT,
  c_application INT
) RETURNS INT AS $$
DECLARE
  v_event INT;
BEGIN
  UPDATE neiist.interview_slots
  SET booked_application_id = NULL,
      booked_at = NULL,
      event_id = NULL,
      held_by_application_id = NULL,
      hold_expires_at = NULL
  WHERE id = c_slot AND booked_application_id = c_application
  RETURNING event_id INTO v_event;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Não tens uma entrevista marcada nesse horário.' USING ERRCODE = 'NEI20';
  END IF;

  RETURN v_event;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.cancel_interview_booking(INT, INT) TO neiist_app_user;

-- Housekeeping: drop holds nobody confirmed. Idempotent, so calling it twice is harmless, and it
-- is a function rather than a scheduled job because this database has no scheduler — the same
-- decision as `purge_old_applications` (#134).
--
-- Note that the claim already treats an expired hold as free, so this is tidying rather than
-- correctness. Correctness must never depend on a cleanup job having run.
CREATE OR REPLACE FUNCTION neiist.release_expired_interview_holds() RETURNS INT AS $$
DECLARE
  v_released INT;
BEGIN
  UPDATE neiist.interview_slots
  SET held_by_application_id = NULL, hold_expires_at = NULL
  WHERE booked_application_id IS NULL
    AND held_by_application_id IS NOT NULL
    AND hold_expires_at < NOW();

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.release_expired_interview_holds() TO neiist_app_user;

-- What a coordinator sees: their own published availability and what became of it.
CREATE OR REPLACE FUNCTION neiist.get_team_interview_slots(g_department VARCHAR(30))
RETURNS TABLE (
  id               INT,
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT,
  booked_name      TEXT,
  held             BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, u.name, s.starts_at, s.ends_at, s.location, a.full_name,
         (s.held_by_application_id IS NOT NULL AND s.hold_expires_at > NOW())
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  LEFT JOIN neiist.recruitment_applications a ON a.id = s.booked_application_id
  WHERE s.department_name = g_department
  ORDER BY s.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_team_interview_slots(VARCHAR(30)) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- How a candidate reaches the page at all
-- ---------------------------------------------------------------------------------------------

-- A candidate is not a user: they have no account, and scheduling must not create one as a side
-- effect — the same rule as onboarding not creating a membership (#134), for the same reason
-- (#193). So access to the booking page is a capability, not an identity: a hashed token, issued
-- when a coordinator invites them, spent by visiting.
--
-- Hashed for the reason #223 hashes its token: it grants a stranger a page, so it is a credential,
-- and a credential in a column is one leak away from being usable.
CREATE TABLE IF NOT EXISTS neiist.interview_invites (
  application_id  INT NOT NULL,
  department_name VARCHAR(30) NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      VARCHAR(50) REFERENCES neiist.users(istid),

  PRIMARY KEY (application_id, department_name),
  FOREIGN KEY (application_id, department_name)
    REFERENCES neiist.recruitment_application_teams(application_id, department_name)
    ON DELETE CASCADE
);

-- Invite a candidate to book. Replaces any previous invite for the same (application, team) so a
-- coordinator re-sending does not leave two live tokens for one person.
CREATE OR REPLACE FUNCTION neiist.issue_interview_invite(
  i_application INT,
  i_department  VARCHAR(30),
  i_token_hash  TEXT,
  i_expires_at  TIMESTAMPTZ,
  i_actor       VARCHAR(50)
) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM neiist.recruitment_application_teams
    WHERE application_id = i_application AND department_name = i_department
  ) THEN
    RAISE EXCEPTION 'Esta candidatura não inclui essa equipa.' USING ERRCODE = 'NEI20';
  END IF;

  INSERT INTO neiist.interview_invites
    (application_id, department_name, token_hash, expires_at, created_by)
  VALUES (i_application, i_department, i_token_hash, i_expires_at, i_actor)
  ON CONFLICT (application_id, department_name) DO UPDATE
  SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      created_at = NOW(),
      created_by = EXCLUDED.created_by;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.issue_interview_invite(
  INT, VARCHAR(30), TEXT, TIMESTAMPTZ, VARCHAR(50)
) TO neiist_app_user;

-- Resolve a token to the candidate it belongs to. Takes the HASH, never the plaintext.
--
-- Returns nothing for unknown, expired, or an application that has since been decided — a
-- candidate who has already had their answer has no interview to book, and the same empty result
-- for all three means probing distinguishes nothing.
CREATE OR REPLACE FUNCTION neiist.find_interview_invite(t_hash TEXT)
RETURNS TABLE (
  application_id  INT,
  department_name VARCHAR(30),
  full_name       TEXT,
  email           TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT i.application_id, i.department_name, a.full_name, a.email
  FROM neiist.interview_invites i
  JOIN neiist.recruitment_applications a ON a.id = i.application_id
  JOIN neiist.recruitment_application_teams t
    ON t.application_id = i.application_id AND t.department_name = i.department_name
  WHERE i.token_hash = t_hash
    AND i.expires_at > NOW()
    AND t.outcome = 'pending'
    AND a.status <> 'screened_out';
$$;

GRANT EXECUTE ON FUNCTION neiist.find_interview_invite(TEXT) TO neiist_app_user;

-- The candidate's own booking, for the page to show after they have chosen.
CREATE OR REPLACE FUNCTION neiist.get_interview_booking(g_application INT, g_department VARCHAR(30))
RETURNS TABLE (
  slot_id          INT,
  coordinator_name TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT s.id, u.name, s.starts_at, s.ends_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  WHERE s.booked_application_id = g_application
    AND s.department_name = g_department;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_interview_booking(INT, VARCHAR(30)) TO neiist_app_user;

-- Who the confirmation emails go to. One query rather than three, so the send path holds no
-- transaction open while it assembles addresses.
CREATE OR REPLACE FUNCTION neiist.get_interview_notification_targets(g_slot INT)
RETURNS TABLE (
  candidate_name   TEXT,
  candidate_email  TEXT,
  coordinator_name TEXT,
  coordinator_mail TEXT,
  department_name  VARCHAR(30),
  starts_at        TIMESTAMPTZ,
  location         TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.full_name, a.email, u.name, u.email, s.department_name, s.starts_at, s.location
  FROM neiist.interview_slots s
  JOIN neiist.recruitment_applications a ON a.id = s.booked_application_id
  JOIN neiist.users u ON u.istid = s.coordinator_istid
  WHERE s.id = g_slot;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_interview_notification_targets(INT) TO neiist_app_user;

-- Notion import bookkeeping (#210). `notion_page_id` is unique and NULL for anything born
-- in the website, which is what makes re-running the importer safe and lets #137 tell the two
-- apart when the Notion sync is retired.
ALTER TABLE neiist.internal_events
  ADD COLUMN IF NOT EXISTS notion_page_id TEXT;

-- Partial, so the many native rows with NULL do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_events_notion_page
  ON neiist.internal_events (notion_page_id)
  WHERE notion_page_id IS NOT NULL;

COMMENT ON COLUMN neiist.internal_events.notion_page_id IS
  'The Notion page this row was imported from (#210). NULL means it was created in the website. '
  'Unique, so re-running the importer updates instead of duplicating. #137 uses it to tell '
  'imported rows from native ones when the Notion sync is retired.';

-- Import or update one event, atomically, with everything that hangs off it.
--
-- Modelled on `create_internal_event` (#129) rather than written fresh, because the same rule
-- applies: an event and its locations and attendees are one thing, and a partial event is worse
-- than none. The difference is the conflict target — this one is an upsert keyed on the Notion
-- page, so it is safe to run twice.
--
-- Attendees are matched by the CALLER (the importer resolves Notion people to istids and reports
-- the ones it cannot); this function takes istids and, following #129, silently drops any that do
-- not exist rather than losing the whole event over one stale roster entry.
CREATE OR REPLACE FUNCTION neiist.import_internal_event(
  i_notion_page   TEXT,
  i_kind          TEXT,
  i_name          TEXT,
  i_starts_at     TIMESTAMPTZ,
  i_ends_at       TIMESTAMPTZ,
  i_visibility    neiist.event_visibility_enum,
  i_department    VARCHAR(30),
  i_created_by    VARCHAR(50),
  i_locations     TEXT[] DEFAULT ARRAY[]::TEXT[],
  i_attendees     VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[],
  i_collaborators VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[]
) RETURNS INT AS $$
DECLARE
  v_id INT;
BEGIN
  IF i_kind NOT IN ('event', 'meeting') THEN
    RAISE EXCEPTION 'Tipo inválido: use "event" ou "meeting".' USING ERRCODE = 'NEI14';
  END IF;

  -- The owning team is a foreign key, and a Notion team name that does not match must fail LOUDLY
  -- rather than be dropped. Raised here, not just relied upon from the FK, so the message names
  -- the department instead of quoting a constraint.
  IF NOT EXISTS (SELECT 1 FROM neiist.departments WHERE name = i_department) THEN
    RAISE EXCEPTION 'O departamento "%" não existe.', i_department USING ERRCODE = 'NEI15';
  END IF;

  INSERT INTO neiist.internal_events
    (kind, name, starts_at, ends_at, visibility, owner_department_name, created_by_istid,
     notion_page_id)
  VALUES (i_kind, i_name, i_starts_at, i_ends_at, i_visibility, i_department, i_created_by,
          i_notion_page)
  ON CONFLICT (notion_page_id) WHERE notion_page_id IS NOT NULL DO UPDATE
  SET kind = EXCLUDED.kind,
      name = EXCLUDED.name,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      visibility = EXCLUDED.visibility,
      owner_department_name = EXCLUDED.owner_department_name
  RETURNING id INTO v_id;

  -- Locations and attendees are replaced, not merged: Notion is the source of truth for the rows
  -- it owns, and a merge would make a removal in Notion invisible here forever.
  DELETE FROM neiist.event_locations WHERE event_id = v_id;
  INSERT INTO neiist.event_locations (event_id, location)
  SELECT v_id, loc FROM unnest(i_locations) AS loc WHERE btrim(loc) <> '';

  DELETE FROM neiist.event_attendees WHERE event_id = v_id;
  -- The unnest alias is deliberately NOT called `istid`: inside the EXISTS subquery that name
  -- would rebind to `users.istid`, making the condition `u.istid = u.istid` — always true, so
  -- every unknown attendee would reach the foreign key and blow up the whole import. Caught by
  -- test, not by reading.
  INSERT INTO neiist.event_attendees (event_id, user_istid)
  SELECT v_id, candidate FROM unnest(i_attendees) AS candidate
  WHERE EXISTS (SELECT 1 FROM neiist.users u WHERE u.istid = candidate)
  ON CONFLICT DO NOTHING;

  -- Collaborating teams (#219). The importer uses this for the one Notion value that names two
  -- groups at once — "Coordenação/Direção" — rather than silently picking one of them.
  DELETE FROM neiist.event_collaborating_teams WHERE event_id = v_id;
  INSERT INTO neiist.event_collaborating_teams (event_id, department_name)
  SELECT v_id, dept FROM unnest(i_collaborators) AS dept
  WHERE dept <> i_department
    AND EXISTS (SELECT 1 FROM neiist.departments d WHERE d.name = dept)
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.import_internal_event(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, neiist.event_visibility_enum,
  VARCHAR(30), VARCHAR(50), TEXT[], VARCHAR(50)[], VARCHAR(30)[]
) TO neiist_app_user;

-- Does this Notion page already reach /activities through the old sync?
--
-- `neiist.activities.id` IS the Notion page id, which makes this exact rather than a guess about
-- matching titles and dates. It matters because 16 of the 52 events are public: importing them
-- as `visibility = 'public'` while the Notion -> activities sync still runs would show every one
-- of them TWICE on the students' calendar. The importer uses this to import them members-only and
-- say so; #137 retires the sync and flips them.
CREATE OR REPLACE FUNCTION neiist.activity_exists(a_notion_page TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM neiist.activities WHERE id = a_notion_page);
$$;

GRANT EXECUTE ON FUNCTION neiist.activity_exists(TEXT) TO neiist_app_user;
-- Onboarding an accepted candidate, and the team's own links (#224, #225).
-- Nothing here creates a membership: see docker/migrations/026 for why that is load-bearing.
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
-- Handing the public calendar from the Notion sync to the workspace (#137, first slice).
-- Run deliberately, after the import, once somebody has looked at the events. See migration 027.
-- Report first: what WOULD be promoted, and what would be left behind.
--
-- The second half matters more than the first. An `activities` row with no imported event is a
-- public event that exists ONLY in the old sync — promoting the others and later switching the
-- sync off would silently drop it from the calendar. Nobody would notice until a student did.
CREATE OR REPLACE FUNCTION neiist.public_calendar_handover_report()
RETURNS TABLE (
  status         TEXT,
  notion_page_id TEXT,
  title          TEXT,
  starts_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Imported, currently members-only, and the sync is still publishing it: ready to hand over.
  SELECT 'ready'::TEXT, e.notion_page_id, e.name, e.starts_at
  FROM neiist.internal_events e
  JOIN neiist.activities a ON a.id = e.notion_page_id
  WHERE e.notion_page_id IS NOT NULL
    AND e.visibility = 'members'
  UNION ALL
  -- Published by the sync with no imported counterpart. Handing over without importing these
  -- first would remove them from the students' calendar.
  SELECT 'orphan_activity'::TEXT, a.id, a.title, a.start
  FROM neiist.activities a
  WHERE NOT EXISTS (
    SELECT 1 FROM neiist.internal_events e WHERE e.notion_page_id = a.id
  )
  ORDER BY 1, 4;
$$;

GRANT EXECUTE ON FUNCTION neiist.public_calendar_handover_report() TO neiist_app_user;

-- Do the handover.
--
-- **Refuses while any orphan exists**, unless explicitly forced. That guard is the whole safety
-- property: an orphan means the import did not cover everything the sync publishes, and finishing
-- the handover in that state removes a real event from the students' calendar. Failing loudly is
-- the only outcome somebody notices.
--
-- Each promotion and its matching deletion happen together — this function runs in a single
-- implicit transaction, so there is no moment where an event is neither published by the sync nor
-- public in the workspace.
CREATE OR REPLACE FUNCTION neiist.hand_over_public_calendar(h_force BOOLEAN DEFAULT FALSE)
RETURNS INT AS $$
DECLARE
  v_orphans  INT;
  v_promoted INT;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM neiist.public_calendar_handover_report()
  WHERE status = 'orphan_activity';

  IF v_orphans > 0 AND NOT h_force THEN
    RAISE EXCEPTION
      'Há % atividades publicadas pela sync do Notion sem evento importado. Corre o import '
      'primeiro, ou chama esta função com force := TRUE se souberes que podem desaparecer '
      'do calendário.', v_orphans
      USING ERRCODE = 'NEI15';
  END IF;

  WITH promoted AS (
    UPDATE neiist.internal_events e
    SET visibility = 'public'
    FROM neiist.activities a
    WHERE a.id = e.notion_page_id
      AND e.notion_page_id IS NOT NULL
      AND e.visibility = 'members'
    RETURNING e.notion_page_id
  ),
  removed AS (
    DELETE FROM neiist.activities
    WHERE id IN (SELECT notion_page_id FROM promoted)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted FROM removed;

  RETURN v_promoted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.hand_over_public_calendar(BOOLEAN) TO neiist_app_user;
-- Requerimentos: how the teams ask each other for work (#232, slice A of #131).
-- The requesting team asks; the TARGET team owns the status and the deliverables.
-- See docker/migrations/028 for why that asymmetry is the whole authorization model.
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
-- The shared checklist — the To-do List from the Notion protocol (#242).
-- The requesting team says what is expected; the target team says what is done.
-- See docker/migrations/032 for why `source` exists.
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

-- Functions replacing four queries that read tables directly (#029).
-- `neiist_app_user` has NO table privileges by design (schema.sql:11-16); every access goes
-- through a SECURITY DEFINER function. See docker/migrations/029.
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

-- Every internal event, for the board's "all teams" filter (#241).
-- UNSCOPED: safe only because /activities calls it behind `is_board_signatory`.
-- See docker/migrations/030 for why the guard is at the call site and not in here.
CREATE OR REPLACE FUNCTION neiist.get_all_internal_events()
RETURNS TABLE (
  id              INT,
  kind            TEXT,
  name            TEXT,
  department_name VARCHAR(30),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  is_public       BOOLEAN,
  visibility      TEXT,
  locations       TEXT[]
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT e.id, e.kind, e.name, e.owner_department_name, e.starts_at, e.ends_at, e.is_public,
         e.visibility::TEXT,
         coalesce(array_agg(DISTINCT l.location) FILTER (WHERE l.location IS NOT NULL),
                  ARRAY[]::TEXT[])
  FROM neiist.internal_events e
  LEFT JOIN neiist.event_locations l ON l.event_id = e.id
  GROUP BY e.id
  ORDER BY e.starts_at;
$$;

GRANT EXECUTE ON FUNCTION neiist.get_all_internal_events() TO neiist_app_user;
