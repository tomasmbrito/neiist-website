import {
  Product,
  ProductVariant,
  DbProduct,
  DbProductVariant,
  decodeVariantOptionsFromStorage,
  encodeVariantOptionsForStorage,
  mapDbProductToProduct,
} from "@/types/shop/product";
import { Order, DbOrder, mapDbOrderToOrder } from "@/types/shop/order";
import { OrderStatus } from "@/types/shop/orderStatus";
import { Category, DbCategory, mapDbCategoryToCategory } from "@/types/shop/category";
import {
  DiscountCode,
  DiscountCodeInput,
  DiscountCodeUpdateInput,
  DiscountValidationResult,
  DbDiscountCode,
  mapDbDiscountCodeToDiscountCode,
} from "@/types/shop/discountCode";
import { isSpecialCategory } from "@/utils/shop/orderKindUtils";
import { SPECIAL_CATEGORIES } from "@/types/shop/orderKind";
import { getMbWayNumberForOrder } from "@/lib/mbwayNumbers";
import { db_query } from "@/utils/db/dbClient";

export const addProduct = async (
  product: Partial<Product> & {
    name: string;
    price: number;
    stock_type: Product["stock_type"];
    active?: boolean;
  }
): Promise<Product | null> => {
  const {
    rows: [row],
  } = await db_query<DbProduct>(`SELECT * FROM neiist.add_product($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
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
  return row ? mapDbProductToProduct(row) : null;
};

export const addProductVariant = async (
  productId: number,
  variant: Partial<ProductVariant> & { price_modifier?: number }
): Promise<Product | null> => {
  const {
    rows: [row],
  } = await db_query<DbProduct>(`SELECT * FROM neiist.add_product_variant($1,$2,$3,$4,$5,$6,$7)`, [
    productId,
    variant.sku ?? null,
    variant.images ?? [],
    variant.price_modifier ?? 0,
    variant.stock_quantity ?? null,
    variant.active ?? true,
    JSON.stringify(encodeVariantOptionsForStorage(variant.options ?? {})),
  ]);
  return row ? mapDbProductToProduct(row) : null;
};

export const getAllProducts = async (includeSpecial: boolean = false): Promise<Product[]> => {
  const { rows } = await db_query<DbProduct>(`SELECT * FROM neiist.get_all_products()`);
  const products = rows.map(mapDbProductToProduct);
  return includeSpecial
    ? products
    : products.filter((product) => !isSpecialCategory(product.category));
};

export const getAllProductsAdmin = async (): Promise<Product[]> => {
  const { rows } = await db_query<DbProduct>(
    `SELECT * FROM neiist.get_all_products_including_archived()`
  );
  return rows.map(mapDbProductToProduct);
};

export const deleteProduct = async (productId: number): Promise<void> => {
  await db_query(`SELECT neiist.delete_product($1)`, [productId]);
};

export const deleteProductVariant = async (variantId: number): Promise<void> => {
  await db_query(`SELECT neiist.delete_product_variant($1)`, [variantId]);
};

export const getProduct = async (productId: number): Promise<Product | null> => {
  const {
    rows: [row],
  } = await db_query<DbProduct>(`SELECT * FROM neiist.get_product($1)`, [productId]);
  return row ? mapDbProductToProduct(row) : null;
};

export const updateProduct = async (
  productId: number,
  updates: Partial<Product> & { category?: string; active?: boolean }
): Promise<Product | null> => {
  const {
    rows: [row],
  } = await db_query<DbProduct>(`SELECT * FROM neiist.update_product($1,$2)`, [
    productId,
    JSON.stringify(updates),
  ]);
  return row ? mapDbProductToProduct(row) : null;
};

export const updateProductVariant = async (
  variantId: number,
  updates: Partial<ProductVariant>
): Promise<ProductVariant | null> => {
  const {
    rows: [row],
  } = await db_query<DbProductVariant>(`SELECT * FROM neiist.update_product_variant($1,$2)`, [
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
};

export const getAllDiscountCodes = async (): Promise<DiscountCode[]> => {
  try {
    const { rows } = await db_query<DbDiscountCode>(
      `SELECT * FROM neiist.get_all_discount_codes()`
    );
    return rows.map(mapDbDiscountCodeToDiscountCode);
  } catch (error) {
    console.error("Error fetching discount codes:", error);
    return [];
  }
};

export const createDiscountCode = async (
  discountCode: DiscountCodeInput
): Promise<DiscountCode | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<DbDiscountCode>(
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
    return row ? mapDbDiscountCodeToDiscountCode(row) : null;
  } catch (error) {
    console.error("Error creating discount code:", error);
    return null;
  }
};

export const updateDiscountCode = async (
  discountCodeId: number,
  updates: DiscountCodeUpdateInput
): Promise<DiscountCode | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<DbDiscountCode>(`SELECT * FROM neiist.update_discount_code($1, $2)`, [
      discountCodeId,
      JSON.stringify(updates),
    ]);
    return row ? mapDbDiscountCodeToDiscountCode(row) : null;
  } catch (error) {
    console.error("Error updating discount code:", error);
    return null;
  }
};

export const deleteDiscountCode = async (discountCodeId: number): Promise<boolean> => {
  try {
    await db_query(`SELECT neiist.delete_discount_code($1)`, [discountCodeId]);
    return true;
  } catch (error) {
    console.error("Error deleting discount code:", error);
    return false;
  }
};

export const validateDiscountCode = async (
  code: string,
  userIstid: string | null,
  cartItems: Array<{
    product_id: number;
    variant_id?: number | null;
    quantity: number;
  }>
): Promise<DiscountValidationResult | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<DiscountValidationResult>(
      `SELECT * FROM neiist.validate_discount_code($1, $2, $3)`,
      [code, userIstid ?? null, JSON.stringify(cartItems)]
    );
    return row ?? null;
  } catch (error) {
    console.error("Error validating discount code:", error);
    return null;
  }
};

export const newOrder = async (
  order: Omit<Partial<Order>, "items"> & {
    user_istid?: string;
    items: Array<{ product_id: number; variant_id?: number; quantity: number }>;
    discount_code?: string | null;
  },
  stockOverride: boolean = false
): Promise<Order | null> => {
  const {
    rows: [row],
  } = await db_query<DbOrder>(
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
        order.items.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id ?? null,
          quantity: i.quantity,
        }))
      ),
      order.discount_code ?? null,
      stockOverride,
    ]
  );
  return row
    ? {
        ...mapDbOrderToOrder(row),
        mbway_number: getMbWayNumberForOrder(row.order_number),
      }
    : null;
};

export const getAllOrders = async (): Promise<Order[]> => {
  const { rows } = await db_query<DbOrder>(`SELECT * FROM neiist.get_all_orders()`);
  return rows.map((row) => ({
    ...mapDbOrderToOrder(row),
    mbway_number: getMbWayNumberForOrder(row.order_number),
  }));
};

export const getOrderById = async (orderId: number): Promise<Order | null> => {
  const {
    rows: [row],
  } = await db_query<DbOrder>(`SELECT * FROM neiist.get_order($1, NULL)`, [orderId]);
  return row
    ? {
        ...mapDbOrderToOrder(row),
        mbway_number: getMbWayNumberForOrder(row.order_number),
      }
    : null;
};

export const getOrderByNumber = async (orderNumber: string): Promise<Order | null> => {
  // get_order(p_order_id INT, p_order_number TEXT) — the number goes in the SECOND argument.
  // Passing it first sent the order number into p_order_id. Order numbers are all digits
  // (YYYYMMDD + sequence, see neiist.generate_order_number), so this did not raise a cast
  // error: it looked the value up as a primary key and quietly returned null for every real
  // order number.
  const {
    rows: [row],
  } = await db_query<DbOrder>(`SELECT * FROM neiist.get_order(NULL, $1)`, [orderNumber]);
  return row
    ? {
        ...mapDbOrderToOrder(row),
        mbway_number: getMbWayNumberForOrder(row.order_number),
      }
    : null;
};

export const getUserOrderedProductsInCategory = async (
  userIstid: string,
  categoryName: string
): Promise<Record<number, number>> => {
  if (!userIstid || !categoryName) return {};
  const { rows } = await db_query<{ product_id: number; total: number }>(
    `SELECT * FROM neiist.get_user_ordered_products_in_category($1, $2)`,
    [userIstid, categoryName]
  );
  const result: Record<number, number> = {};
  for (const row of rows) result[Number(row.product_id)] = Number(row.total ?? 0);
  return result;
};

export const updateOrder = async (
  orderId: number,
  updates: Partial<Order>,
  stockOverride: boolean = false,
  user_istid?: string
): Promise<Order | null> => {
  const {
    rows: [row],
  } = await db_query<DbOrder>(`SELECT * FROM neiist.update_order($1,$2,$3,$4)`, [
    orderId,
    JSON.stringify(updates),
    stockOverride,
    user_istid ?? null,
  ]);
  return row ? mapDbOrderToOrder(row) : null;
};

export const setOrderState = async (
  orderId: number,
  status: OrderStatus,
  user_istid?: string
): Promise<Order | null> => {
  const {
    rows: [row],
  } = await db_query<DbOrder>(`SELECT * FROM neiist.set_order_state($1,$2,$3)`, [
    orderId,
    status,
    user_istid ?? null,
  ]);
  return row ? mapDbOrderToOrder(row) : null;
};

export const getAllCategories = async (includeSpecial: boolean = false): Promise<Category[]> => {
  await Promise.all(SPECIAL_CATEGORIES.map((categoryName) => addCategory(categoryName)));
  try {
    const { rows } = await db_query<Category>("SELECT * FROM neiist.get_all_categories()");
    return includeSpecial ? rows : rows.filter((category) => !isSpecialCategory(category.name));
  } catch (error) {
    console.error("Error fetching categories:", error);
    return [];
  }
};

export const addCategory = async (name: string): Promise<Category | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<DbCategory>(`SELECT * FROM neiist.get_or_create_category($1)`, [name]);
    return row ? mapDbCategoryToCategory(row) : null;
  } catch (error) {
    console.error("Error adding category:", error);
    return null;
  }
};
