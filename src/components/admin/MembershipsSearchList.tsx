"use client";

import { useState, useMemo, useRef } from "react";
import Image from "next/image";
import { User } from "@/types/user";
import { Membership, groupMembershipsByMember } from "@/types/memberships";
import { useUser } from "@/context/UserContext";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import styles from "@/styles/components/admin/MembershipsSearchList.module.css";
import { toast } from "sonner";

interface Department {
  name: string;
  active: boolean;
}

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

export default function MembershipsSearchList({
  memberships: initialMemberships,
  users,
  departments,
}: {
  memberships: Membership[];
  users: Partial<User>[];
  departments: Department[];
}) {
  const [memberships, setMemberships] = useState(initialMemberships);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newMembership, setNewMembership] = useState({
    userNumber: "",
    departmentName: "",
    roleName: "",
  });
  const [roles, setRoles] = useState<{ role_name: string; access: string; active: boolean }[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{
    userNumber: string;
    departmentName: string;
    roleName: string;
  } | null>(null);
  const [editingPhotoIstid, setEditingPhotoIstid] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { user, setUser } = useUser();

  const filteredMemberships = useMemo(() => {
    const base = memberships.filter((membership) =>
      showInactive ? !membership.isActive : membership.isActive
    );

    const rawQuery = search.trim();
    if (!rawQuery) return base;

    const normalizedQuery = normalizeText(rawQuery);

    const istWithPrefix = /^ist\d+$/i.test(rawQuery);
    const digitsOnly = /^\d{5,10}$/.test(rawQuery);

    if (istWithPrefix || digitsOnly) {
      const digits = rawQuery.replace(/[^0-9]/g, "");

      const exact = base.filter(
        (membership) => (membership.userNumber || "").replace(/[^0-9]/g, "") === digits
      );
      if (exact.length > 0) return exact;

      return base.filter((membership) =>
        (membership.userNumber || "").replace(/[^0-9]/g, "").startsWith(digits)
      );
    }

    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);

    return base
      .filter((membership) => {
        const searchableText = normalizeText(
          `${membership.userName} ${membership.userEmail} ${membership.departmentName} ${membership.roleName}`
        );
        const textTokens = searchableText.split(/\s+/).filter(Boolean);

        return queryTokens.every((qToken) => textTokens.some((token) => token.startsWith(qToken)));
      })
      .sort((a, b) => a.userName.localeCompare(b.userName));
  }, [memberships, search, showInactive]);

  /**
   * One entry per person, not per position (#8).
   *
   * The filter above deliberately still runs over individual membership rows — searching
   * "Dev-Team" should find someone through the position that matches — and grouping happens
   * afterwards, so a match on any position surfaces that member once, with all of their
   * positions shown together.
   */
  const filteredMembers = useMemo(
    () => groupMembershipsByMember(filteredMemberships),
    [filteredMemberships]
  );

  const handleDepartmentChange = async (departmentName: string) => {
    setNewMembership({ ...newMembership, departmentName, roleName: "" });
    if (departmentName) {
      const response = await fetch(
        `/api/admin/roles?department=${encodeURIComponent(departmentName)}`
      );
      if (response.ok) {
        const data = await response.json();
        setRoles(Array.isArray(data) ? data.filter((r: { active: boolean }) => r.active) : []);
      } else {
        setRoles([]);
      }
    } else {
      setRoles([]);
    }
  };

  const addMembership = async () => {
    if (!newMembership.userNumber || !newMembership.departmentName || !newMembership.roleName)
      return;
    setAdding(true);
    try {
      const response = await fetch("/api/admin/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          istid: newMembership.userNumber,
          departmentName: newMembership.departmentName,
          roleName: newMembership.roleName,
        }),
      });
      if (response.ok) {
        const refreshed = await fetch("/api/admin/memberships");
        if (refreshed.ok) {
          const data = await refreshed.json();
          setMemberships(Array.isArray(data) ? data : []);
        }
        setNewMembership({ userNumber: "", departmentName: "", roleName: "" });
        setRoles([]);
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        const error = await response.json();
        toast.error(error.error || "Erro ao adicionar membro", { closeButton: true });
      }
    } catch {
      toast.error("Erro ao adicionar membro", { closeButton: true });
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveClick = (userNumber: string, departmentName: string, roleName: string) => {
    setPendingRemove({ userNumber, departmentName, roleName });
    setConfirmOpen(true);
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setConfirmOpen(false);
    try {
      const response = await fetch("/api/admin/memberships", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          istid: pendingRemove.userNumber,
          departmentName: pendingRemove.departmentName,
          roleName: pendingRemove.roleName,
        }),
      });
      if (response.ok) {
        const refreshed = await fetch("/api/admin/memberships");
        if (refreshed.ok) {
          const data = await refreshed.json();
          setMemberships(Array.isArray(data) ? data : []);
        }
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        const error = await response.json();
        toast.error(error.error || "Erro ao remover membro", { closeButton: true });
      }
    } catch {
      toast.error("Erro ao remover membro", { closeButton: true });
    } finally {
      setPendingRemove(null);
    }
  };

  const cancelRemove = () => {
    setConfirmOpen(false);
    setPendingRemove(null);
  };

  const handlePhotoClick = (istid: string) => {
    setEditingPhotoIstid(istid);
    fileInputRef.current?.click();
  };

  const handlePhotoChange = async (event: React.ChangeEvent<HTMLInputElement>, istid: string) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const photoData = new FileReader();
    photoData.onloadend = async () => {
      const base64 = (photoData.result as string).split(",")[1];
      const response = await fetch(`/api/user/update/${istid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo: base64 }),
      });
      if (response.ok) {
        const newPhotoUrl = `/api/user/photo/${istid}?custom&${Date.now()}`;
        setMemberships((prev) =>
          prev.map((membership) =>
            membership.userNumber === istid ? { ...membership, userPhoto: newPhotoUrl } : membership
          )
        );
        if (user && user.istid === istid) {
          setUser({ ...user, photo: newPhotoUrl });
        }
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        toast.error("Ocorreu um erro.", { closeButton: true });
      }
      setEditingPhotoIstid(null);
    };
    photoData.readAsDataURL(file);
  };

  return (
    <>
      <ConfirmDialog
        open={confirmOpen}
        message="Tem a certeza que quer remover este membro?"
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      />

      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={(e) => {
          if (editingPhotoIstid) handlePhotoChange(e, editingPhotoIstid);
        }}
      />
      <section className={styles.section}>
        <h3>Adicionar Novo Membro</h3>
        <div className={styles.addMemberForm}>
          <select
            value={newMembership.userNumber}
            onChange={(inputEvent) =>
              setNewMembership({ ...newMembership, userNumber: inputEvent.target.value })
            }
            className={styles.input}
            disabled={adding}>
            <option value="">Selecione um utilizador</option>
            {users.map((user) => (
              <option key={user.istid} value={user.istid}>
                {user.name} ({user.istid}) - {user.email}
              </option>
            ))}
          </select>
          <select
            value={newMembership.departmentName}
            onChange={(inputEvent) => handleDepartmentChange(inputEvent.target.value)}
            className={styles.input}
            disabled={adding}>
            <option value="">Selecione um departamento</option>
            {departments.map((dept) => (
              <option key={dept.name} value={dept.name}>
                {dept.name}
              </option>
            ))}
          </select>
          <select
            value={newMembership.roleName}
            onChange={(inputEvent) =>
              setNewMembership({ ...newMembership, roleName: inputEvent.target.value })
            }
            className={styles.input}
            disabled={adding || !newMembership.departmentName}>
            <option value="">Selecione um cargo</option>
            {roles.map((role) => (
              <option key={role.role_name} value={role.role_name}>
                {role.role_name} ({role.access})
              </option>
            ))}
          </select>
          <button
            onClick={addMembership}
            disabled={
              adding ||
              !newMembership.userNumber ||
              !newMembership.departmentName ||
              !newMembership.roleName
            }
            className={styles.addMemberBtn}>
            {adding ? "A adicionar..." : "Adicionar Membro"}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h3>Membros Existentes</h3>
        <div className={styles.searchBar}>
          <input
            className={styles.input}
            type="text"
            placeholder="Pesquisar por nome, ISTID, email, departamento ou cargo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={`${styles.filterBtn} ${!showInactive ? styles.active : ""}`}
            onClick={() => setShowInactive(false)}>
            Ativos
          </button>
          <button
            className={`${styles.filterBtn} ${showInactive ? styles.active : ""}`}
            onClick={() => setShowInactive(true)}>
            Mostrar Inativos
          </button>
        </div>
        {filteredMembers.length === 0 ? (
          <div className={styles.emptyMessage}>Nenhum membro encontrado.</div>
        ) : (
          <div className={styles.membersList}>
            {filteredMembers.map((member) => (
              <div key={member.userNumber} className={styles.memberCard}>
                <div className={member.isActive ? styles.changePhoto : undefined}>
                  <Image
                    className={styles.memberPhoto}
                    src={member.userPhoto}
                    alt={member.userName}
                    width={160}
                    height={160}
                    style={{ cursor: member.isActive ? "pointer" : "not-allowed" }}
                    onClick={() => {
                      if (member.isActive) handlePhotoClick(member.userNumber);
                    }}
                    title={
                      member.isActive
                        ? "Clique para alterar a foto"
                        : "Só pode alterar fotos de membros ativos"
                    }
                  />
                </div>
                <div className={styles.memberInfo}>
                  <div className={styles.memberName}>
                    {member.userName} ({member.userNumber})
                  </div>
                  <div>
                    <strong>Email:</strong> {member.userEmail}
                  </div>

                  {/*
                    Every position this person holds, in one card. Each row carries its own
                    Remover, because removing is per position — the previous layout repeated the
                    whole person once per position to achieve that.
                  */}
                  <ul className={styles.positionList}>
                    {member.positions.map((position) => (
                      <li key={position.id} className={styles.position}>
                        <div className={styles.positionText}>
                          <span className={styles.positionRole}>{position.roleName}</span>
                          <span className={styles.positionDept}>{position.departmentName}</span>
                          <span className={styles.positionDates}>
                            Desde {new Date(position.startDate).toLocaleDateString("pt-PT")}
                            {position.endDate
                              ? ` · até ${new Date(position.endDate).toLocaleDateString("pt-PT")}`
                              : ""}
                          </span>
                        </div>
                        <button
                          onClick={() =>
                            handleRemoveClick(
                              position.userNumber,
                              position.departmentName,
                              position.roleName
                            )
                          }
                          className={styles.deleteBtn}
                          title={`Remover ${position.roleName} em ${position.departmentName}`}>
                          Remover
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={styles.memberActions}>
                  <span className={styles.badge}>{member.isActive ? "Ativo" : "Inativo"}</span>
                  {member.positions.length > 1 && (
                    <span className={styles.positionCount}>{member.positions.length} cargos</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
