import os
import re

USER_FUNCS = ["createUser", "updateUser", "updateUserPhoto", "getUser", "getAllUsers", "getUsersByAccess", "addEmailVerification", "getEmailVerification", "deleteEmailVerification", "getEmailVerificationByUser"]
SHOP_FUNCS = ["addProduct", "addProductVariant", "getAllProducts", "getAllProductsAdmin", "deleteProduct", "deleteProductVariant", "getProduct", "updateProduct", "updateProductVariant", "getAllDiscountCodes", "createDiscountCode", "updateDiscountCode", "deleteDiscountCode", "validateDiscountCode", "getAllCategories", "addCategory", "newOrder", "getAllOrders", "getOrderById", "getOrderByNumber", "getUserOrderedProductsInCategory", "updateOrder", "setOrderState", "mapOrderDbErrorToResponse", "mapDeleteProductDbErrorToResponse"]
EVENT_FUNCS = ["updateActivitiesEvent", "signUpToEvent", "removeSignUpFromEvent", "updateActivityProperties", "getEventSubscribers", "getActivitiesEventsFromDb", "deleteActivitiesEvent"]
TEAM_FUNCS = ["addMember", "addCollaborator", "removeRole", "getDepartmentRoles", "addDepartment", "removeDepartment", "getAllDepartments", "addTeam", "removeTeam", "getAllTeams", "addAdminBody", "removeAdminBody", "getAllAdminBodies", "addValidDepartmentRole", "removeValidDepartmentRole", "getAllValidDepartmentRoles", "addTeamMember", "removeTeamMember", "getAllMemberships", "getDepartmentRoleOrder", "setDepartmentRoleOrder"]

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    original_content = content

    # Handle imports from @/utils/dbUtils
    # Usually it looks like: import { foo, bar } from "@/utils/dbUtils";
    # Since it can be multiline, we will use regex to find the whole import block.
    pattern = re.compile(r'import\s+\{([^}]+)\}\s+from\s+["\']@/utils/dbUtils["\'];?', re.MULTILINE)
    
    def replacer(match):
        imported_funcs = [x.strip() for x in match.group(1).split(',')]
        imports_map = {'User': [], 'Shop': [], 'Event': [], 'Team': []}
        
        for func in imported_funcs:
            if not func: continue
            if func in USER_FUNCS: imports_map['User'].append(func)
            elif func in SHOP_FUNCS: imports_map['Shop'].append(func)
            elif func in EVENT_FUNCS: imports_map['Event'].append(func)
            elif func in TEAM_FUNCS: imports_map['Team'].append(func)
            else:
                # If there's an unknown function, we keep it as User for safety, or log it
                imports_map['User'].append(func)

        replacements = []
        if imports_map['User']: replacements.append('import { UserRepository } from "@/lib/db/repositories/user.repository";')
        if imports_map['Shop']: replacements.append('import { ShopRepository } from "@/lib/db/repositories/shop.repository";')
        if imports_map['Event']: replacements.append('import { EventRepository } from "@/lib/db/repositories/event.repository";')
        if imports_map['Team']: replacements.append('import { TeamRepository } from "@/lib/db/repositories/team.repository";')
        
        return "\n".join(replacements)

    content = pattern.sub(replacer, content)

    # If nothing changed, return
    if content == original_content and "jwtUser.istid" not in content and "dbUtils" not in content:
        # Also let's just blindly update jwtUser.istid to jwtUser.id
        content = content.replace("jwtUser?.istid", "jwtUser?.id")
        content = content.replace("jwtUser.istid", "jwtUser.id")
        content = content.replace("session.istid", "session.id")
        if content == original_content:
            return False

    content = content.replace("jwtUser?.istid", "jwtUser?.id")
    content = content.replace("jwtUser.istid", "jwtUser.id")
    content = content.replace("session.istid", "session.id")

    # Replace function calls
    for func in USER_FUNCS:
        content = re.sub(r'\b' + func + r'\(', f'UserRepository.{func}(', content)
    for func in SHOP_FUNCS:
        content = re.sub(r'\b' + func + r'\(', f'ShopRepository.{func}(', content)
    for func in EVENT_FUNCS:
        content = re.sub(r'\b' + func + r'\(', f'EventRepository.{func}(', content)
    for func in TEAM_FUNCS:
        content = re.sub(r'\b' + func + r'\(', f'TeamRepository.{func}(', content)

    with open(filepath, 'w') as f:
        f.write(content)
    return True

changed_files = 0
for root, _, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts') or file.endswith('.tsx'):
            if process_file(os.path.join(root, file)):
                changed_files += 1

print(f"Refactored {changed_files} files.")
