import { db_query } from "../connection";
import {
  Product,
  ProductVariant,
  dbProduct,
  dbProductVariant,
  decodeVariantOptionsFromStorage,
  encodeVariantOptionsForStorage,
  mapdbProductToProduct,
} from "@/types/shop/product";
import { Category, dbCategory, mapdbCategoryToCategory } from "@/types/shop/category";
import {
  DiscountCode,
  DiscountCodeInput,
  DiscountCodeUpdateInput,
  DiscountValidationResult,
  dbDiscountCode,
  mapdbDiscountCodeToDiscountCode,
} from "@/types/shop/discountCode";
import { Order, dbOrder, mapdbOrderToOrder } from "@/types/shop/order";
import { isSpecialCategory } from "@/utils/shop/orderKindUtils";

export class ShopRepository {
  // PRODUCTS
  static async addProduct(
    product: Partial<Product> & {
      name: string;
      price: number;
      stock_type: Product["stock_type"];
      active?: boolean;
    }
  ): Promise<Product | null> {
    const {
      rows: [row],
    } = await db_query<dbProduct>(`SELECT * FROM neiist.add_product($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      product.name,
      product.description ?? null,
      product.price,
      product.images ?? [],
      product.category ?? null,
      product.stock_type,
      product.stock_quantity ?? null,
      product.order_deadline ?? null,
      product.active ?? true,
    ]);
    return row ? mapdbProductToProduct(row) : null;
  }

  static async addProductVariant(
    productId: number,
    variant: Partial<ProductVariant> & { price_modifier?: number }
  ): Promise<Product | null> {
    const {
      rows: [row],
    } = await db_query<dbProduct>(
      `SELECT * FROM neiist.add_product_variant($1,$2,$3,$4,$5,$6,$7)`,
      [
        productId,
        variant.sku ?? null,
        variant.images ?? [],
        variant.price_modifier ?? 0,
        variant.stock_quantity ?? null,
        variant.active ?? true,
        JSON.stringify(encodeVariantOptionsForStorage(variant.options ?? {})),
      ]
    );
    return row ? mapdbProductToProduct(row) : null;
  }

  static async getAllProducts(includeSpecial: boolean = false): Promise<Product[]> {
    const { rows } = await db_query<dbProduct>(`SELECT * FROM neiist.get_all_products()`);
    const products = rows.map(mapdbProductToProduct);
    return includeSpecial
      ? products
      : products.filter((product) => !isSpecialCategory(product.category));
  }

  static async getAllProductsAdmin(): Promise<Product[]> {
    const { rows } = await db_query<dbProduct>(
      `SELECT * FROM neiist.get_all_products_including_archived()`
    );
    return rows.map(mapdbProductToProduct);
  }

  static async deleteProduct(productId: number): Promise<void> {
    await db_query(`SELECT neiist.delete_product($1)`, [productId]);
  }

  static async deleteProductVariant(variantId: number): Promise<void> {
    await db_query(`SELECT neiist.delete_product_variant($1)`, [variantId]);
  }

  static async getProduct(productId: number): Promise<Product | null> {
    const {
      rows: [row],
    } = await db_query<dbProduct>(`SELECT * FROM neiist.get_product($1)`, [productId]);
    return row ? mapdbProductToProduct(row) : null;
  }

  static async updateProduct(
    productId: number,
    updates: Partial<Product> & { category?: string; active?: boolean }
  ): Promise<Product | null> {
    const {
      rows: [row],
    } = await db_query<dbProduct>(`SELECT * FROM neiist.update_product($1,$2)`, [
      productId,
      JSON.stringify(updates),
    ]);
    return row ? mapdbProductToProduct(row) : null;
  }

  static async updateProductVariant(
    variantId: number,
    updates: Partial<ProductVariant>
  ): Promise<ProductVariant | null> {
    const {
      rows: [row],
    } = await db_query<dbProductVariant>(`SELECT * FROM neiist.update_product_variant($1,$2)`, [
      variantId,
      JSON.stringify({
        sku: updates.sku,
        images: updates.images,
        price_modifier: updates.price_modifier,
        stock_quantity:
          updates.stock_quantity == null ? null : Math.round(Number(updates.stock_quantity)),
        active: updates.active,
        options: encodeVariantOptionsForStorage(updates.options ?? {}),
      }),
    ]);
    return row
      ? {
          id: row.id,
          sku: row.sku ?? undefined,
          images: row.images ?? undefined,
          price_modifier: Number(row.price_modifier ?? 0),
          stock_quantity: row.stock_quantity ?? undefined,
          active: row.active,
          options: decodeVariantOptionsFromStorage(row.options),
          label: row.label ?? undefined,
        }
      : null;
  }

  // DISCOUNT CODES
  static async getAllDiscountCodes(): Promise<DiscountCode[]> {
    try {
      const { rows } = await db_query<dbDiscountCode>(
        `SELECT * FROM neiist.get_all_discount_codes()`
      );
      return rows.map(mapdbDiscountCodeToDiscountCode);
    } catch (error) {
      console.error("Error fetching discount codes:", error);
      return [];
    }
  }

  static async createDiscountCode(discountCode: DiscountCodeInput): Promise<DiscountCode | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbDiscountCode>(
        `SELECT * FROM neiist.add_discount_code($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          discountCode.code,
          discountCode.discount_type,
          discountCode.discount_value,
          discountCode.valid_product_ids ?? null,
          discountCode.valid_istids ?? null,
          discountCode.max_uses ?? null,
          discountCode.expires_at ?? null,
          discountCode.active ?? true,
        ]
      );
      return row ? mapdbDiscountCodeToDiscountCode(row) : null;
    } catch (error) {
      console.error("Error creating discount code:", error);
      return null;
    }
  }

  static async updateDiscountCode(
    discountCodeId: number,
    updates: DiscountCodeUpdateInput
  ): Promise<DiscountCode | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbDiscountCode>(`SELECT * FROM neiist.update_discount_code($1,$2)`, [
        discountCodeId,
        JSON.stringify(updates),
      ]);
      return row ? mapdbDiscountCodeToDiscountCode(row) : null;
    } catch (error) {
      console.error("Error updating discount code:", error);
      return null;
    }
  }

  static async deleteDiscountCode(discountCodeId: number): Promise<void> {
    await db_query(`SELECT neiist.delete_discount_code($1)`, [discountCodeId]);
  }

  static async validateDiscountCode(
    code: string,
    user_istid: string | null,
    cartItems: { productId: number; quantity: number }[]
  ): Promise<DiscountValidationResult> {
    const {
      rows: [row],
    } = await db_query<{
      is_valid: boolean;
      error_message: string;
      discount_value: number;
      discount_type: string;
    }>(
      `SELECT * FROM neiist.validate_discount_code($1, (SELECT id FROM neiist.users WHERE istid = $2::VARCHAR(10)), $3)`,
      [code, user_istid, JSON.stringify(cartItems)]
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return row as any;
  }

  // CATEGORIES
  static async getAllCategories(includeSpecial: boolean = false): Promise<Category[]> {
    try {
      const { rows } = await db_query<dbCategory>(`SELECT * FROM neiist.get_all_categories()`);
      const categories = rows.map(mapdbCategoryToCategory);
      return includeSpecial ? categories : categories.filter((c) => !isSpecialCategory(c.name));
    } catch (error) {
      console.error("Error fetching categories:", error);
      return [];
    }
  }

  static async addCategory(name: string): Promise<Category | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbCategory>(`SELECT * FROM neiist.get_or_create_category($1)`, [name]);
      return row ? mapdbCategoryToCategory(row) : null;
    } catch (error) {
      console.error("Error adding category:", error);
      return null;
    }
  }

  // ORDERS
  static async newOrder(
    order: Partial<Order>,
    stockOverride: boolean = false
  ): Promise<Order | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbOrder>(
        `SELECT * FROM neiist.new_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          order.user_istid ?? null,
          order.customer_name ?? null,
          order.customer_email ?? null,
          order.customer_phone ?? null,
          order.customer_nif ?? null,
          order.campus ?? null,
          order.notes ?? null,
          order.payment_method ?? null,
          order.payment_reference ?? null,
          order.created_by ?? null,
          JSON.stringify(
            order.items?.map((i) => ({
              product_id: i.product_id,
              variant_id: i.variant_id ?? null,
              quantity: i.quantity,
            })) ?? []
          ),
          order.discount_code ?? null,
          stockOverride,
        ]
      );
      return row ? mapdbOrderToOrder(row) : null;
    } catch (error) {
      console.error("Error creating order:", error);
      throw error;
    }
  }

  static async getAllOrders(): Promise<Order[]> {
    try {
      const { rows } = await db_query<dbOrder>(`SELECT * FROM neiist.get_all_orders()`);
      return rows.map(mapdbOrderToOrder);
    } catch (error) {
      console.error("Error fetching orders:", error);
      return [];
    }
  }

  static async getOrderById(orderId: number): Promise<Order | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbOrder>(`SELECT * FROM neiist.get_order($1, NULL)`, [orderId]);
      return row ? mapdbOrderToOrder(row) : null;
    } catch (error) {
      console.error("Error fetching order by ID:", error);
      return null;
    }
  }

  static async getOrderByNumber(orderNumber: string): Promise<Order | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbOrder>(`SELECT * FROM neiist.get_order(NULL, $1)`, [orderNumber]);
      return row ? mapdbOrderToOrder(row) : null;
    } catch (error) {
      console.error("Error fetching order by number:", error);
      return null;
    }
  }

  static async getUserOrderedProductsInCategory(
    user_id: string,
    categoryName: string
  ): Promise<{ product_id: number; total_quantity: number }[]> {
    try {
      const { rows } = await db_query<{ product_id: number; total_quantity: number }>(
        `SELECT product_id, total_quantity FROM neiist.get_user_ordered_products_in_category($1::UUID, $2)`,
        [user_id, categoryName]
      );
      return rows;
    } catch (error) {
      console.error("Error fetching user ordered products:", error);
      return [];
    }
  }

  static async updateOrder(
    orderId: number,
    updates: Partial<Order>,
    stockOverride: boolean = false,
    updatedBy: string
  ): Promise<Order | null> {
    try {
      const {
        rows: [row],
      } = await db_query<dbOrder>(`SELECT * FROM neiist.update_order($1, $2, $3, $4::UUID)`, [
        orderId,
        JSON.stringify(updates),
        stockOverride,
        updatedBy,
      ]);
      return row ? mapdbOrderToOrder(row) : null;
    } catch (error) {
      console.error("Error updating order:", error);
      throw error;
    }
  }

  static async setOrderState(orderId: number, status: string, updatedBy: string): Promise<boolean> {
    try {
      await db_query(`SELECT neiist.set_order_state($1, $2, $3::UUID)`, [
        orderId,
        status,
        updatedBy,
      ]);
      return true;
    } catch (error) {
      console.error("Error updating order state:", error);
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static mapOrderDbErrorToResponse(error: any): { error: string; status: number } {
    const errorMsg = error?.message || "Unknown error";
    if (errorMsg.includes("User has not accepted the Terms and Conditions")) {
      return { error: "You must accept the Terms and Conditions to place an order.", status: 400 };
    }
    if (errorMsg.includes("Insufficient product stock")) {
      return { error: "One or more items in your cart are out of stock.", status: 400 };
    }
    if (errorMsg.includes("Invalid discount code") || errorMsg.includes("Discount code")) {
      return { error: "Invalid or expired discount code.", status: 400 };
    }
    if (errorMsg.includes("Order deadline has passed")) {
      return { error: "The order deadline for one or more items has passed.", status: 400 };
    }
    if (errorMsg.includes("Failed to generate a unique order number")) {
      return { error: "Failed to generate order number. Please try again.", status: 500 };
    }
    return { error: "An unexpected error occurred while placing your order.", status: 500 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static mapDeleteProductDbErrorToResponse(error: any): { error: string; status: number } {
    const errorMsg = error?.message || "Unknown error";
    if (errorMsg.includes("Cannot delete product because it is part of existing orders")) {
      return { error: "Cannot delete product because it is part of existing orders.", status: 400 };
    }
    return { error: "An unexpected error occurred while deleting the product.", status: 500 };
  }
}
