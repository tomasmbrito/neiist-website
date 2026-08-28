import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import {
  addPlanExternal,
  addPlanTodo,
  raiseRequirementFromTodo,
  removePlanExternal,
  removePlanTodo,
  setPlanCollaborator,
  setPlanTodoDone,
  upsertEventPlan,
} from "@/utils/db/eventPlanQueries";
import {
  eventPlanSchema,
  planCollaboratorSchema,
  planExternalSchema,
  planTodoSchema,
  planTodoToggleSchema,
  raiseFromTodoSchema,
} from "@/schemas/eventPlan";
import { throwIfRequirementDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Plano de Atividades (#247).
 *
 * The caller's team comes from `?department=` plus `canForTeam` — which answers only "may this
 * person act for this team at all". **Whether that team owns the event is decided in SQL**, from
 * the event itself. A route deciding it would be a second copy of the rule (#180), and the copy is
 * the one that goes wrong.
 */
async function actorTeam(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return { error: NextResponse.json({ error: "Indique a equipa." }, { status: 400 }) };
  }
  if (!canForTeam(session.roles, session.scopes, "team.events.manage", departmentName)) {
    return { error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  return { session, departmentName };
}

/** One place for the parse → act → respond cycle, so eight actions do not repeat it eight times. */
async function run<T>(
  parsed: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } },
  act: (_data: T) => Promise<unknown>
) {
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
      { status: 400 }
    );
  }
  try {
    const result = await act(parsed.data);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    try {
      throwIfRequirementDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  const body = await request.json();
  const istid = auth.session.user!.istid;
  const team = auth.departmentName;

  switch (body?.action) {
    case "collaborator":
      return run(planCollaboratorSchema.safeParse(body), (data) =>
        setPlanCollaborator(data.eventId, data.istid, data.add, team)
      );
    case "external":
      return run(planExternalSchema.safeParse(body), (data) =>
        addPlanExternal(data.eventId, data.kind, data.name, data.detail ?? null, team)
      );
    case "todo":
      return run(planTodoSchema.safeParse(body), (data) =>
        addPlanTodo(data.eventId, data.task, data.assigneeIstid, team)
      );
    case "todo-done":
      return run(planTodoToggleSchema.safeParse(body), (data) =>
        setPlanTodoDone(data.todoId, data.done, istid, team)
      );
    // The action this slice exists for: the to-do stops being a line somebody has to remember and
    // becomes the requerimento, with the to-do pointing at it.
    case "raise":
      return run(raiseFromTodoSchema.safeParse(body), (data) =>
        raiseRequirementFromTodo(
          data.todoId,
          data.targetDepartment,
          data.title,
          data.detail ?? null,
          data.deadline ?? null,
          istid,
          team
        )
      );
    default:
      return run(eventPlanSchema.safeParse(body), (data) =>
        upsertEventPlan(
          data.eventId,
          data.objetivo,
          data.estrutura,
          data.coordinatorIstid,
          istid,
          team
        )
      );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  const body = await request.json();
  const team = auth.departmentName;

  try {
    if (body?.kind === "external") {
      await removePlanExternal(Number(body.id), team);
    } else {
      // SQL refuses a to-do that already produced a requerimento, with a message saying to cancel
      // that first — another team is working from it by then.
      await removePlanTodo(Number(body.id), team);
    }
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
