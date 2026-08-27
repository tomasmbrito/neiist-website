import { z } from "zod";

/**
 * A Portuguese mobile number, or an international one.
 *
 * Loose on purpose: the point is to catch a typo, not to police formatting. A candidate whose
 * number is rejected by a regex they cannot see simply does not apply.
 */
const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .refine((value) => /^\+?[0-9 ()-]{6,}$/.test(value), {
    message: "Número de telefone inválido.",
  });

export const submitApplicationSchema = z.object({
  fullName: z.string().trim().min(2, "Indica o teu nome.").max(200),
  istid: z
    .string()
    .trim()
    .min(3, "Indica o teu número de aluno.")
    .max(50)
    .refine((value) => /^ist\d+$/i.test(value), {
      message: 'O número de aluno começa por "ist" seguido de dígitos.',
    }),
  email: z.email("Email inválido.").max(200),
  phone: phoneSchema.optional(),
  course: z.string().trim().max(100).optional(),
  year: z.number().int().min(1).max(10).optional(),
  motivation: z.string().trim().max(5000).optional(),
  // At least one, and a sane ceiling: there are ten departments, so twenty choices is a bot.
  teams: z.array(z.string().trim().min(1).max(30)).min(1, "Escolhe pelo menos uma equipa.").max(20),
});

/**
 * One half of the two-signature approval (#217).
 *
 * `outcome` is gone on purpose. It used to be the thing the caller set; it is now derived from
 * the two signatures by trigger, so a schema that still accepted it would be offering a field
 * with nowhere to go. What a caller says now is only their own `accept` or `reject`.
 *
 * `side` is optional and is a hint for the one person who is both a team coordinator and on the
 * board. SQL verifies it against their real memberships — sending "board" does not make you it.
 */
export const decideApplicationSchema = z.object({
  applicationId: z.number().int().positive(),
  departmentName: z.string().trim().min(1).max(30),
  decision: z.enum(["accept", "reject"]),
  side: z.enum(["team", "board"]).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Taking your own signature back. There is no field for whose — it is always the caller's. */
export const withdrawApprovalSchema = z.object({
  applicationId: z.number().int().positive(),
  departmentName: z.string().trim().min(1).max(30),
});

/**
 * The onboarding form (#224). Reached by token, with no session — a candidate has no account.
 *
 * There is deliberately no field for the team, the application, or any role: all of those come
 * from the server's reading of the token. A form that could name them would be a form that could
 * name somebody else's.
 */
export const onboardingSchema = z.object({
  token: z.string().min(20).max(200),
  preferredName: z.string().trim().min(1, "Diz-nos como queres ser tratado(a)").max(80),
  phone: z.string().trim().max(20).optional(),
});

/** A coordinator rotating their team's WhatsApp invite (#225). Shape is re-checked in SQL. */
export const teamLinkSchema = z.object({
  departmentName: z.string().trim().min(1).max(30),
  whatsappUrl: z.string().trim().max(200).nullable(),
});

/** Marking somebody as actually added. Records only — it does not create the membership. */
export const markOnboardedSchema = z.object({
  applicationId: z.number().int().positive(),
  departmentName: z.string().trim().min(1).max(30),
});
