"use client";

import { useState } from "react";
import { toast } from "sonner";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { UserRole } from "@/types/user";
import type { TeamAccessGrant } from "@/utils/db/userQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * Temporary access to this team (#184).
 *
 * Shows revoked and expired grants alongside live ones on purpose: the table is the audit record,
 * and "who had access to this team in March" is the question it exists to answer.
 *
 * `canGrant` and `canDelegate` only decide what to *offer*. Every rule is enforced in
 * `neiist.create_team_access_grant`, so a wrong answer here is a bad offer, never a bad grant.
 */
const ACCESS_OPTIONS: UserRole[] = [
  UserRole._MEMBER,
  UserRole._SHOP_MANAGER,
  UserRole._COORDINATOR,
];

/** 14 days, offered as the default. The database refuses anything beyond 90. */
const DEFAULT_DAYS = 14;

const isoInDays = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });

export default function TeamAccessGrants({
  team,
  initialGrants,
  canGrant,
  delegatableGrantId,
  maxAccess,
}: {
  team: string;
  initialGrants: TeamAccessGrant[];
  /** The caller may create a new grant here — i.e. they are board. */
  canGrant: boolean;
  /** Set when the caller holds a grant on this team they could pass on. */
  delegatableGrantId: number | null;
  /** Ceiling for the access select: their own grant's level when delegating. */
  maxAccess: UserRole | null;
}) {
  const [grants, setGrants] = useState(initialGrants);
  const [istid, setIstid] = useState("");
  const [access, setAccess] = useState<string>(UserRole._MEMBER);
  const [until, setUntil] = useState(isoInDays(DEFAULT_DAYS));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<TeamAccessGrant | null>(null);

  const mayOfferForm = canGrant || delegatableGrantId !== null;
  const offered = maxAccess
    ? ACCESS_OPTIONS.filter(
        (option) => ACCESS_OPTIONS.indexOf(option) <= ACCESS_OPTIONS.indexOf(maxAccess)
      )
    : ACCESS_OPTIONS;

  const refresh = async () => {
    const response = await fetch(`/api/workspace/grants?department=${encodeURIComponent(team)}`);
    if (response.ok) setGrants(await response.json());
  };

  const submit = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          granteeIstid: istid.trim(),
          departmentName: team,
          access,
          // The date input gives a day; the grant ends at the end of it.
          expiresAt: new Date(`${until}T23:59:59`).toISOString(),
          reason: reason.trim(),
          parentGrantId: canGrant ? null : delegatableGrantId,
        }),
      });
      if (response.ok) {
        setIstid("");
        setReason("");
        await refresh();
        toast.success("Acesso temporário concedido.", { closeButton: true });
      } else {
        // The database's refusals are written for the person who hit them — "you cannot delegate
        // more access than you were given" — so they are shown verbatim.
        const body = await response.json();
        toast.error(body.error || "Não foi possível conceder o acesso.", { closeButton: true });
      }
    } catch {
      toast.error("Não foi possível conceder o acesso.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const confirmRevoke = async () => {
    const target = pendingRevoke;
    setPendingRevoke(null);
    if (!target) return;
    try {
      const response = await fetch("/api/workspace/grants", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId: target.id }),
      });
      if (response.ok) {
        await refresh();
        toast.success("Acesso revogado.", { closeButton: true });
      } else {
        const body = await response.json();
        toast.error(body.error || "Não foi possível revogar o acesso.", { closeButton: true });
      }
    } catch {
      toast.error("Não foi possível revogar o acesso.", { closeButton: true });
    }
  };

  return (
    <section className={styles.section}>
      <ConfirmDialog
        open={pendingRevoke !== null}
        message={
          pendingRevoke
            ? `Revogar o acesso temporário de ${pendingRevoke.granteeName} a ${team}? Qualquer acesso que tenha delegado a partir deste também será revogado.`
            : ""
        }
        onConfirm={confirmRevoke}
        onCancel={() => setPendingRevoke(null)}
      />

      <h2 className={styles.sectionTitle}>Acessos temporários</h2>

      {grants.length === 0 ? (
        <p className={styles.empty}>Ninguém tem acesso temporário a esta equipa.</p>
      ) : (
        <ul className={styles.memberList}>
          {grants.map((grant) => (
            <li key={grant.id} className={styles.member}>
              <span className={styles.memberName}>
                {grant.granteeName}
                {grant.parentGrantId !== null ? (
                  <span className={styles.cardMeta}> (delegado)</span>
                ) : null}
              </span>
              <span className={styles.memberRoles}>
                {ROLE_LABELS[grant.access]} ·{" "}
                {grant.revokedAt
                  ? `revogado em ${formatDate(grant.revokedAt)}`
                  : grant.isActive
                    ? `até ${formatDate(grant.expiresAt)}`
                    : `expirou em ${formatDate(grant.expiresAt)}`}{" "}
                · {grant.reason}
                {grant.isActive ? (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    onClick={() => setPendingRevoke(grant)}>
                    Revogar
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayOfferForm ? (
        <form className={styles.grantForm} onSubmit={submit}>
          <p className={styles.cardMeta}>
            {canGrant
              ? "Conceder acesso temporário a um membro do NEIIST que não pertence a esta equipa."
              : "Delegar parte do teu acesso temporário a um membro da tua equipa."}
          </p>
          <div className={styles.grantRow}>
            <input
              className={styles.grantInput}
              value={istid}
              onChange={(inputEvent) => setIstid(inputEvent.target.value)}
              placeholder="istid (ex.: ist1100000)"
              disabled={busy}
              required
            />
            <select
              className={styles.grantInput}
              value={access}
              onChange={(inputEvent) => setAccess(inputEvent.target.value)}
              disabled={busy}
              aria-label="Nível de acesso">
              {offered.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
            <input
              className={styles.grantInput}
              type="date"
              value={until}
              max={isoInDays(90)}
              min={isoInDays(1)}
              onChange={(inputEvent) => setUntil(inputEvent.target.value)}
              disabled={busy}
              aria-label="Válido até"
              required
            />
          </div>
          <div className={styles.grantRow}>
            <input
              className={styles.grantInput}
              value={reason}
              onChange={(inputEvent) => setReason(inputEvent.target.value)}
              placeholder="Motivo (fica registado)"
              disabled={busy}
              required
            />
            <button type="submit" className={styles.grantBtn} disabled={busy}>
              {busy ? "A conceder..." : "Conceder acesso"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
