import { NextRequest, NextResponse } from "next/server";
import {
  createInternalEvent,
  deleteInternalEvent,
  getInternalEventOwner,
  getTeamInternalEvents,
} from "@/utils/db/eventQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam, type TeamPermission } from "@/lib/auth/permissions";
import { throwIfEventDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { createEventSchema, deleteEventSchema } from "@/schemas/events";

/**
 * A team's events and meetings (#129).
 *
 * Authorization is `canForTeam` throughout — the same guard the workspace pages use, never a new
 * bespoke check. Two rules shape every handler here:
 *
 *  - **A meeting and an event are different permissions.** Any member may call their team's
 *    meeting, matching what Notion allows today; scheduling an event is the team acting outwards
 *    and belongs to its coordinators.
 *  - **Authorize against the row's owner, not the request's.** For anything addressing an existing
 *    event, the owning department is read from the database first. Trusting a department name in
 *    the body would let a coordinator of one team delete another team's events by naming their own.
 */

/** Which permission this write needs. Meetings are open to members; events are not. */
const managePermission = (kind: "event" | "meeting"): TeamPermission =>
  kind === "meeting" ? "team.meetings.manage" : "team.events.manage";

export async function GET(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });
  }

  // Same gate as the team page. These rows are internal by default; someone outside the team must
  // not learn what it is planning.
  if (!canForTeam(session.roles, session.scopes, "team.workspace.view", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  return NextResponse.json(await getTeamInternalEvents(departmentName));
}

export async function POST(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = createEventSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const input = parsed.data;

    if (
      !canForTeam(session.roles, session.scopes, managePermission(input.kind), input.departmentName)
    ) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Publishing is checked separately, and only when it is actually being asked for. An event
    // stays internal unless someone with `team.events.publish` says otherwise, so a member who
    // may call meetings cannot put one on the calendar students see.
    if (
      input.isPublic &&
      !canForTeam(session.roles, session.scopes, "team.events.publish", input.departmentName)
    ) {
      return NextResponse.json(
        { error: "Não tens permissão para tornar este evento público." },
        { status: 403 }
      );
    }

    const id = await createInternalEvent({ ...input, createdByIstid: session.user.istid });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    try {
      throwIfEventDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = deleteEventSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
    }

    // The owner comes from the row, never from the caller.
    const owner = await getInternalEventOwner(parsed.data.eventId);
    if (!owner) return NextResponse.json({ error: "Evento não encontrado." }, { status: 404 });

    // `team.events.delete`, not `team.events.manage` (#208). Deletion is irreversible and
    // cascades to attendees, locations, documents and the minutes — so it is the one event
    // permission a temporary grant cannot satisfy, unlike publishing which was accepted as
    // outliving a grant.
    if (!canForTeam(session.roles, session.scopes, "team.events.delete", owner)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    await deleteInternalEvent(parsed.data.eventId);
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
