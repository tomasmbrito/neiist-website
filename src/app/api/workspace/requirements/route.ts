import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import {
  addRequirementDeliverable,
  assignRequirement,
  getRequirementDeliverables,
  getTeamRequirements,
  raiseRequirements,
  setRequirementStatus,
} from "@/utils/db/requirementQueries";
import {
  raiseRequirementsSchema,
  requirementAssignSchema,
  requirementDeliverableSchema,
  requirementStatusSchema,
} from "@/schemas/requirements";
import { throwIfRequirementDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Requerimentos (#232).
 *
 * Gated on `team.content.edit` — the ordinary "may act for this team" permission, because raising
 * and answering requerimentos is the team's day-to-day work rather than a privileged act. Reading
 * needs only `team.workspace.view`, since a requerimento is already visible to both teams by
 * construction.
 *
 * **The caller's team is never taken from the request.** It comes from the session and is passed to
 * SQL, which decides whether that team may do the thing. A route that accepted a team parameter
 * would be a route where the answer is whatever the caller says it is — #180 in one line.
 */
async function actorTeam(request: NextRequest, permission: "view" | "edit") {
  const session = await getWorkspaceSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return { error: NextResponse.json({ error: "Indique a equipa." }, { status: 400 }) };
  }
  const needed = permission === "edit" ? "team.content.edit" : "team.workspace.view";
  if (!canForTeam(session.roles, session.scopes, needed, departmentName)) {
    return { error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  return { session, departmentName };
}

export async function GET(request: NextRequest) {
  const auth = await actorTeam(request, "view");
  if ("error" in auth) return auth.error;

  const requirementId = request.nextUrl.searchParams.get("requirementId");
  if (requirementId) {
    // Keyed by requirement AND team in SQL, so an id from an unrelated pair returns nothing
    // rather than relying on this route to compare.
    return NextResponse.json(
      await getRequirementDeliverables(Number(requirementId), auth.departmentName)
    );
  }
  return NextResponse.json(await getTeamRequirements(auth.departmentName));
}

export async function POST(request: NextRequest) {
  const auth = await actorTeam(request, "edit");
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();

    if (body?.action === "deliver") {
      const parsed = requirementDeliverableSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
          { status: 400 }
        );
      }
      const id = await addRequirementDeliverable(
        parsed.data.requirementId,
        parsed.data.url,
        parsed.data.label ?? null,
        auth.session.user!.istid,
        auth.departmentName
      );
      return NextResponse.json({ success: true, id });
    }

    const parsed = raiseRequirementsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }

    // Atomic in SQL: an event needing a poster AND a campaign AND a photographer is one decision,
    // and half of it landing leaves somebody working on something nobody else was told about.
    const count = await raiseRequirements(
      parsed.data.eventId,
      auth.departmentName,
      parsed.data.requests,
      auth.session.user!.istid
    );
    return NextResponse.json({ success: true, count });
  } catch (error) {
    try {
      throwIfRequirementDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await actorTeam(request, "edit");
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();

    if (body?.action === "assign") {
      const parsed = requirementAssignSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
      await assignRequirement(
        parsed.data.requirementId,
        parsed.data.assigneeIstid,
        auth.departmentName
      );
      return NextResponse.json({ success: true });
    }

    const parsed = requirementStatusSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    // SQL decides whether this team may: only the TARGET team advances a requerimento, though
    // either side may cancel.
    await setRequirementStatus(
      parsed.data.requirementId,
      parsed.data.status,
      auth.session.user!.istid,
      auth.departmentName
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfRequirementDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
