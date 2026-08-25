import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  deleteTask,
  getTaskOwner,
  getTeamTasks,
  setTaskAssignee,
  setTaskStatus,
} from "@/utils/db/taskQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { throwIfTaskDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import {
  createTaskSchema,
  deleteTaskSchema,
  taskAssigneeSchema,
  updateTaskSchema,
} from "@/schemas/events";

/**
 * A team's tasks (#130).
 *
 * Same two rules as the events routes, for the same reasons:
 *
 *  - **Authorization is `canForTeam`**, never a bespoke check.
 *  - **Anything addressing an existing task resolves the owning team from the row first.** The id
 *    is the only thing the client controls, so taking the department from the body would be the
 *    IDOR shape.
 */
export async function GET(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });
  }
  if (!canForTeam(session.roles, session.scopes, "team.workspace.view", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  return NextResponse.json(await getTeamTasks(departmentName));
}

export async function POST(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = createTaskSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const input = parsed.data;

    if (!canForTeam(session.roles, session.scopes, "team.tasks.manage", input.departmentName)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const id = await createTask({ ...input, createdByIstid: session.user.istid });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    try {
      throwIfTaskDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

/** Status changes and assignment, discriminated by `action`. */
export async function PATCH(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const body = await request.json();
    const taskId = Number(body?.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
    }

    // The owner comes from the row, never the request.
    const owner = await getTaskOwner(taskId);
    if (!owner) return NextResponse.json({ error: "Tarefa não encontrada." }, { status: 404 });
    if (!canForTeam(session.roles, session.scopes, "team.tasks.manage", owner)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    if (body?.action === "assignee") {
      const parsed = taskAssigneeSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
      }
      await setTaskAssignee(taskId, parsed.data.istid, parsed.data.assign);
      return NextResponse.json({ success: true });
    }

    const parsed = updateTaskSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    await setTaskStatus(taskId, parsed.data.status);
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfTaskDbError(error);
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
    const parsed = deleteTaskSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
    }

    const owner = await getTaskOwner(parsed.data.taskId);
    if (!owner) return NextResponse.json({ error: "Tarefa não encontrada." }, { status: 404 });

    // `team.tasks.delete`, which is NOT grantable — deletion is irreversible and a borrowed
    // scope must not erase the team's record of its own work (#208's reasoning, applied here).
    if (!canForTeam(session.roles, session.scopes, "team.tasks.delete", owner)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    await deleteTask(parsed.data.taskId);
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfTaskDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
