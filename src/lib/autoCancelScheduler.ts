import cron from "node-cron";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { autoCancelPendingOrders } from "@/utils/shop/autoCancelUtils";

// Global guard to only schedule once per process.
declare global {
  var __neiistAutoCancelScheduled: boolean | undefined;
}

async function runAutoCancel() {
  try {
    await autoCancelPendingOrders();
  } catch (error) {
    console.error("[auto-cancel] failed", error);
  }
}

function setupAutoCancel() {
  if (globalThis.__neiistAutoCancelScheduled) return;

  globalThis.__neiistAutoCancelScheduled = true;

  void runAutoCancel();
  cron.schedule(
    "0 * * * *",
    async () => {
      await runAutoCancel();
    },
    { timezone: "Europe/Lisbon" }
  );

  console.warn("[auto-cancel] scheduled every hour");
}

// `next build` evaluates the root layout (and therefore this module) in every page-data
// collection worker. Scheduling there would run the auto-cancel job — a write — against the
// deploy host's database at build time, and requires the database to be reachable to build.
if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
  setupAutoCancel();
}

export {};
