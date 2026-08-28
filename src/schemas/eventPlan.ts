import { z } from "zod";

/**
 * Plano de Atividades (#247).
 *
 * No `team` field anywhere, as everywhere else in the workspace: the caller's team comes from the
 * session and SQL decides whether it owns the event. A schema field for it would be a field a
 * caller could set (#180).
 *
 * No `local`, `data` or `hora` either — those are the event's, and the plan derives them. A field
 * here would invite the copy that goes stale.
 */
export const eventPlanSchema = z.object({
  eventId: z.number().int().positive(),
  objetivo: z.string().trim().max(8000).nullable(),
  estrutura: z.string().trim().max(8000).nullable(),
  coordinatorIstid: z.string().trim().max(50).nullable(),
});

export const planCollaboratorSchema = z.object({
  eventId: z.number().int().positive(),
  istid: z.string().trim().min(1).max(50),
  add: z.boolean(),
});

export const planExternalSchema = z.object({
  eventId: z.number().int().positive(),
  kind: z.enum(["orador", "patrocinio", "parceiro", "outro"]),
  name: z.string().trim().min(1, "Indica um nome").max(200),
  detail: z.string().trim().max(1000).optional(),
});

export const planTodoSchema = z.object({
  eventId: z.number().int().positive(),
  task: z.string().trim().min(1, "Escreve o que é preciso fazer").max(300),
  assigneeIstid: z.string().trim().max(50).nullable(),
});

export const planTodoToggleSchema = z.object({
  todoId: z.number().int().positive(),
  done: z.boolean(),
});

/** Turning a to-do into the requerimento it describes. */
export const raiseFromTodoSchema = z.object({
  todoId: z.number().int().positive(),
  targetDepartment: z.string().trim().min(1).max(30),
  title: z.string().trim().min(1, "Dá um título ao requerimento").max(200),
  detail: z.string().trim().max(4000).optional(),
  deadline: z.string().datetime().optional(),
});
