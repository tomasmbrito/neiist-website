import re

with open('docker/schema.sql', 'r') as f:
    content = f.read()

# 1. Update users table and add identities table
content = content.replace(
    "  istid VARCHAR(10) PRIMARY KEY,",
    "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  istid VARCHAR(10) UNIQUE,"
)

identities_table = """
-- AUTH IDENTITIES
CREATE TABLE neiist.user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES neiist.users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_id TEXT NOT NULL,
  UNIQUE(provider, provider_id)
);
"""
content = content.replace("  photo_path TEXT\n);\n", f"  photo_path TEXT\n);\n\n{identities_table}")

# 2. Update all table definitions referring to user_istid or istid
content = content.replace("user_istid VARCHAR(10) REFERENCES neiist.users(istid)", "user_id UUID REFERENCES neiist.users(id)")
content = content.replace("istid VARCHAR(10) NOT NULL REFERENCES neiist.users(istid)", "user_id UUID NOT NULL REFERENCES neiist.users(id)")
content = content.replace("PRIMARY KEY (user_istid, ", "PRIMARY KEY (user_id, ")
content = content.replace("PRIMARY KEY (event_id, user_istid)", "PRIMARY KEY (event_id, user_id)")
content = content.replace("ON neiist.user_contacts (user_istid, is_preferred)", "ON neiist.user_contacts (user_id, is_preferred)")
content = content.replace("CREATE INDEX idx_membership_active ON neiist.membership (user_istid, to_date)", "CREATE INDEX idx_membership_active ON neiist.membership (user_id, to_date)")
content = content.replace("idx_orders_user_istid ON neiist.orders(user_istid)", "idx_orders_user_id ON neiist.orders(user_id)")
content = content.replace("user_istid IS NULL", "user_id IS NULL")

# 3. Update function parameters & returns
content = content.replace("u_istid VARCHAR(10)", "p_user_id UUID")
content = content.replace("p_istid VARCHAR(10)", "p_user_id UUID")
content = content.replace("u_user_istid VARCHAR(10)", "p_user_id UUID")
content = content.replace("istid VARCHAR(10),", "id UUID,\n  istid VARCHAR(10),")

# 4. Function bodies & query logic
content = content.replace("u.istid = u_istid", "u.id = p_user_id")
content = content.replace("u.istid = p_istid", "u.id = p_user_id")
content = content.replace("user_istid = u.istid", "user_id = u.id")
content = content.replace("user_istid = u_istid", "user_id = p_user_id")
content = content.replace("user_istid = p_istid", "user_id = p_user_id")
content = content.replace("user_istid = u_user_istid", "user_id = p_user_id")
content = content.replace("SELECT\n    u.istid,", "SELECT\n    u.id,\n    u.istid,")
content = content.replace("SELECT p_istid,", "SELECT p_user_id,")
content = content.replace("WHERE istid = p_istid", "WHERE id = p_user_id")
content = content.replace("WHERE istid = u_user_istid", "WHERE id = p_user_id")
content = content.replace("(user_istid, contact_type", "(user_id, contact_type")
content = content.replace("VALUES (p_istid, 'alt_email'", "VALUES (p_user_id, 'alt_email'")
content = content.replace("VALUES (p_istid, 'phone'", "VALUES (p_user_id, 'phone'")
content = content.replace("(user_istid, course_name)", "(user_id, course_name)")
content = content.replace("SELECT p_istid, unnest(p_courses)", "SELECT p_user_id, unnest(p_courses)")
content = content.replace("(user_istid, department_name, role_name)", "(user_id, department_name, role_name)")
content = content.replace("VALUES (u_user_istid, u_department_name, u_role_name)", "VALUES (p_user_id, u_department_name, u_role_name)")
content = content.replace("neiist.get_user(p_istid)", "neiist.get_user(p_user_id)")

with open('docker/schema.sql', 'w') as f:
    f.write(content)

print("schema.sql refactored successfully.")
