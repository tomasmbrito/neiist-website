import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@/types/user";
import {
  updateProduct,
  updateProductVariant,
  getProduct,
  addProductVariant,
  deleteProduct,
  deleteProductVariant,
  mapDeleteProductDbErrorToResponse,
} from "@/utils/dbUtils";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { withValidation } from "@/utils/security/validationUtils";
import { productPayloadSchema } from "@/schemas/shop";

export const PUT = withValidation(
  productPayloadSchema,
  async (request, body, { params }: { params: Promise<{ id: string }> }) => {
    const permissionCheck = await serverCheckRoles([UserRole._ADMIN]);
    if (!permissionCheck.isAuthorized) return permissionCheck.error;

    try {
      const { id } = await params;
      const productId = Number(id);

      await updateProduct(productId, {
        name: body.name,
        description: body.description ?? "",
        price: body.price,
        category: body.category ?? undefined,
        images: body.images,
        stock_type: body.stock_type,
        stock_quantity: body.stock_quantity ?? undefined,
        order_deadline: body.order_deadline ?? undefined,
        active: body.active ?? true,
      });

      if (Array.isArray(body.variantsToDelete) && body.variantsToDelete.length > 0) {
        for (const variantId of body.variantsToDelete) {
          await deleteProductVariant(Number(variantId));
        }
      }

      // Build a map of group images: "optType::optVal" -> string[]
      const groupImagePaths: Record<string, string[]> = {};
      if (body.group_image_uploads) {
        for (const [key, groupData] of Object.entries(body.group_image_uploads)) {
          groupImagePaths[key] = [...groupData.existing, ...groupData.uploads];
        }
      }

      if (Array.isArray(body.variants) && body.variants.length > 0) {
        for (const variant of body.variants) {
          let variantImages: string[] = variant.images || [];

          // Apply group images to variants that have no images of their own
          if (variantImages.length === 0) {
            for (const [optType, optVal] of Object.entries(variant.options || {})) {
              const key = `${optType}::${optVal}`;
              if (groupImagePaths[key]?.length > 0) {
                variantImages = groupImagePaths[key];
                break; // use first matching group's images
              }
            }
          }

          if (variant.id) {
            await updateProductVariant(variant.id as number, {
              sku: variant.sku ?? "",
              images: variantImages,
              price_modifier: variant.price_modifier ?? 0,
              stock_quantity: variant.stock_quantity ?? undefined,
              active: variant.active ?? true,
              options: variant.options ?? {},
            });
          } else {
            await addProductVariant(productId, {
              sku: variant.sku ?? "",
              images: variantImages,
              price_modifier: variant.price_modifier ?? 0,
              stock_quantity: variant.stock_quantity ?? undefined,
              active: variant.active ?? true,
              options: variant.options ?? {},
            });
          }
        }
      }

      const updatedProduct = await getProduct(productId);
      if (!updatedProduct) {
        return NextResponse.json(
          { error: "Product not found or failed to update" },
          { status: 404 }
        );
      }

      return NextResponse.json({
        message: "Product updated successfully",
        product: updatedProduct,
      });
    } catch (error) {
      const mapped = mapDeleteProductDbErrorToResponse(error);
      if (mapped) return NextResponse.json({ error: mapped.error }, { status: mapped.status });
      console.error("Error updating product:", error);
      return NextResponse.json({ error: "Failed to update product" }, { status: 500 });
    }
  }
);

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const { id } = await params;
    const productId = Number(id);
    const permanent = request.nextUrl.searchParams.get("permanent") === "true";

    if (permanent) {
      await deleteProduct(productId);
      return NextResponse.json({ message: "Product permanently deleted" });
    }

    const archivedProduct = await updateProduct(productId, { active: false });
    if (!archivedProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Product archived successfully" });
  } catch (error) {
    const mapped = mapDeleteProductDbErrorToResponse(error);
    if (mapped) return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    console.error("Error deleting product:", error);
    return NextResponse.json({ error: "Failed to delete product" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const { id } = await params;
    const productId = Number(id);
    const body = await request.json();

    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "Missing or invalid 'active' field" }, { status: 400 });
    }

    const updated = await updateProduct(productId, { active: body.active });
    if (!updated) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Product updated", product: updated });
  } catch (error) {
    console.error("Error patching product:", error);
    return NextResponse.json({ error: "Failed to update product" }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const productId = Number(id);

    const product = await getProduct(productId);

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    return NextResponse.json(product);
  } catch (error) {
    console.error("Error fetching product:", error);
    return NextResponse.json({ error: "Failed to fetch product" }, { status: 500 });
  }
}
