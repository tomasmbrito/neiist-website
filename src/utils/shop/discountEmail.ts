import type { DiscountType } from "@/types/shop/discountCode";

export interface DiscountEmailTemplateData {
  recipientName: string;
  recipientIstid: string;
  recipientEmail?: string;
  code: string;
  discountType: DiscountType;
  discountValue: number;
  expiresAt?: string | null;
  introLine: string;
}

export function formatDiscountValueLabel(
  discountType: DiscountType,
  discountValue: number
): string {
  if (discountType === "percentage") {
    return `${discountValue}%`;
  }

  return `€${discountValue.toFixed(2)}`;
}

export function formatDiscountExpiryLabel(expiresAt?: string | null): string {
  if (!expiresAt) return "sem limite";

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "sem limite";

  return date.toLocaleDateString("pt-PT");
}

export function interpolateDiscountEmailMarkdown(
  template: string,
  data: DiscountEmailTemplateData
): string {
  const discountLabel = formatDiscountValueLabel(data.discountType, data.discountValue);
  const expiryLabel = formatDiscountExpiryLabel(data.expiresAt);

  return template
    .replace(/\{\{\s*name\s*\}\}/gi, data.recipientName)
    .replace(/\{\{\s*istid\s*\}\}/gi, data.recipientIstid)
    .replace(/\{\{\s*email\s*\}\}/gi, data.recipientEmail ?? "")
    .replace(/\{\{\s*code\s*\}\}/gi, data.code)
    .replace(/\{\{\s*discount\s*\}\}/gi, discountLabel)
    .replace(/\{\{\s*discount_value\s*\}\}/gi, String(data.discountValue))
    .replace(/\{\{\s*expiry\s*\}\}/gi, expiryLabel);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function interpolateDiscountEmailHtml(
  template: string,
  data: DiscountEmailTemplateData
): string {
  const discountLabel = formatDiscountValueLabel(data.discountType, data.discountValue);
  const expiryLabel = formatDiscountExpiryLabel(data.expiresAt);

  return template
    .replace(/\{\{\s*name\s*\}\}/gi, escapeHtml(data.recipientName))
    .replace(/\{\{\s*istid\s*\}\}/gi, escapeHtml(data.recipientIstid))
    .replace(/\{\{\s*email\s*\}\}/gi, escapeHtml(data.recipientEmail ?? ""))
    .replace(/\{\{\s*code\s*\}\}/gi, escapeHtml(data.code))
    .replace(/\{\{\s*discount\s*\}\}/gi, escapeHtml(discountLabel))
    .replace(/\{\{\s*discount_value\s*\}\}/gi, escapeHtml(String(data.discountValue)))
    .replace(/\{\{\s*expiry\s*\}\}/gi, escapeHtml(expiryLabel))
    .replace(/\{\{\s*intro_line\s*\}\}/gi, escapeHtml(data.introLine));
}

export function getDefaultDiscountEmailIntroLine(): string {
  return "Foi gerado um código personalizado para ti, no valor de {{discount}}.";
}

export function getDefaultDiscountEmailHtmlTemplate(): string {
  return [
    "<div style=\"font-family: 'Secular One', Arial, sans-serif; background: #F2F2F7; padding: 2rem; border-radius: 1rem; color: #333;\">",
    '  <h2 style="color: #2863FD; margin-bottom: 1rem;">O teu código de desconto NEIIST</h2>',
    '  <p style="font-size: 1.05rem;">Olá {{name}},</p>',
    "  <p>{{intro_line}}</p>",
    '  <div style="padding: 1rem; border-radius: 0.9rem; background: #ffffff; border: 1px solid #e5e7eb; margin: 1rem 0 1.25rem;">',
    '    <p style="margin: 0 0 0.35rem; color: #6b7280; font-size: 0.9rem;">Código</p>',
    '    <p style="margin: 0; font-size: 1.4rem; font-weight: 700; letter-spacing: 0.08em; color: #111827;">{{code}}</p>',
    "  </div>",
    '  <p style="margin: 0.35rem 0;"><strong>ISTID:</strong> {{istid}}</p>',
    '  <p style="margin: 0.35rem 0;"><strong>Email:</strong> {{email}}</p>',
    '  <p style="margin: 0.35rem 0 1.25rem;"><strong>Expira:</strong> {{expiry}}</p>',
    '  <p style="margin-bottom: 0;">Se precisares de ajuda, responde a este email.</p>',
    "</div>",
  ].join("\n");
}

export function renderDiscountCampaignEmailHtml(
  introLine: string,
  data: DiscountEmailTemplateData
): string {
  const logoUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/neiist_logo.svg`;
  const discountLabel = formatDiscountValueLabel(data.discountType, data.discountValue);
  const expiryLabel = formatDiscountExpiryLabel(data.expiresAt);
  const parsedIntro = introLine.replace(/\{\{\s*discount\s*\}\}/gi, discountLabel).trim();
  const safeIntroLine =
    parsedIntro || `Foi gerado um código personalizado para ti, no valor de ${discountLabel}.`;

  return `
    <div style="font-family: 'Secular One', Arial, sans-serif; background: #F2F2F7; padding: 2rem; border-radius: 1rem; color: #333;">
      <img src="${logoUrl}" alt="NEIIST Logo" style="height: 48px; margin-bottom: 1rem;" />
      <h2 style="color: #2863FD; margin-bottom: 1rem;">O teu código de desconto NEIIST</h2>
      <p style="font-size: 1.05rem;">Olá ${escapeHtml(data.recipientName)}!</p>
      <p style="margin-bottom: 1.25rem;">${escapeHtml(safeIntroLine)}</p>
      <div style="padding: 1rem; border-radius: 0.9rem; background: #ffffff; border: 1px solid #e5e7eb; margin-bottom: 1.25rem;">
        <p style="margin: 0 0 0.35rem; color: #6b7280; font-size: 0.9rem;">Código</p>
        <p style="margin: 0; font-size: 1.4rem; font-weight: 700; letter-spacing: 0.08em; color: #111827;">${escapeHtml(data.code)}</p>
      </div>
      <p style="margin: 0.35rem 0;"><strong>ISTID:</strong> ${escapeHtml(data.recipientIstid)}</p>
      <p style="margin: 0.35rem 0;"><strong>Email:</strong> ${escapeHtml(data.recipientEmail ?? "")}</p>
      <p style="margin: 0.35rem 0 1.25rem;"><strong>Expira:</strong> ${escapeHtml(expiryLabel)}</p>
      <p style="margin-bottom: 0;">Se precisares de ajuda, responde a este email.</p>
    </div>
  `;
}
