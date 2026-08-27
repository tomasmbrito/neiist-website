import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import {
  addChecklistItem,
  getRequirementChecklist,
  removeChecklistItem,
  setChecklistItemDone,
} from "@/utils/db/requirementQueries";
import {
  checklistAddSchema,
  checklistRemoveSchema,
  checklistToggleSchema,
} from "@/schemas/requirements";
import { throwIfRequirementDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * The shared checklist (#242).
 *
 * **The caller's team is never taken from the body**, only from `?department=` plus a `canForTeam`
 * check — and even that is only "may this person act for this team at all". Which side of the
 * requerimento they are on, and therefore whether they may add or tick, is decided in SQL from the
 * requerimento itself. A route that decided it would be a second copy of the rule (#180).
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
  if (!canForTeam(session.roles, session.scopes, "team.content.edit", departmentName)) {
    return { error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  return { session, departmentName };
}

export async function GET(request: NextRequest) {
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  const requirementId = Number(request.nextUrl.searchParams.get("requirementId"));
  if (!Number.isInteger(requirementId) || requirementId <= 0) {
    return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
  }
  // Keyed by requirement AND team in SQL, so an id from a pair this team is not part of returns
  // nothing rather than relying on this route to compare.
  return NextResponse.json(await getRequirementChecklist(requirementId, auth.departmentName));
}

export async function POST(request: NextRequest) {
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  try {
    const parsed = checklistAddSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    // SQL refuses the TARGET team: the checklist is the requester's definition of done.
    const id = await addChecklistItem(
      parsed.data.requirementId,
      parsed.data.item,
      auth.departmentName
    );
    return NextResponse.json({ success: true, id });
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
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  try {
    const parsed = checklistToggleSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    // SQL refuses the REQUESTING team: ticking is the doer's statement, as `status` is in #232.
    await setChecklistItemDone(
      parsed.data.itemId,
      parsed.data.done,
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

export async function DELETE(request: NextRequest) {
  const auth = await actorTeam(request);
  if ("error" in auth) return auth.error;

  try {
    const parsed = checklistRemoveSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    // SQL also refuses a `brief` item here, with a message saying to untick it in the brief.
    await removeChecklistItem(parsed.data.itemId, auth.departmentName);
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
