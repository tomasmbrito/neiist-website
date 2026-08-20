"use client";

import { useState, useRef, useMemo } from "react";
import Image from "next/image";
import { useUser } from "@/context/UserContext";
import styles from "@/styles/components/photo-management/PhotoTeamMembers.module.css";
import { toast } from "sonner";
// Was a local duplicate of this interface, field for field. A shadow copy is how the two drift.
import { Membership, groupMembershipsByMember } from "@/types/memberships";

interface Department {
  name: string;
  active: boolean;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[-_]/g, " ");

const normalizeIstId = (s: string) => normalize(s).replace(/^ist/, "");

export default function PhotoTeamMembers({
  membersByDepartment,
}: {
  membersByDepartment: Record<string, Membership[]>;
  departments: Department[];
}) {
  const [search, setSearch] = useState("");
  const [editingPhotoIstid, setEditingPhotoIstid] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [members, setMembers] = useState(membersByDepartment);
  const { user, setUser } = useUser();

  const filteredMembers = useMemo(() => {
    const query = search.trim();
    if (!query) return members;

    const tokens = normalize(query).split(/\s+/);

    if (tokens.length === 0) return members;

    const allMembers = Object.values(members).flat();

    const results = allMembers.filter((m) => {
      const nameWords = normalize(m.userName).split(/\s+/);
      const normId = normalizeIstId(m.userNumber);

      return tokens.every(
        (token) =>
          nameWords.some((word) => word.startsWith(token)) ||
          normId.includes(token) ||
          normId.includes(normalizeIstId(token))
      );
    });

    const grouped: Record<string, Membership[]> = {};
    Object.entries(members).forEach(([dept, memberships]) => {
      const filtered = memberships.filter((m) => results.includes(m));
      if (filtered.length > 0) grouped[dept] = filtered;
    });
    return grouped;
  }, [search, members]);

  const handlePhotoClick = (istid: string) => {
    setEditingPhotoIstid(istid);
    fileInputRef.current?.click();
  };

  const handlePhotoChange = async (event: React.ChangeEvent<HTMLInputElement>, istid: string) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageInput = new FileReader();
    imageInput.onloadend = async () => {
      const base64 = (imageInput.result as string).split(",")[1];
      const response = await fetch(`/api/user/update/${istid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo: base64 }),
      });
      if (response.ok) {
        const newPhotoUrl = `/api/user/photo/${istid}?custom&${Date.now()}`;
        setMembers((prev) => {
          const updated: typeof prev = {};
          Object.entries(prev).forEach(([dept, memberships]) => {
            updated[dept] = memberships.map((m) =>
              m.userNumber === istid ? { ...m, userPhoto: newPhotoUrl } : m
            );
          });
          return updated;
        });
        if (user && user.istid === istid) {
          setUser({ ...user, photo: newPhotoUrl });
        }
        toast.success("Operação concluída com sucesso.", { closeButton: true });
      } else {
        toast.error("Ocorreu um erro.", { closeButton: true });
      }
      setEditingPhotoIstid(null);
    };
    imageInput.readAsDataURL(file);
  };

  return (
    <>
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={(e) => {
          if (editingPhotoIstid) handlePhotoChange(e, editingPhotoIstid);
        }}
      />
      <div className={styles.section}>
        <div className={styles.searchBar}>
          <input
            className={styles.input}
            type="text"
            placeholder="Pesquisar por nome ou ISTID..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {Object.keys(filteredMembers).length === 0 ? (
          <div className={styles.emptyMessage}>Nenhum membro encontrado.</div>
        ) : (
          Object.entries(filteredMembers).map(([dept, memberships]) => (
            <div key={dept}>
              <h3 className={styles.departmentName}>{dept}</h3>
              <div className={styles.membersList}>
                {/*
                  Grouped by person (#8): someone holding two roles in the same department used
                  to get two identical photo cards here, which is especially confusing on a
                  screen whose whole purpose is "click the photo to change it".
                */}
                {groupMembershipsByMember(memberships).map((member) => (
                  <div key={member.userNumber} className={styles.memberCard}>
                    <div className={styles.changePhoto}>
                      <Image
                        className={styles.memberPhoto}
                        src={member.userPhoto}
                        alt={member.userName}
                        width={180}
                        height={180}
                        style={{ cursor: "pointer" }}
                        onClick={() => handlePhotoClick(member.userNumber)}
                        title="Clique para alterar a foto"
                      />
                    </div>
                    <div className={styles.memberInfo}>
                      <div className={styles.memberName}>
                        {member.userName} ({member.userNumber})
                      </div>
                      <div className={styles.memberRoles}>
                        {member.positions.map((position) => position.roleName).join(" · ")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
