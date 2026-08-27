import { z } from "zod";

/**
 * Requerimentos, slice A (#232).
 *
 * Note what is NOT here: the caller's team. Every route takes it from the session and passes it to
 * SQL, which decides. A schema field for it would be a field a caller could set.
 */
export const raiseRequirementsSchema = z.object({
  eventId: z.number().int().positive(),
  requests: z
    .array(
      z.object({
        targetDepartment: z.string().trim().min(1).max(30),
        title: z.string().trim().min(1, "Cada pedido precisa de um título").max(200),
        detail: z.string().trim().max(4000).optional(),
        deadline: z.string().datetime().optional(),
      })
    )
    .min(1, "Escolhe pelo menos uma equipa")
    // The whole batch is one decision and lands atomically; a cap keeps one request from being a
    // way to write unbounded rows.
    .max(10, "No máximo 10 equipas de cada vez"),
});

export const requirementStatusSchema = z.object({
  requirementId: z.number().int().positive(),
  status: z.enum(["requested", "accepted", "in_progress", "done", "cancelled"]),
});

export const requirementAssignSchema = z.object({
  requirementId: z.number().int().positive(),
  /** `null` unassigns. SQL refuses anyone not on the target team. */
  assigneeIstid: z.string().trim().max(50).nullable(),
});

export const requirementDeliverableSchema = z.object({
  requirementId: z.number().int().positive(),
  url: z.string().trim().url("O link tem de ser um URL").max(500),
  label: z.string().trim().max(120).optional(),
});
