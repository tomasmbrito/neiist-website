"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import Fuse from "fuse.js";
import styles from "@/styles/components/admin/RolesSearchFilter.module.css";
import { toast } from "sonner";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { UserRole } from "@/types/user";

interface Role {
  role_name: string;
  access: string;
  active: boolean;
  department?: string;
  /** How many people currently hold this role. Returned by GET so a change can state its impact. */
  memberCount?: number;
}

/**
 * The access levels a role may grant, in increasing order of power.
 *
 * Derived from `ROLE_LABELS` rather than hardcoded here, so the catalogue in
 * `src/lib/auth/permissions.ts` stays the one place that names an access level. Previously this
 * screen carried its own Portuguese strings and called `guest` "Normal" while the rest of the
 * site called it "Convidado".
 */
const ACCESS_OPTIONS: UserRole[] = [
  UserRole._GUEST,
  UserRole._MEMBER,
  UserRole._SHOP_MANAGER,
  UserRole._COORDINATOR,
  UserRole._ADMIN,
];

/**
 * The levels this caller may actually set (#193).
 *
 * `_ADMIN` is organisation-wide, so granting it is a separate permission held only by admins.
 * A role that is *already* admin still renders its current value — hiding it would make the
 * select silently misreport the role as something it is not.
 */
const optionsFor = (mayGrantAdmin: boolean, current?: string): UserRole[] =>
  ACCESS_OPTIONS.filter(
    (option) => option !== UserRole._ADMIN || mayGrantAdmin || current === UserRole._ADMIN
  );

interface Department {
  name: string;
  department_type: string;
  active: boolean;
}

export default function RolesSearchFilter({
  departments,
  initialRoles,
  mayGrantAdmin,
}: {
  departments: Department[];
  initialDepartment: string;
  initialRoles: Role[];
  /** Decided on the server (#193). The API and SQL re-check it; this only shapes the options. */
  mayGrantAdmin: boolean;
}) {
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [selectedDepartment, setSelectedDepartment] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addDepartment, setAddDepartment] = useState<string>("");
  const [newRole, setNewRole] = useState({ roleName: "", access: "member" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  // One dialog, two actions. Both are consequential — removing a role ends every current
  // membership of it, and changing its access changes what its holders can do immediately — so
  // neither should happen on a single unconfirmed click.
  const [pendingAction, setPendingAction] = useState<
    | { kind: "remove"; roleName: string; departmentName?: string }
    | {
        kind: "access";
        roleName: string;
        departmentName?: string;
        access: string;
        previousAccess: string;
        memberCount: number;
      }
    | null
  >(null);

  const fetchRoles = useCallback(async (department: string) => {
    if (!department) return;
    try {
      const response = await fetch(`/api/admin/roles?department=${encodeURIComponent(department)}`);
      if (response.ok) {
        const data = await response.json();
        setRoles(data.map((r: Role) => ({ ...r, department })));
      } else setRoles([]);
    } catch {
      setRoles([]);
    }
  }, []);

  const fetchAllRoles = useCallback(async () => {
    try {
      const results = await Promise.all(
        departments.map(async (dept) => {
          const response = await fetch(
            `/api/admin/roles?department=${encodeURIComponent(dept.name)}`
          );
          if (response.ok) {
            const data = await response.json();
            return data.map((r: Role) => ({ ...r, department: dept.name }));
          }
          return [];
        })
      );
      setRoles(results.flat());
    } catch {
      setRoles([]);
    }
  }, [departments]);

  useEffect(() => {
    if (selectedDepartment === "") {
      fetchAllRoles();
    } else if (selectedDepartment) {
      fetchRoles(selectedDepartment);
    } else {
      setRoles([]);
    }
  }, [selectedDepartment, fetchAllRoles, fetchRoles]);

  const addRole = async () => {
    if (!newRole.roleName.trim() || !addDepartment) return;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentName: addDepartment,
          roleName: newRole.roleName,
          access: newRole.access,
        }),
      });
      if (response.ok) {
        setNewRole({ roleName: "", access: "member" });
        if (addDepartment === selectedDepartment || selectedDepartment === "") {
          if (selectedDepartment === "") {
            await fetchAllRoles();
          } else {
            await fetchRoles(selectedDepartment);
          }
        }
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        const error = await response.json();
        toast.error(error.error || "Erro ao adicionar cargo", { closeButton: true });
      }
    } catch {
      toast.error("Erro ao adicionar cargo", { closeButton: true });
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveClick = (roleName: string, departmentName?: string) => {
    setPendingAction({ kind: "remove", roleName, departmentName });
    setConfirmOpen(true);
  };

  const handleAccessChange = (role: Role, access: string) => {
    if (access === role.access) return;
    setPendingAction({
      kind: "access",
      roleName: role.role_name,
      departmentName: role.department,
      access,
      previousAccess: role.access,
      memberCount: role.memberCount ?? 0,
    });
    setConfirmOpen(true);
  };

  const refreshRoles = async (dept: string) => {
    if (selectedDepartment === "") {
      await fetchAllRoles();
    } else {
      await fetchRoles(dept);
    }
  };

  const confirmPending = async () => {
    setConfirmOpen(false);
    if (!pendingAction) return;
    const dept = selectedDepartment === "" ? pendingAction.departmentName : selectedDepartment;
    if (!dept) return;

    const isRemove = pendingAction.kind === "remove";
    const failureMessage = isRemove ? "Erro ao remover cargo" : "Erro ao alterar o nível de acesso";

    try {
      const response = await fetch("/api/admin/roles", {
        method: isRemove ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isRemove
            ? { departmentName: dept, roleName: pendingAction.roleName }
            : {
                departmentName: dept,
                roleName: pendingAction.roleName,
                access: pendingAction.access,
              }
        ),
      });
      if (response.ok) {
        await refreshRoles(dept);
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        // The API refuses to remove the last admin-granting role (NEI07) with a Portuguese
        // message explaining why. Surface it verbatim — a generic failure would leave the person
        // who just locked themselves out with no idea what happened.
        const error = await response.json();
        toast.error(error.error || failureMessage, { closeButton: true });
      }
    } catch {
      toast.error(failureMessage, { closeButton: true });
    } finally {
      setPendingAction(null);
    }
  };

  const cancelPending = () => {
    setConfirmOpen(false);
    setPendingAction(null);
  };

  const confirmMessage = (): string => {
    if (!pendingAction) return "";
    const dept = selectedDepartment === "" ? pendingAction.departmentName : selectedDepartment;
    if (pendingAction.kind === "remove") {
      return `Tem a certeza que quer remover o cargo "${pendingAction.roleName}" do departamento "${dept}"?`;
    }
    const from =
      ROLE_LABELS[pendingAction.previousAccess as UserRole] ?? pendingAction.previousAccess;
    const to = ROLE_LABELS[pendingAction.access as UserRole] ?? pendingAction.access;
    const impact =
      pendingAction.memberCount === 0
        ? "Nenhum membro tem este cargo neste momento."
        : pendingAction.memberCount === 1
          ? "1 membro tem este cargo e será afetado imediatamente."
          : `${pendingAction.memberCount} membros têm este cargo e serão afetados imediatamente.`;
    return `Alterar o nível de acesso do cargo "${pendingAction.roleName}" (${dept}) de ${from} para ${to}? ${impact}`;
  };

  const fuse = useMemo(
    () =>
      new Fuse(roles, {
        keys: ["role_name", "access", "department"],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [roles]
  );

  const filteredRoles = useMemo(() => {
    let filtered = showInactive
      ? roles.filter((role) => !role.active)
      : roles.filter((role) => role.active);
    if (search.trim()) {
      const results = fuse.search(search.trim());
      filtered = filtered.filter((roles) =>
        results.some(
          (role) =>
            role.item.role_name === roles.role_name && role.item.department === roles.department
        )
      );
    }
    if (selectedDepartment === "") {
      filtered = filtered.sort(
        (a, b) =>
          (a.department || "").localeCompare(b.department || "") ||
          a.role_name.localeCompare(b.role_name)
      );
    }
    return filtered;
  }, [roles, search, showInactive, selectedDepartment, fuse]);

  return (
    <>
      <ConfirmDialog
        open={confirmOpen}
        message={confirmMessage()}
        onConfirm={confirmPending}
        onCancel={cancelPending}
      />
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Cargos Existentes</div>
        <div className={styles.filterBar}>
          <select
            value={selectedDepartment}
            onChange={(inputEvent) => setSelectedDepartment(inputEvent.target.value)}
            className={styles.select}>
            <option value="">Todos</option>
            {departments.map((dept) => (
              <option key={dept.name} value={dept.name}>
                {dept.name}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            type="text"
            placeholder="Pesquisar cargo, nível de acesso ou departamento..."
            value={search}
            onChange={(inputEvent) => setSearch(inputEvent.target.value)}
          />
          <button
            className={`${styles.filterBtn} ${!showInactive ? styles.active : ""}`}
            onClick={() => setShowInactive(false)}
            type="button">
            Ativos
          </button>
          <button
            className={`${styles.filterBtn} ${showInactive ? styles.active : ""}`}
            onClick={() => setShowInactive(true)}
            type="button">
            Mostrar Inativos
          </button>
        </div>
        {filteredRoles.length === 0 ? (
          <div className={styles.emptyMessage}>
            {selectedDepartment === ""
              ? "Nenhum cargo encontrado."
              : "Selecione um departamento para ver os cargos."}
          </div>
        ) : (
          <div className={styles.rolesList}>
            {filteredRoles.map((role, index) => (
              <div
                key={role.role_name + (role.department || "") + index}
                className={styles.roleCard}>
                <div>
                  <div className={styles.roleName}>
                    {role.role_name}
                    {selectedDepartment === "" && role.department && (
                      <span className={styles.departmentName}>({role.department})</span>
                    )}
                  </div>
                  {role.active ? (
                    <select
                      value={role.access}
                      onChange={(inputEvent) => handleAccessChange(role, inputEvent.target.value)}
                      className={`${styles.accessSelect}${role.access === "admin" ? " " + styles.admin : ""}`}
                      aria-label={`Nível de acesso do cargo ${role.role_name}`}>
                      {optionsFor(mayGrantAdmin, role.access).map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className={`${styles.badge}${role.access === "admin" ? " " + styles.admin : ""}`}>
                      {ROLE_LABELS[role.access as UserRole] ?? role.access}
                    </span>
                  )}
                  <span className={`${styles.badge}${!role.active ? " " + styles.inactive : ""}`}>
                    {role.active ? "Ativo" : "Inativo"}
                  </span>
                  {role.active && role.memberCount !== undefined && (
                    <span className={styles.memberCount}>
                      {role.memberCount === 1 ? "1 membro" : `${role.memberCount} membros`}
                    </span>
                  )}
                </div>
                {role.active && (
                  <button
                    onClick={() => handleRemoveClick(role.role_name, role.department)}
                    className={styles.deleteBtn}>
                    Remover
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Adicionar Novo Cargo</div>
        <form
          className={styles.addRoleForm}
          onSubmit={(inputEvent) => {
            inputEvent.preventDefault();
            addRole();
          }}>
          <div className={styles.row}>
            <select
              value={addDepartment}
              onChange={(inputEvent) => setAddDepartment(inputEvent.target.value)}
              className={styles.select}
              disabled={loading}>
              <option value="">Todos</option>
              {departments.map((dept) => (
                <option key={dept.name} value={dept.name}>
                  {dept.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newRole.roleName}
              onChange={(inputEvent) =>
                setNewRole({ ...newRole, roleName: inputEvent.target.value })
              }
              placeholder="Nome do Cargo"
              className={styles.input}
              disabled={loading}
            />
            <select
              value={newRole.access}
              onChange={(inputEvent) => setNewRole({ ...newRole, access: inputEvent.target.value })}
              className={styles.select}
              disabled={loading}>
              {optionsFor(mayGrantAdmin).map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={loading || !newRole.roleName.trim() || !addDepartment}
              className={styles.addRoleBtn}>
              {loading ? "A adicionar..." : "Adicionar Cargo"}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
