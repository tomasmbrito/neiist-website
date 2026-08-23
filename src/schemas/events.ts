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
