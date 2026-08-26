import { NextRequest, NextResponse } from "next/server";
import {
  addEventDocument,
  getEventAttendees,
  getEventDocuments,
  getEventRelations,
  getInternalEventDetail,
  getInternalEventOwner,
  getEventTeams,
  relateEvents,
  setEventCollaborator,
  setEventVisibility,
  removeEventAttendee,
  removeEventDocument,
  setEventAttendance,
  unrelateEvents,
  updateEventNotes,
} from "@/utils/db/eventQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { throwIfEventDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import {
  attendanceSchema,
  eventCollaboratorSchema,
  eventVisibilitySchema,
  eventDocumentSchema,
  eventNotesSchema,
  relateEventSchema,
} from "@/schemas/events";

/**
 * One event's detail: agenda, minutes, attendance, documents and related events (#129 slice B).
 *
 * **Every handler resolves the owning team from the event id first.** The department is never
 * taken from the request — that substitution is the IDOR shape, and it is the single thing this
 * route has to get right, since the id is the only thing the client controls.
 *
 * Which permission each verb needs follows the same split as slice A: reading is
 * `team.workspace.view`, and writing is the kind-appropriate manage permission. Editing an
 * existing event uses `team.events.manage` regardless of kind — changing a record is not the same
 * act as calling a meeting, and a member who may call one should not be able to rewrite the
 * minutes of a coordinator's event.
 */
type Ctx = { params: Promise<{ eventId: string }> };

/** Resolve the event, its team, and whether this caller may read or write it. */
async function authorize(request: NextRequest, ctx: Ctx, need: "read" | "write") {
  const session = await getWorkspaceSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) } as const;
  }

  const { eventId: raw } = await ctx.params;
  const eventId = Number(raw);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return { error: NextResponse.json({ error: "Pedido inválido" }, { status: 400 }) } as const;
  }

  const team = await getInternalEventOwner(eventId);
  if (!team) {
    return {
      error: NextResponse.json({ error: "Evento não encontrado." }, { status: 404 }),
    } as const;
  }

  const permission = need === "read" ? "team.workspace.view" : "team.events.manage";
  if (!canForTeam(session.roles, session.scopes, permission, team)) {
    // Same 403 whether the caller may not write or may not see it at all: distinguishing them
    // would confirm the event exists to someone outside the team.
    return {
      error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }),
    } as const;
  }

  return { session, eventId, team } as const;
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const auth = await authorize(request, ctx, "read");
  if ("error" in auth) return auth.error;

  const { eventId, team } = auth;
  const [event, attendees, documents, related, teams] = await Promise.all([
    getInternalEventDetail(eventId, team),
    getEventAttendees(eventId, team),
    getEventDocuments(eventId, team),
    getEventRelations(eventId, team),
    getEventTeams(eventId, team),
  ]);
  if (!event) return NextResponse.json({ error: "Evento não encontrado." }, { status: 404 });

  return NextResponse.json({ event, attendees, documents, related, teams });
}

/** Agenda and minutes. */
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const auth = await authorize(request, ctx, "write");
  if ("error" in auth) return auth.error;

  try {
    const parsed = eventNotesSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    await updateEventNotes(auth.eventId, parsed.data.agenda ?? null, parsed.data.minutes ?? null);
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfEventDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

/**
 * Attendance, documents and relations, discriminated by `action`.
 *
 * One handler rather than three routes: they share the same ownership lookup, and three routes
 * would be three places to forget it.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const auth = await authorize(request, ctx, "write");
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    switch (body?.action) {
      case "attendance": {
        const parsed = attendanceSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
            { status: 400 }
          );
        }
        await setEventAttendance(auth.eventId, parsed.data.istid, parsed.data.response);
        return NextResponse.json({ success: true });
      }
      case "removeAttendee": {
        const parsed = attendanceSchema.pick({ istid: true }).safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
        }
        await removeEventAttendee(auth.eventId, parsed.data.istid);
        return NextResponse.json({ success: true });
      }
      case "document": {
        const parsed = eventDocumentSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
            { status: 400 }
          );
        }
        const id = await addEventDocument(
          auth.eventId,
          parsed.data.kind,
          parsed.data.title,
          parsed.data.url
        );
        return NextResponse.json({ id }, { status: 201 });
      }
      case "removeDocument": {
        const documentId = Number(body?.documentId);
        if (!Number.isInteger(documentId) || documentId <= 0) {
          return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
        }
        // Checked against this event's own documents, so an id belonging to another team's event
        // is simply not found here rather than deleted.
        const owned = await getEventDocuments(auth.eventId, auth.team);
        if (!owned.some((document) => document.id === documentId)) {
          return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
        }
        await removeEventDocument(documentId);
        return NextResponse.json({ success: true });
      }
      case "visibility": {
        const parsed = eventVisibilitySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
        }
        // Publishing is a separate, stricter permission than editing (#129): making an event
        // visible to everyone is the núcleo speaking in public. Narrowing it is not — anyone who
        // may edit the event may restrict who sees it.
        if (
          parsed.data.visibility === "public" &&
          !canForTeam(auth.session.roles, auth.session.scopes, "team.events.publish", auth.team)
        ) {
          return NextResponse.json(
            { error: "Não tens permissão para tornar este evento público." },
            { status: 403 }
          );
        }
        await setEventVisibility(auth.eventId, parsed.data.visibility);
        return NextResponse.json({ success: true });
      }
      case "collaborator": {
        const parsed = eventCollaboratorSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
        }
        if (
          !canForTeam(
            auth.session.roles,
            auth.session.scopes,
            "team.events.collaborators",
            auth.team
          )
        ) {
          return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
        }
        // Authorized against the OWNING team, not the team being added: bringing Visuais in is
        // the owner's decision, and Visuais does not get a say in being volunteered.
        await setEventCollaborator(auth.eventId, parsed.data.departmentName, parsed.data.add);
        return NextResponse.json({ success: true });
      }
      case "relate":
      case "unrelate": {
        const parsed = relateEventSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
        }
        // The other event must belong to the same team. `relate_events` refuses a cross-team pair
        // as well; checking here too means the caller gets a 403 rather than a database message,
        // and it never learns whether an id in another team exists.
        const otherTeam = await getInternalEventOwner(parsed.data.relatedEventId);
        if (otherTeam !== auth.team) {
          return NextResponse.json(
            { error: "Só é possível relacionar eventos da mesma equipa." },
            { status: 403 }
          );
        }
        if (body.action === "relate") {
          await relateEvents(auth.eventId, parsed.data.relatedEventId);
        } else {
          await unrelateEvents(auth.eventId, parsed.data.relatedEventId);
        }
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ error: "Ação desconhecida." }, { status: 400 });
    }
  } catch (error) {
    try {
      throwIfEventDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
