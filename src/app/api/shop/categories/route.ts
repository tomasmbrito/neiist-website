import { NextRequest, NextResponse } from "next/server";
import { getAllCategories, addCategory } from "@/utils/db/shopQueries";
import { serverCheckPermission } from "@/utils/permissionUtils";

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckPermission("shop.categories.manage");
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const { name } = await request.json();
    if (!name || !name.trim())
      return NextResponse.json({ error: "Category name is required" }, { status: 400 });

    const category = await addCategory(name.trim());
    if (!category)
      return NextResponse.json({ error: "Failed to create category" }, { status: 500 });

    return NextResponse.json(
      {
        category: {
          id: category.id,
          name: category.name,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating category:", error);
    return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const categories = await getAllCategories(true);
    return NextResponse.json({ categories });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return NextResponse.json({ error: "Failed to fetch categories" }, { status: 500 });
  }
}
