import { NextResponse } from "next/server";
import { addProduct, addProductVariant, getProduct } from "@/utils/db/shopQueries";
import { serverCheckPermission } from "@/utils/permissionUtils";
import { withValidation } from "@/utils/security/validationUtils";
import { productPayloadSchema } from "@/schemas/shop";

export const POST = withValidation(productPayloadSchema, async (request, body) => {
  const permissionCheck = await serverCheckPermission("shop.products.manage");
  if (!permissionCheck.isAuthorized) return permissionCheck.error;

  try {
    const newProduct = await addProduct({
      name: body.name,
      description: body.description ?? "",
      price: body.price,
      category: body.category ?? undefined,
      images: body.images,
      stock_type: body.stock_type,
      stock_quantity: body.stock_quantity ?? undefined,
      order_deadline: body.order_deadline ?? undefined,
      active: true,
    });

    if (!newProduct) {
      return NextResponse.json({ error: "Failed to create product" }, { status: 500 });
    }

    // Build a map of group images: "optType::optVal" -> string[]
    const groupImagePaths: Record<string, string[]> = {};
    if (body.group_image_uploads) {
      for (const [key, groupData] of Object.entries(body.group_image_uploads)) {
        groupImagePaths[key] = [...groupData.existing, ...groupData.uploads];
      }
    }

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

      await addProductVariant(newProduct.id, {
        sku: variant.sku ?? "",
        images: variantImages,
        price_modifier: variant.price_modifier ?? 0,
        stock_quantity: variant.stock_quantity ?? undefined,
        active: variant.active ?? true,
        options: variant.options ?? {},
      });
    }

    const fullProduct = await getProduct(newProduct.id);

    return NextResponse.json(
      {
        message: "Product created successfully",
        product: fullProduct || newProduct,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating product:", error);
    return NextResponse.json({ error: "Failed to create product" }, { status: 500 });
  }
});
