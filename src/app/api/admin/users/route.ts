import { NextRequest, NextResponse } from "next/server";
import { getAllUsers, createUser } from "@/utils/db/userQueries";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { ValidationError } from "@/lib/errors";

export async function GET() {
  const userRoles = await serverCheckRoles([
    UserRole._MEMBER,
    UserRole._COORDINATOR,
    UserRole._ADMIN,
  ]);
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  try {
    const users = await getAllUsers();
    return NextResponse.json(users);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckRoles([
    UserRole._COORDINATOR,
    UserRole._SHOP_MANAGER,
    UserRole._ADMIN,
  ]);
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }

  try {
    const body = await request.json();
    const { istid, name, email } = body;

    if (!istid || !name || !email) {
      throw new ValidationError("Missing required fields: istid, name, and email are required");
    }
    const istIdPattern = /^ist\d+$/i;
    if (!istIdPattern.test(istid.trim())) {
      throw new ValidationError("Invalid IST ID format. Must be in format: istXXXXXX");
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email.trim())) {
      throw new ValidationError("Invalid email format");
    }
    const newUser = await createUser({
      istid: istid.trim(),
      name: name.trim(),
      email: email.trim(),
    });
    return NextResponse.json(newUser, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
