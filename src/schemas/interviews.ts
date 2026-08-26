import { z } from "zod";

/** Publishing availability (#218). Coordinator-side; the workspace guard decides who may. */
export const addSlotSchema = z.object({
  departmentName: z.string().trim().min(1).max(30),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  location: z.string().trim().max(120).optional(),
});

export const removeSlotSchema = z.object({ slotId: z.number().int().positive() });

/** Inviting a candidate to book. The token is generated server-side and never accepted here. */
export const inviteSchema = z.object({
  applicationId: z.number().int().positive(),
  departmentName: z.string().trim().min(1).max(30),
});

/**
 * A candidate booking or cancelling.
 *
 * The token is the whole authorization: a candidate has no account. It is never used to look up a
 * *department* the caller names — the invite says which team, so a token for Visuais cannot be
 * pointed at Fotografia by adding a field.
 */
export const bookSchema = z.object({
  token: z.string().min(20).max(200),
  slotId: z.number().int().positive(),
});

export const cancelBookingSchema = z.object({
  token: z.string().min(20).max(200),
  slotId: z.number().int().positive(),
});
