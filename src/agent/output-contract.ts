import { join } from "node:path";
import type { AgentRole } from "../domain/types.js";

/**
 * Which roles produce structured output, and where it lands.
 *
 * One table, read by every provider adapter to resolve the path and by the
 * orchestrator to know whether output is owed at all. Spreading this
 * across three files is what let the fake and the real adapter disagree about
 * when `outputRef` is present — tests passed while the real reviewer path
 * could never produce output at all.
 */
export interface OutputContract {
  readonly schema: string;
  readonly fileName: string;
}

export const OUTPUT_CONTRACTS: Partial<Record<AgentRole, OutputContract>> = {
  "local-reviewer": { schema: "review-findings@1", fileName: "local-reviewer-output.json" },
  "pr-reviewer": { schema: "review-findings@1", fileName: "pr-reviewer-output.json" },
};

export function outputContractFor(role: AgentRole): OutputContract | undefined {
  return OUTPUT_CONTRACTS[role];
}

/** Absolute path a role's structured output must be written to, if any. */
export function outputPathFor(workingDirectory: string, role: AgentRole): string | undefined {
  const contract = outputContractFor(role);
  return contract === undefined
    ? undefined
    : join(workingDirectory, ".runmill", "run", contract.fileName);
}
