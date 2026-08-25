import { NextRequest, NextResponse } from "next/server";
import { previewNeiistEmail } from "@/utils/db/memberEmails";
import { serverCheckPermission } from "@/utils/permissionUtils";

/**
 * Preview the `@neiist.pt` address a name would get (#213), without reserving it.
 *
 * Exists so the add-member form can show the address *before* anyone commits. Reserving on
 * preview would burn an address every time somebody typed a name and changed their mind.
 *
 * Gated on `members.manage` because the answer leaks who already holds an address: asking for
 * "Ana Silva" and getting `ana.silva2` says an `ana.silva` exists. Small, but it is the same
 * class of thing as the attendance oracle (#208) and there is no reason to leave it open.
 */
export async function GET(request: NextRequest) {
  const check = await serverCheckPermission("members.manage");
  if (!check.isAuthorized) return check.error;

  const name = request.nextUrl.searchParams.get("name");
  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Indique o nome." }, { status: 400 });
  }

  return NextResponse.json({ preview: await previewNeiistEmail(name.trim()) });
}
