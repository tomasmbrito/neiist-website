import { Fragment } from "react";
import { UserRole } from "@/types/user";
import {
  PERMISSION_LABELS,
  ROLE_LABELS,
  permissionsByDomain,
  rolesFor,
} from "@/lib/auth/permissions";
import styles from "@/styles/components/admin/PermissionMatrix.module.css";

/**
 * Read-only view of the authorization policy the server actually enforces (#157).
 *
 * Generated from `PERMISSION_ROLES`, never hand-maintained: adding a permission makes it appear
 * here with no further edit, and `PERMISSION_LABELS` is a total record so forgetting to label
 * one fails `yarn type:check` rather than rendering a bare key.
 *
 * Editing lives elsewhere — #158 changes which access level a *department role* grants, and
 * #159 will add per-member overrides. This screen answers "what does each level mean?", which
 * until now could only be answered by grepping ~50 files.
 */

const DOMAIN_LABELS: Record<string, string> = {
  org: "Estrutura",
  members: "Membros",
  teams: "Equipas",
  users: "Utilizadores",
  activities: "Atividades",
  shop: "Loja",
};

// _GUEST holds nothing by construction, so a column for it would be dead space.
const COLUMNS: UserRole[] = [
  UserRole._ADMIN,
  UserRole._COORDINATOR,
  UserRole._SHOP_MANAGER,
  UserRole._MEMBER,
];

export default function PermissionMatrix() {
  const groups = permissionsByDomain();

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Permissões</h1>
      <p className={styles.intro}>
        O que cada nível de acesso permite fazer. Esta tabela é gerada a partir das regras que o
        servidor aplica, por isso reflete sempre o comportamento real. Para alterar o nível de
        acesso de um cargo, usa a Gestão de Cargos.
      </p>

      {/* Wide tables scroll inside their own container rather than the page. */}
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.permissionHeader}>
                Permissão
              </th>
              {COLUMNS.map((role) => (
                <th key={role} scope="col" className={styles.roleHeader}>
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ domain, permissions }) => (
              <Fragment key={domain}>
                <tr className={styles.groupRow}>
                  <th scope="rowgroup" colSpan={COLUMNS.length + 1} className={styles.groupCell}>
                    {DOMAIN_LABELS[domain] ?? domain}
                  </th>
                </tr>
                {permissions.map((permission) => {
                  const granted = rolesFor(permission);
                  return (
                    <tr key={permission}>
                      <th scope="row" className={styles.permissionCell}>
                        {PERMISSION_LABELS[permission]}
                        <code className={styles.permissionKey}>{permission}</code>
                      </th>
                      {COLUMNS.map((role) => {
                        const has = granted.includes(role);
                        return (
                          <td
                            key={role}
                            className={has ? styles.yes : styles.no}
                            /* The glyph is decorative; the label is what a screen reader reads. */
                            aria-label={`${ROLE_LABELS[role]}: ${has ? "permitido" : "não permitido"}`}>
                            <span aria-hidden="true">{has ? "●" : "–"}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
