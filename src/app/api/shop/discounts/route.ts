import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@/types/user";
import {
  createDiscountCode,
  deleteDiscountCode,
  getAllDiscountCodes,
  updateDiscountCode,
} from "@/utils/db/shopQueries";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { sendEmail, getDiscountCampaignEmailTemplate } from "@/utils/emailUtils";
import type {
  DiscountCodeInput,
  DiscountCodeUpdateInput,
  DiscountBulkGenerateInput,
} from "@/types/shop/discountCode";
import { withValidation } from "@/utils/security/validationUtils";
import { bulkDiscountCodePayloadSchema, discountCodeUpdateSchema } from "@/schemas/shop";

function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function createCodeForRecipient(
  recipient: DiscountBulkGenerateInput["recipients"][number],
  payload: Omit<DiscountBulkGenerateInput, "recipients" | "email_subject" | "email_intro_line">
): Promise<Awaited<ReturnType<typeof createDiscountCode>> | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const created = await createDiscountCode({
      code: generateCode(),
      discount_type: payload.discount_type,
      discount_value: payload.discount_value,
      valid_product_ids: payload.valid_product_ids ?? null,
      valid_istids: recipient.istid ? [recipient.istid] : [],
      max_uses: payload.max_uses ?? 1,
      expires_at: payload.expires_at ?? null,
      active: payload.active ?? true,
    } satisfies DiscountCodeInput);

    if (created) return created;
  }

  return null;
}

export async function GET() {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const codes = await getAllDiscountCodes();
  return NextResponse.json(codes);
}

export const POST = withValidation(bulkDiscountCodePayloadSchema, async (request, body) => {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const emailIntroLine = body.email_intro_line ?? body.email_markdown;
    if (!emailIntroLine) {
      return NextResponse.json({ error: "O texto do email é obrigatório." }, { status: 400 });
    }

    const createdCodes = [] as NonNullable<Awaited<ReturnType<typeof createDiscountCode>>>[];
    const failedRecipients: Array<{ istid: string; error: string }> = [];
    let sentCount = 0;

    for (const recipient of body.recipients) {
      const created = await createCodeForRecipient(recipient, {
        discount_type: body.discount_type,
        discount_value: body.discount_value,
        valid_product_ids: body.valid_product_ids ?? null,
        max_uses: body.max_uses ?? 1,
        expires_at: body.expires_at ?? null,
        active: body.active ?? true,
      });

      if (!created) {
        failedRecipients.push({
          istid: recipient.istid ?? "",
          error: "Não foi possível gerar o código.",
        });
        continue;
      }

      createdCodes.push(created);

      const sent = await sendEmail({
        to: recipient.email,
        subject: body.email_subject,
        html: getDiscountCampaignEmailTemplate(emailIntroLine, {
          recipientName: recipient.name ?? "",
          recipientIstid: recipient.istid ?? "",
          recipientEmail: recipient.email,
          code: created.code,
          discountType: body.discount_type,
          discountValue: body.discount_value,
          expiresAt: body.expires_at ?? null,
          introLine: emailIntroLine,
        }),
      });

      if (sent) {
        sentCount += 1;
      } else {
        failedRecipients.push({
          istid: recipient.istid ?? "",
          error: "Código gerado, mas o email não foi enviado.",
        });
      }
    }

    return NextResponse.json(
      {
        codes: createdCodes,
        sent_count: sentCount,
        failed_count: failedRecipients.length,
        failed_recipients: failedRecipients,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("discounts POST error:", error);
    return NextResponse.json({ error: "Failed to generate discount codes" }, { status: 500 });
  }
});

export const PUT = withValidation(discountCodeUpdateSchema, async (request, body) => {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const discountCodeId = body.id ?? body.discount_code_id;
    if (!discountCodeId) {
      return NextResponse.json({ error: "Código de desconto inválido" }, { status: 400 });
    }

    const updates: DiscountCodeUpdateInput = {};
    if (body.code !== undefined) {
      updates.code = body.code;
    }
    if (body.discount_type !== undefined) {
      updates.discount_type = body.discount_type;
    }
    if (body.discount_value !== undefined) {
      updates.discount_value = body.discount_value;
    }
    if (body.valid_product_ids !== undefined) {
      updates.valid_product_ids = body.valid_product_ids;
    }
    if (body.valid_istids !== undefined) {
      updates.valid_istids = body.valid_istids;
    }
    if (body.max_uses !== undefined) {
      updates.max_uses = body.max_uses;
    }
    if (body.expires_at !== undefined) {
      updates.expires_at = body.expires_at;
    }
    if (body.active !== undefined) {
      updates.active = body.active;
    }

    const updated = await updateDiscountCode(discountCodeId, updates);
    if (!updated) {
      return NextResponse.json({ error: "Failed to update discount code" }, { status: 500 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("discounts PUT error:", error);
    return NextResponse.json({ error: "Failed to update discount code" }, { status: 500 });
  }
});

export async function DELETE(request: NextRequest) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const body = await request.json().catch(() => ({}));
    const discountCodeId = Number(body.id ?? body.discount_code_id);

    if (!Number.isInteger(discountCodeId) || discountCodeId <= 0) {
      return NextResponse.json({ error: "Código de desconto inválido" }, { status: 400 });
    }

    const deleted = await deleteDiscountCode(discountCodeId);
    if (!deleted) {
      return NextResponse.json({ error: "Failed to delete discount code" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("discounts DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete discount code" }, { status: 500 });
  }
}
