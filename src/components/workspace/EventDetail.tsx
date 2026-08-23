"use client";

import { useState } from "react";
import { toast } from "sonner";
import type {
  EventAttendee,
  EventDocument,
  InternalEventDetail,
  RelatedEvent,
} from "@/utils/db/eventQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * The detail view of one event or meeting (#129 slice B).
 *
 * `canEdit` only shapes what is offered — every write is re-authorized in the route against the
 * event's own owning team, so a wrong answer here is a missing button, never an unguarded write.
 */
const RESPONSE_LABELS: Record<EventAttendee["response"], string> = {
  invited: "Convidado",
  accepted: "Vai",
  declined: "Não vai",
  attended: "Esteve presente",
};

const DOCUMENT_LABELS: Record<EventDocument["kind"], string> = {
  plano: "Plano de Atividades",
  relatorio: "Relatório",
  ata: "Ata",
  other: "Outro",
};

const formatWhen = (startsAt: string, endsAt: string | null) => {
  const start = new Date(startsAt);
  const date = start.toLocaleDateString("pt-PT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const time = start.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  if (!endsAt) return `${date}, ${time}`;
  const end = new Date(endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${date}, ${time}–${end.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}`
    : `${date}, ${time} — ${end.toLocaleDateString("pt-PT", { day: "2-digit", month: "long" })}`;
};

export default function EventDetail({
  team,
  event,
  initialAttendees,
  initialDocuments,
  initialRelated,
  roster,
  relatableEvents,
  canEdit,
}: {
  team: string;
  event: InternalEventDetail;
  initialAttendees: EventAttendee[];
  initialDocuments: EventDocument[];
  initialRelated: RelatedEvent[];
  roster: Array<{ istid: string; name: string }>;
  relatableEvents: Array<{ id: number; name: string }>;
  canEdit: boolean;
}) {
  const [attendees, setAttendees] = useState(initialAttendees);
  const [documents, setDocuments] = useState(initialDocuments);
  const [related, setRelated] = useState(initialRelated);
  const [agenda, setAgenda] = useState(event.agenda ?? "");
  const [minutes, setMinutes] = useState(event.minutes ?? "");
  const [notesDirty, setNotesDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newAttendee, setNewAttendee] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [docKind, setDocKind] = useState<EventDocument["kind"]>("other");
  const [relateId, setRelateId] = useState("");

  const endpoint = `/api/workspace/events/${event.id}`;

  const refresh = async () => {
    const response = await fetch(endpoint);
    if (!response.ok) return;
    const body = await response.json();
    setAttendees(body.attendees);
    setDocuments(body.documents);
    setRelated(body.related);
  };

  /** One place for the fetch/toast/refresh cycle, so eight actions do not repeat it eight times. */
  const act = async (init: RequestInit, onOk?: () => void) => {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (response.ok) {
        onOk?.();
        await refresh();
        return true;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível guardar.", { closeButton: true });
      return false;
    } catch {
      toast.error("Não foi possível guardar.", { closeButton: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async () => {
    const ok = await act({
      method: "PATCH",
      body: JSON.stringify({ agenda: agenda.trim() || null, minutes: minutes.trim() || null }),
    });
    if (ok) {
      setNotesDirty(false);
      toast.success("Guardado.", { closeButton: true });
    }
  };

  const post = (payload: Record<string, unknown>, onOk?: () => void) =>
    act({ method: "POST", body: JSON.stringify(payload) }, onOk);

  const alreadyInvited = new Set(attendees.map((attendee) => attendee.userIstid));

  return (
    <>
      <section className={styles.section}>
        <p className={styles.subtitle}>{formatWhen(event.startsAt, event.endsAt)}</p>
        {event.locations.length > 0 ? (
          <p className={styles.cardMeta}>{event.locations.join(" · ")}</p>
        ) : null}
        {event.description ? <p className={styles.subtitle}>{event.description}</p> : null}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>
          {event.kind === "meeting" ? "Agenda e ata" : "Notas"}
        </h2>
        {canEdit ? (
          <div className={styles.grantForm}>
            <textarea
              className={styles.notesArea}
              value={agenda}
              onChange={(inputEvent) => {
                setAgenda(inputEvent.target.value);
                setNotesDirty(true);
              }}
              placeholder="Agenda — pontos a discutir"
              rows={5}
              disabled={busy}
            />
            <textarea
              className={styles.notesArea}
              value={minutes}
              onChange={(inputEvent) => {
                setMinutes(inputEvent.target.value);
                setNotesDirty(true);
              }}
              placeholder="Ata — o que ficou decidido"
              rows={5}
              disabled={busy}
            />
            <div className={styles.grantRow}>
              <button
                type="button"
                className={styles.grantBtn}
                onClick={saveNotes}
                disabled={busy || !notesDirty}>
                {busy ? "A guardar..." : notesDirty ? "Guardar" : "Guardado"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className={styles.notesRead}>{agenda || "Sem agenda."}</p>
            {minutes ? <p className={styles.notesRead}>{minutes}</p> : null}
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Presenças ({attendees.length})</h2>
        {attendees.length === 0 ? (
          <p className={styles.empty}>Ninguém foi convidado ainda.</p>
        ) : (
          <ul className={styles.memberList}>
            {attendees.map((attendee) => (
              <li key={attendee.userIstid} className={styles.member}>
                <span className={styles.memberName}>{attendee.userName}</span>
                <span className={styles.memberRoles}>
                  {canEdit ? (
                    <select
                      className={styles.inlineSelect}
                      value={attendee.response}
                      disabled={busy}
                      aria-label={`Presença de ${attendee.userName}`}
                      onChange={(inputEvent) =>
                        post({
                          action: "attendance",
                          istid: attendee.userIstid,
                          response: inputEvent.target.value,
                        })
                      }>
                      {(Object.keys(RESPONSE_LABELS) as EventAttendee["response"][]).map((key) => (
                        <option key={key} value={key}>
                          {RESPONSE_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    RESPONSE_LABELS[attendee.response]
                  )}
                  {canEdit ? (
                    <button
                      type="button"
                      className={styles.revokeBtn}
                      disabled={busy}
                      onClick={() => post({ action: "removeAttendee", istid: attendee.userIstid })}>
                      Remover
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className={styles.grantRow} style={{ marginTop: "0.8rem" }}>
            <select
              className={styles.grantInput}
              value={newAttendee}
              onChange={(inputEvent) => setNewAttendee(inputEvent.target.value)}
              disabled={busy}
              aria-label="Convidar membro">
              <option value="">Convidar um membro da equipa…</option>
              {roster
                .filter((member) => !alreadyInvited.has(member.istid))
                .map((member) => (
                  <option key={member.istid} value={member.istid}>
                    {member.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={styles.grantBtn}
              disabled={busy || !newAttendee}
              onClick={() =>
                post({ action: "attendance", istid: newAttendee, response: "invited" }, () =>
                  setNewAttendee("")
                )
              }>
              Convidar
            </button>
          </div>
        ) : null}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Documentos</h2>
        {documents.length === 0 ? (
          <p className={styles.empty}>
            Sem documentos. O Plano de Atividades e o Relatório continuam no Notion/Drive — aqui
            ficam as ligações.
          </p>
        ) : (
          <ul className={styles.memberList}>
            {documents.map((document) => (
              <li key={document.id} className={styles.member}>
                <span className={styles.memberName}>
                  {/* rel="noreferrer" because these point off-site, often to Drive. */}
                  <a href={document.url} target="_blank" rel="noreferrer noopener">
                    {document.title}
                  </a>
                  <span className={styles.cardMeta}> · {DOCUMENT_LABELS[document.kind]}</span>
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    disabled={busy}
                    onClick={() => post({ action: "removeDocument", documentId: document.id })}>
                    Remover
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className={styles.grantRow} style={{ marginTop: "0.8rem" }}>
            <select
              className={styles.grantInput}
              value={docKind}
              onChange={(inputEvent) =>
                setDocKind(inputEvent.target.value as EventDocument["kind"])
              }
              disabled={busy}
              aria-label="Tipo de documento">
              {(Object.keys(DOCUMENT_LABELS) as EventDocument["kind"][]).map((key) => (
                <option key={key} value={key}>
                  {DOCUMENT_LABELS[key]}
                </option>
              ))}
            </select>
            <input
              className={styles.grantInput}
              value={docTitle}
              onChange={(inputEvent) => setDocTitle(inputEvent.target.value)}
              placeholder="Título"
              disabled={busy}
            />
            <input
              className={styles.grantInput}
              value={docUrl}
              onChange={(inputEvent) => setDocUrl(inputEvent.target.value)}
              placeholder="https://…"
              disabled={busy}
            />
            <button
              type="button"
              className={styles.grantBtn}
              disabled={busy || !docTitle.trim() || !docUrl.trim()}
              onClick={() =>
                post(
                  { action: "document", kind: docKind, title: docTitle.trim(), url: docUrl.trim() },
                  () => {
                    setDocTitle("");
                    setDocUrl("");
                  }
                )
              }>
              Adicionar
            </button>
          </div>
        ) : null}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Relacionados</h2>
        {related.length === 0 ? (
          <p className={styles.empty}>Sem eventos relacionados.</p>
        ) : (
          <ul className={styles.memberList}>
            {related.map((item) => (
              <li key={item.id} className={styles.member}>
                <span className={styles.memberName}>
                  <a href={`/workspace/${encodeURIComponent(team)}/events/${item.id}`}>
                    {item.name}
                  </a>
                  <span className={styles.cardMeta}>
                    {" "}
                    · {item.kind === "meeting" ? "reunião" : "evento"}
                  </span>
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    disabled={busy}
                    onClick={() => post({ action: "unrelate", relatedEventId: item.id })}>
                    Desassociar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit && relatableEvents.length > 0 ? (
          <div className={styles.grantRow} style={{ marginTop: "0.8rem" }}>
            <select
              className={styles.grantInput}
              value={relateId}
              onChange={(inputEvent) => setRelateId(inputEvent.target.value)}
              disabled={busy}
              aria-label="Relacionar com">
              <option value="">Relacionar com…</option>
              {relatableEvents
                .filter((candidate) => !related.some((item) => item.id === candidate.id))
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={styles.grantBtn}
              disabled={busy || !relateId}
              onClick={() =>
                post({ action: "relate", relatedEventId: Number(relateId) }, () => setRelateId(""))
              }>
              Relacionar
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
