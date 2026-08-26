import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `"use client"` component may import TYPES from the data layer, never VALUES.
 *
 * This exists because #219 broke `yarn build` and the failure was almost unreadable. `TeamEvents`
 * imported `EVENT_VISIBILITY` and `VISIBILITY_LABELS` — plain constants — from
 * `src/utils/db/eventQueries.ts`. A value import pulls the whole module into the browser bundle,
 * and that module imports `db_query`, which imports `pg`, which requires `dns` and `fs`. The build
 * failed with seven "Module not found: Can't resolve 'dns'" errors in `node_modules/pg`, and the
 * only pointer to the actual cause was a single filename in an unrelated list.
 *
 * `type` imports are erased, so they are fine and common. The distinction is invisible when
 * reading a merged import statement, which is exactly why it needs a test rather than a rule.
 *
 * A constant needed on both sides belongs in `src/types/`, like `eventVisibility.ts`.
 */
const CLIENT_DIRS = ["src/components", "src/app", "src/context"];
const SERVER_ONLY = /@\/utils\/db\//;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) yield full;
  }
}

/**
 * Import statements that bring in at least one binding which is NOT `type`-qualified.
 *
 * Handles both forms: `import type { X } from` (whole statement erased) and
 * `import { type X, Y } from` (Y is a value, so the module is bundled).
 */
function valueImportsFrom(source: string, matcher: RegExp): string[] {
  const offenders: string[] = [];
  const importRe = /import\s+(type\s+)?({[^}]*}|[\w*\s,]+?)\s+from\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(importRe)) {
    const [, typeOnly, clause, specifier] = match;
    if (!matcher.test(specifier)) continue;
    if (typeOnly) continue; // `import type { ... }` — erased entirely

    if (clause.startsWith("{")) {
      const bindings = clause
        .slice(1, -1)
        .split(",")
        .map((binding) => binding.trim())
        .filter(Boolean);
      // Every binding individually `type`-qualified is still fully erased.
      if (bindings.every((binding) => binding.startsWith("type "))) continue;
    }
    offenders.push(specifier);
  }
  return offenders;
}

describe("client components must not pull the data layer into the browser bundle", () => {
  it("finds no value import of src/utils/db/* from a 'use client' file", async () => {
    const offenders: string[] = [];

    for (const dir of CLIENT_DIRS) {
      for await (const file of walk(dir)) {
        const source = await readFile(file, "utf8");
        // Only the first few lines can carry the directive.
        if (!/^\s*["']use client["']/m.test(source.slice(0, 200))) continue;

        for (const specifier of valueImportsFrom(source, SERVER_ONLY)) {
          offenders.push(`${file} imports values from ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("recognises the shapes it needs to tell apart", () => {
    // Guarding the guard: a matcher that silently matched nothing would pass forever.
    const bundled = `import { EVENT_VISIBILITY } from "@/utils/db/eventQueries";`;
    const mixed = `import { type EventVisibility, EVENT_VISIBILITY } from "@/utils/db/eventQueries";`;
    const erased = `import type { InternalEvent } from "@/utils/db/eventQueries";`;
    const allTypes = `import { type A, type B } from "@/utils/db/eventQueries";`;

    expect(valueImportsFrom(bundled, SERVER_ONLY)).toHaveLength(1);
    expect(valueImportsFrom(mixed, SERVER_ONLY)).toHaveLength(1);
    expect(valueImportsFrom(erased, SERVER_ONLY)).toHaveLength(0);
    expect(valueImportsFrom(allTypes, SERVER_ONLY)).toHaveLength(0);
  });
});
