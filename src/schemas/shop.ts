import { z } from "zod";

// Schema for product variants
export const productVariantSchema = z.object({
  id: z.number().optional(),
  sku: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
  price_modifier: z.number().default(0),
  stock_quantity: z.number().nullable().optional(),
  active: z.boolean().default(true),
  images: z.array(z.string()).default([]),
});

// Schema for group images mapping
export const groupImageSchema = z.record(
  z.string(),
  z.object({
    existing: z.array(z.string()).default([]),
    uploads: z.array(z.string()).default([]),
    price_modifier: z.number().default(0),
    stock_quantity: z.number().nullable().optional(),
  })
);

// Payload for creating/updating a product
export const productPayloadSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  price: z.number().min(0, "Price cannot be negative"),
  category: z.string().nullable().optional(),
  images: z.array(z.string()).default([]),
  stock_type: z.enum(["limited", "on_demand"]),
  stock_quantity: z.number().nullable().optional(),
  order_deadline: z.string().nullable().optional(),
  active: z.boolean().default(true),
  has_variants: z.boolean().default(false),
  variant_definitions: z
    .array(
      z.object({
        name: z.string(),
        values: z.array(z.string()),
      })
    )
    .default([]),
  variants: z.array(productVariantSchema).default([]),
  variantsToDelete: z.array(z.number()).optional(),
  group_image_uploads: groupImageSchema.optional(),
});

// Payload for creating discount codes
export const discountCodeUpdateSchema = z.object({
  id: z.coerce.number().optional(),
  discount_code_id: z.coerce.number().optional(),
  code: z.string().optional(),
  discount_type: z.enum(["percentage", "fixed"]).optional(),
  discount_value: z.coerce.number().min(0).optional(),
  valid_product_ids: z.array(z.coerce.number()).nullable().optional(),
  valid_istids: z.array(z.string()).nullable().optional(),
  max_uses: z.coerce.number().min(0).nullable().optional(),
  expires_at: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

// Payload for bulk discount code creation
export const bulkDiscountCodePayloadSchema = z.object({
  recipients: z
    .array(
      z.object({
        istid: z.string().default(""),
        name: z.string().default(""),
        email: z.string().email(),
      })
    )
    .min(1, "Indica pelo menos um utilizador válido."),
  discount_type: z.enum(["percentage", "fixed"]),
  discount_value: z.coerce.number().min(0, "Valor de desconto inválido"),
  valid_product_ids: z.array(z.coerce.number()).nullable().optional(),
  max_uses: z.coerce
    .number()
    .min(1, "O número máximo de usos deve ser positivo.")
    .optional()
    .default(1),
  expires_at: z.string().nullable().optional(),
  email_subject: z.string().min(1, "O assunto e o texto do email são obrigatórios."),
  email_intro_line: z.string().optional(),
  email_markdown: z.string().optional(),
  active: z.boolean().optional(),
});

// Payload for placing a new order
export const createOrderPayloadSchema = z.object({
  user_istid: z.string().optional(),
  customer_name: z.string().optional(),
  customer_email: z.string().email().optional(),
  customer_phone: z.string().optional(),
  customer_nif: z.string().optional(),
  campus: z.string().optional(),
  notes: z.string().optional(),
  stock_override: z.boolean().optional(),
  payment_method: z
    .enum(["mbway", "card", "cash", "other", "sumup", "transfer", "in-person"])
    .optional(),
  payment_reference: z.string().optional(),
  guest_checkout: z.boolean().optional(),
  discount_code: z.string().optional(),
  items: z
    .array(
      z.object({
        product_id: z.coerce.number(),
        variant_id: z.coerce.number().optional(),
        quantity: z.coerce.number().min(1),
      })
    )
    .min(1, "Order must contain at least one item"),
  order_source: z.string().optional(),
});

// Payload for SumUp checkout
export const sumUpCheckoutPayloadSchema = z.object({
  orderId: z.coerce.number().min(1, "Invalid orderId"),
});
