import { z } from "zod";

/**
 * Locations come from Notion's multi-select. Kept open rather than enumerated: the five values in
 * use today ("Online", "Alameda", "Tagus", "Externo", "V1.32 Edifício Civil") are a snapshot of
 * how the núcleo happens to work this year, not a domain rule, and hardcoding them would mean a
 * deploy to book a new room.
 */
const locationSchema = z.string().trim().min(1).max(120);

export const createEventSchema = z
  .object({
    kind: z.enum(["event", "meeting"]),
    name: z.string().trim().min(1, "O nome é obrigatório.").max(200),
    description: z.string().trim().max(5000).optional(),
    departmentName: z.string().trim().min(1, "Indique a equipa."),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    // Defaults to false, matching the column. A caller that omits it never publishes by accident.
    isPublic: z.boolean().default(false),
    locations: z.array(locationSchema).max(10).default([]),
    attendees: z.array(z.string().trim().min(1).max(50)).max(200).default([]),
  })
  .refine((value) => !value.endsAt || value.endsAt >= value.startsAt, {
    message: "A data de fim não pode ser anterior à de início.",
    path: ["endsAt"],
  });

export const deleteEventSchema = z.object({
  eventId: z.number().int().positive(),
});

/** Slice B: agenda, attendance, documents and relations on one event. */
export const eventNotesSchema = z.object({
  agenda: z.string().trim().max(20000).nullable().optional(),
  minutes: z.string().trim().max(20000).nullable().optional(),
});

export const attendanceSchema = z.object({
  istid: z.string().trim().min(1).max(50),
  response: z.enum(["invited", "accepted", "declined", "attended"]),
});

export const eventDocumentSchema = z.object({
  kind: z.enum(["plano", "relatorio", "ata", "other"]).default("other"),
  title: z.string().trim().min(1, "O título é obrigatório.").max(200),
  /**
   * http/https only, and refused in three places — here, in the CHECK constraint, and in
   * `add_event_document`. The value is rendered into an `href`, and a `javascript:` URL there is
   * stored XSS; `z.url()` alone would accept it.
   */
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "O endereço tem de começar por http:// ou https://.",
    }),
});

export const relateEventSchema = z.object({
  relatedEventId: z.number().int().positive(),
});

/** Tasks (#130). */
export const taskStatusSchema = z.enum(["not_started", "in_progress", "done"]);

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, "O título é obrigatório.").max(200),
  description: z.string().trim().max(5000).optional(),
  departmentName: z.string().trim().min(1, "Indique a equipa."),
  status: taskStatusSchema.default("not_started"),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Optional link to an event; the SQL refuses one belonging to another team. */
  eventId: z.number().int().positive().nullable().optional(),
  assignees: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
});

export const updateTaskSchema = z.object({
  taskId: z.number().int().positive(),
  status: taskStatusSchema,
});

export const taskAssigneeSchema = z.object({
  taskId: z.number().int().positive(),
  istid: z.string().trim().min(1).max(50),
  assign: z.boolean(),
});

export const deleteTaskSchema = z.object({
  taskId: z.number().int().positive(),
});

/** #219 — who may see an event, and which teams are helping. */
export const eventVisibilitySchema = z.object({
  visibility: z.enum(["public", "members", "teams", "owner"]),
});

export const eventCollaboratorSchema = z.object({
  departmentName: z.string().trim().min(1).max(30),
  add: z.boolean(),
});
