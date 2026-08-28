import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { getEventPlan, getPlanExternals, getPlanTodos } from "@/utils/db/eventPlanQueries";

/**
 * Reading the plan back after a change (#247).
 *
 * Separate from the write route so the write route has one job. Gated on `team.workspace.view`
 * rather than `team.events.manage`: a collaborating team reads the plan — a poster designer needs
 * the objetivo — and SQL decides whether this team is the owner or a collaborator.
 */
export async function GET(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const departmentName = request.nextUrl.searchParams.get("department");
  const eventId = Number(request.nextUrl.searchParams.get("eventId"));
  if (!departmentName || !Number.isInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
  }
  if (!canForTeam(session.roles, session.scopes, "team.workspace.view", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // All three are keyed by event AND team in SQL, so an event belonging to neither the caller's
  // team nor one it collaborates with returns nothing rather than relying on this route.
  const [plan, todos, externals] = await Promise.all([
    getEventPlan(eventId, departmentName),
    getPlanTodos(eventId, departmentName),
    getPlanExternals(eventId, departmentName),
  ]);

  return NextResponse.json({ plan, todos, externals });
}
