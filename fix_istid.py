import os
import re

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    original_content = content

    content = content.replace("user_istid", "user_id")
    # Some specific fixes
    content = content.replace("user.istid || ''", "user.istid ?? ''")
    content = content.replace("u.istid || ''", "u.istid ?? ''")

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        return True
    return False

changed_files = 0
for root, _, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts') or file.endswith('.tsx'):
            if process_file(os.path.join(root, file)):
                changed_files += 1

print(f"Replaced user_istid in {changed_files} files.")
