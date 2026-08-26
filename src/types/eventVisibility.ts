/**
 * Who can see an event (#219). **Client-safe: this file must never import the data layer.**
 *
 * It lives in `src/types/` rather than next to the queries for a measured reason. These constants
 * are needed by `TeamEvents.tsx`, which is a `"use client"` component, and they used to be
 * exported from `src/utils/db/eventQueries.ts`. Importing a *value* from that module — as opposed
 * to a `type`, which is erased — pulls the whole module into the browser bundle, and with it
 * `db_query`, `pg`, and `pg`'s `dns` and `fs` requires. `yarn build` failed with seven
 * "Module not found: Can't resolve 'dns'" errors and the only clue was one filename.
 *
 * So the rule this file exists to enforce: **a client component may import types from the data
 * layer, never values.** If a constant is needed on both sides, it belongs here.
 *
 * Four levels, replacing the `is_public` boolean. The one that did not exist before is
 * **`members`** — "every member should see the Jantar de Curso, but it is not for the public" —
 * and several of NEIIST's real events are exactly that.
 *
 * Ordered widest to narrowest. Compare with `visibilityRank`, never by array index or enum
 * ordinal: `user_access_enum` taught this repository what happens when ordering is implied rather
 * than stated.
 */
export const EVENT_VISIBILITY = ["public", "members", "teams", "owner"] as const;
export type EventVisibility = (typeof EVENT_VISIBILITY)[number];

export const VISIBILITY_LABELS: Record<EventVisibility, string> = {
  public: "Público — toda a gente, incluindo não-membros",
  members: "Membros — qualquer membro do NEIIST",
  teams: "Equipas — a equipa responsável e as que colaboram",
  owner: "Só a equipa responsável",
};

/** 0 is widest. Stated rather than derived from the array, so reordering cannot change meaning. */
export const visibilityRank = (visibility: EventVisibility): number =>
  ({ public: 0, members: 1, teams: 2, owner: 3 })[visibility];
