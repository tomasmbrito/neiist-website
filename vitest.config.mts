import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

/**
 * Vitest is scoped to Node-side code only — the data layer, `src/utils/**`, `src/lib/**`. There
 * is no jsdom environment and no React testing library here on purpose: the first tests exist to
 * cover transaction semantics and money-handling logic, which is where the bugs in this
 * repository have actually been (#78/#79/#80/#100). Component tests can be added later, with the
 * environment they need, rather than paid for now.
 */
export default defineConfig(({ mode }) => {
  // Vitest does not read .env by itself the way Next does. Loading it here (with no prefix
  // filter, so DATABASE_URL comes through) means `yarn test` uses the same local database the
  // dev server does, instead of needing a second copy of the connection settings.
  const env = loadEnv(mode, process.cwd(), "");
  process.env = { ...env, ...process.env };

  return {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      // These tests talk to a real database. Running files in parallel would have them fighting
      // over the same rows, and the point of the suite is transaction behaviour.
      fileParallelism: false,
      coverage: {
        provider: "v8",
        reportsDirectory: "coverage",
        include: ["src/utils/**", "src/lib/**"],
      },
    },
  };
});
