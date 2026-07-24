-- 1. Create user_identities table
CREATE TABLE IF NOT EXISTS neiist.user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_id TEXT NOT NULL,
  UNIQUE(provider, provider_id)
);

-- 2. Add id UUID to users
ALTER TABLE neiist.users ADD COLUMN id UUID DEFAULT gen_random_uuid();

-- 3. Add user_id column to dependent tables
ALTER TABLE neiist.user_courses ADD COLUMN user_id UUID;
ALTER TABLE neiist.user_contacts ADD COLUMN user_id UUID;
ALTER TABLE neiist.email_token ADD COLUMN user_id UUID;
ALTER TABLE neiist.membership ADD COLUMN user_id UUID;
ALTER TABLE neiist.activities_sign_up ADD COLUMN user_id UUID;
ALTER TABLE neiist.orders ADD COLUMN user_id UUID;

-- 4. Populate user_id based on users.id
UPDATE neiist.user_courses t SET user_id = u.id FROM neiist.users u WHERE t.user_istid = u.istid;
UPDATE neiist.user_contacts t SET user_id = u.id FROM neiist.users u WHERE t.user_istid = u.istid;
UPDATE neiist.email_token t SET user_id = u.id FROM neiist.users u WHERE t.istid = u.istid;
UPDATE neiist.membership t SET user_id = u.id FROM neiist.users u WHERE t.user_istid = u.istid;
UPDATE neiist.activities_sign_up t SET user_id = u.id FROM neiist.users u WHERE t.user_istid = u.istid;
UPDATE neiist.orders t SET user_id = u.id FROM neiist.users u WHERE t.user_istid = u.istid;

-- 5. Drop old foreign keys and primary keys
ALTER TABLE neiist.user_courses DROP CONSTRAINT IF EXISTS user_courses_user_istid_fkey;
ALTER TABLE neiist.user_contacts DROP CONSTRAINT IF EXISTS user_contacts_user_istid_fkey;
ALTER TABLE neiist.email_token DROP CONSTRAINT IF EXISTS email_token_istid_fkey;
ALTER TABLE neiist.membership DROP CONSTRAINT IF EXISTS membership_user_istid_fkey;
ALTER TABLE neiist.activities_sign_up DROP CONSTRAINT IF EXISTS activities_sign_up_user_istid_fkey;
ALTER TABLE neiist.orders DROP CONSTRAINT IF EXISTS orders_user_istid_fkey;

ALTER TABLE neiist.user_courses DROP CONSTRAINT IF EXISTS user_courses_pkey;
ALTER TABLE neiist.user_contacts DROP CONSTRAINT IF EXISTS user_contacts_pkey;
ALTER TABLE neiist.membership DROP CONSTRAINT IF EXISTS membership_pkey;
ALTER TABLE neiist.activities_sign_up DROP CONSTRAINT IF EXISTS activities_sign_up_pkey;
ALTER TABLE neiist.users DROP CONSTRAINT IF EXISTS users_pkey CASCADE;

-- 6. Establish new Primary Key on users
ALTER TABLE neiist.users ADD PRIMARY KEY (id);
ALTER TABLE neiist.users ADD CONSTRAINT users_istid_key UNIQUE (istid);

-- 7. Make user_id NOT NULL and add foreign keys
ALTER TABLE neiist.user_courses ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE neiist.user_courses ADD CONSTRAINT user_courses_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.user_courses DROP COLUMN user_istid;
ALTER TABLE neiist.user_courses ADD PRIMARY KEY (user_id, course_name);

ALTER TABLE neiist.user_contacts ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE neiist.user_contacts ADD CONSTRAINT user_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.user_contacts DROP COLUMN user_istid;
ALTER TABLE neiist.user_contacts ADD PRIMARY KEY (user_id, contact_type);

ALTER TABLE neiist.email_token ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE neiist.email_token ADD CONSTRAINT email_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.email_token DROP COLUMN istid;

ALTER TABLE neiist.membership ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE neiist.membership ADD CONSTRAINT membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.membership DROP COLUMN user_istid;
ALTER TABLE neiist.membership ADD PRIMARY KEY (user_id, department_name, role_name);

ALTER TABLE neiist.activities_sign_up ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE neiist.activities_sign_up ADD CONSTRAINT activities_sign_up_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.activities_sign_up DROP COLUMN user_istid;
ALTER TABLE neiist.activities_sign_up ADD PRIMARY KEY (event_id, user_id);

ALTER TABLE neiist.orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
ALTER TABLE neiist.orders DROP COLUMN user_istid;
ALTER TABLE neiist.orders DROP CONSTRAINT IF EXISTS orders_identity_mode_chk;
ALTER TABLE neiist.orders ADD CONSTRAINT orders_identity_mode_chk CHECK (
    user_id IS NULL
    OR (customer_name IS NULL AND customer_email IS NULL AND customer_phone IS NULL)
);

-- Fix indexes
DROP INDEX IF EXISTS neiist.idx_user_preferred_contact;
CREATE UNIQUE INDEX idx_user_preferred_contact ON neiist.user_contacts (user_id, is_preferred) WHERE is_preferred = TRUE;

DROP INDEX IF EXISTS neiist.idx_membership_active;
CREATE INDEX idx_membership_active ON neiist.membership (user_id, to_date) WHERE to_date IS NULL;

DROP INDEX IF EXISTS neiist.idx_orders_user_istid;
CREATE INDEX idx_orders_user_id ON neiist.orders(user_id);

-- 8. Finalize user_identities constraints and backfill
ALTER TABLE neiist.user_identities ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES neiist.users(id) ON DELETE CASCADE;
INSERT INTO neiist.user_identities (user_id, provider, provider_id)
SELECT id, 'fenix', istid FROM neiist.users WHERE istid IS NOT NULL;
