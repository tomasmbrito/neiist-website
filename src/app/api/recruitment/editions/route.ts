import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { UserRole } from "@/types/user";
import { createRecruitmentEdition } from "@/lib/db/repositories/recruitment.repository";

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const body = await request.json();

    if (typeof body.name !== "string" || body.name.trim().length === 0)
      return NextResponse.json({ error: "Nome obrigatório" }, { status: 400 });

    const opensAt = new Date(body.opensAt);
    const closesAt = new Date(body.closesAt);
    if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime()))
      return NextResponse.json({ error: "Datas inválidas" }, { status: 400 });

    if (closesAt <= opensAt)
      return NextResponse.json(
        { error: "A data de fecho tem de ser depois da de abertura" },
        { status: 400 }
      );

    const id = await createRecruitmentEdition(
      body.name.trim(),
      opensAt.toISOString(),
      closesAt.toISOString(),
      userRoles.user!.istid
    );

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
