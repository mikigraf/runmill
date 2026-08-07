import { StateStore } from "./store.js";
import { join } from "node:path";

/**
 * Local-only onboarding funnel.
 *
 * Time To Hello World is the number this product is judged on, and it was
 * previously unmeasurable: the table existed with zero writers. Recorded here,
 * in the user's own database, and sent nowhere. `runmill doctor --report`
 * surfaces it if the user chooses to share it.
 */
export type FunnelMilestone =
  | "installed_at"
  | "init_completed_at"
  | "first_doctor_run_at"
  | "first_doctor_pass_at"
  | "first_run_started_at"
  | "first_pr_opened_at";

export interface FunnelSnapshot {
  readonly milestones: Readonly<Record<string, string>>;
  readonly doctorFailures: Readonly<Record<string, number>>;
  /** Seconds from first invocation to first pull request, once both exist. */
  readonly tthwSeconds?: number | undefined;
}

/** Record a milestone the first time it happens. Never overwrites. */
export function recordMilestone(dataDir: string, key: FunnelMilestone, at: Date): void {
  try {
    const store = StateStore.open(join(dataDir, "runmill.db"));
    try {
      store.recordFunnelOnce(key, at.toISOString());
    } finally {
      store.close();
    }
  } catch {
    // Instrumentation must never be the reason a command fails.
  }
}

export function recordDoctorFailure(dataDir: string, code: string): void {
  try {
    const store = StateStore.open(join(dataDir, "runmill.db"));
    try {
      store.incrementFunnelCounter(`doctor_fail:${code}`);
    } finally {
      store.close();
    }
  } catch {
    // As above.
  }
}

export function readFunnel(dataDir: string): FunnelSnapshot {
  try {
    const store = StateStore.open(join(dataDir, "runmill.db"));
    try {
      const all = store.readFunnel();
      const milestones: Record<string, string> = {};
      const doctorFailures: Record<string, number> = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith("doctor_fail:")) {
          doctorFailures[key.slice("doctor_fail:".length)] = Number(value);
        } else {
          milestones[key] = value;
        }
      }
      const start = milestones["installed_at"];
      const end = milestones["first_pr_opened_at"];
      const tthwSeconds =
        start !== undefined && end !== undefined
          ? Math.round((Date.parse(end) - Date.parse(start)) / 1000)
          : undefined;
      return { milestones, doctorFailures, tthwSeconds };
    } finally {
      store.close();
    }
  } catch {
    return { milestones: {}, doctorFailures: {} };
  }
}
