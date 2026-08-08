/**
 * Adapter resolution.
 *
 * The governing rule: a fake must never stand in for production without the
 * operator knowing. Every substitution requires an explicit signal, and a
 * boundary that can resolve to neither a live implementation nor an explicitly
 * requested fake raises a named error instead of degrading quietly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapters, demoFixturePath } from "../src/factory.js";
import { parseConfig } from "../src/config/load.js";
import { CredentialStore } from "../src/credentials/store.js";
import { RunmillError } from "../src/errors/runmill-error.js";

const CONFIG = parseConfig(`
version: 1
autonomy: pr-only
provider:
  implementation: codex
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo]
  claim_state: In Progress
github:
  repositories:
    - match: { team: ENG }
      repo: acme/platform
      base_branch: main
`);

/** A credential store that resolves nothing, regardless of the host. */
const NO_CREDENTIALS = new CredentialStore({
  linear: "RUNMILL_TEST_ABSENT_1",
  github: "RUNMILL_TEST_ABSENT_2",
  "runmill-policy": "RUNMILL_TEST_ABSENT_3",
}) as CredentialStore;

let dir: string;
const savedFixture = process.env["RUNMILL_FAKE_BACKLOG"];
const savedDemo = process.env["RUNMILL_DEMO"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runmill-factory-"));
  delete process.env["RUNMILL_FAKE_BACKLOG"];
  delete process.env["RUNMILL_DEMO"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedFixture === undefined) delete process.env["RUNMILL_FAKE_BACKLOG"];
  else process.env["RUNMILL_FAKE_BACKLOG"] = savedFixture;
  if (savedDemo === undefined) delete process.env["RUNMILL_DEMO"];
  else process.env["RUNMILL_DEMO"] = savedDemo;
});

describe("the demo fixture", () => {
  it("ships with the package, so RUNMILL_DEMO always has something to show", async () => {
    // Demo mode used to resolve to an EMPTY backlog, so the advertised
    // zero-credential quickstart printed "No eligible issue." — a
    // demonstration of nothing.
    const { existsSync } = await import("node:fs");
    expect(existsSync(demoFixturePath())).toBe(true);
  });

  it("seeds a non-empty backlog in demo mode", async () => {
    const { backlog, live } = await buildAdapters(CONFIG, {
      demo: true,
      need: ["backlog"],
      credentials: NO_CREDENTIALS,
    });
    const issues = await backlog.listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issues.length).toBeGreaterThan(0);
    // And it is honest about not being live.
    expect(live.backlog).toBe(false);
  });
});

describe("explicit fixtures", () => {
  it("reads issues from RUNMILL_FAKE_BACKLOG when it points at a real file", async () => {
    const fixture = join(dir, "issues.json");
    writeFileSync(
      fixture,
      JSON.stringify([
        {
          identifier: "FIX-1",
          title: "from the fixture",
          description: "",
          priority: 1,
          labels: [],
          state: "Todo",
          teamKey: "ENG",
          blockedBy: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    process.env["RUNMILL_FAKE_BACKLOG"] = fixture;

    const { backlog } = await buildAdapters(CONFIG, {
      need: ["backlog"],
      credentials: NO_CREDENTIALS,
    });
    const issues = await backlog.listCandidates({ team: "ENG", states: ["Todo"] });
    expect(issues[0]?.identifier).toBe("FIX-1");
  });

  it("names the bad fixture path instead of blaming a missing credential", async () => {
    // Setting the variable is an explicit statement of intent. Reporting "no
    // Linear credential" for a typo'd path answers a question the operator did
    // not ask and sends them to fix the wrong thing.
    const missing = join(dir, "absent.json");
    process.env["RUNMILL_FAKE_BACKLOG"] = missing;
    try {
      await buildAdapters(CONFIG, { need: ["backlog"], credentials: NO_CREDENTIALS });
      expect.unreachable("should reject a fixture path that does not exist");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      const e = err as RunmillError;
      expect(e.whatHappened).toContain(missing);
      expect(e.whatHappened).toContain("RUNMILL_FAKE_BACKLOG");
      expect(e.whatHappened).not.toMatch(/Linear credential/);
    }
  });
});

describe("failing closed", () => {
  it("refuses to resolve a backlog with no credential and no explicit fake", async () => {
    try {
      await buildAdapters(CONFIG, { need: ["backlog"], credentials: NO_CREDENTIALS });
      expect.unreachable("should refuse rather than substitute a fake");
    } catch (err) {
      expect(err).toBeInstanceOf(RunmillError);
      const e = err as RunmillError;
      expect(e.code).toBe("RM-AUTH-003");
      // The error must name both escape hatches.
      expect(e.whatHappened).toMatch(/LINEAR_API_KEY/);
      expect(e.whatHappened).toMatch(/RUNMILL_FAKE_BACKLOG/);
    }
  });

  it("rejects a backlog provider it has no adapter for", async () => {
    const unsupported = {
      ...CONFIG,
      backlog: { ...CONFIG.backlog, provider: "jira" as never },
    };
    await expect(
      buildAdapters(unsupported, { need: ["backlog"], credentials: NO_CREDENTIALS }),
    ).rejects.toBeInstanceOf(RunmillError);
  });
});

describe("scoping which boundaries resolve", () => {
  it("does not resolve a provider for a read-only command", async () => {
    // Resolving a provider costs a subprocess, and for one dialect a real
    // billable inference. `next` and `prepare` never use it.
    const { live } = await buildAdapters(CONFIG, {
      demo: true,
      need: ["backlog"],
      credentials: NO_CREDENTIALS,
    });
    expect(live.provider).toBe(false);
  });

  it("reports which boundaries are live rather than leaving it to be inferred", async () => {
    const { live } = await buildAdapters(CONFIG, {
      demo: true,
      credentials: NO_CREDENTIALS,
    });
    expect(live).toEqual({ backlog: false, provider: false, reviewProvider: false, forge: false });
  });

  it("returns all three boundaries by default", async () => {
    const adapters = await buildAdapters(CONFIG, { demo: true, credentials: NO_CREDENTIALS });
    expect(adapters.backlog).toBeDefined();
    expect(adapters.provider).toBeDefined();
    expect(adapters.forge).toBeDefined();
  });
});

describe("RUNMILL_DEMO as an explicit signal", () => {
  it("is honoured from the environment as well as the option", async () => {
    process.env["RUNMILL_DEMO"] = "1";
    const { live } = await buildAdapters(CONFIG, {
      need: ["backlog"],
      credentials: NO_CREDENTIALS,
    });
    expect(live.backlog).toBe(false);
  });

  it("is not inferred from any other value", async () => {
    // Only "1" counts. A truthy-looking value must not silently enable fakes.
    process.env["RUNMILL_DEMO"] = "true";
    await expect(
      buildAdapters(CONFIG, { need: ["backlog"], credentials: NO_CREDENTIALS }),
    ).rejects.toBeInstanceOf(RunmillError);
  });
});

describe("choosing a reviewer model", () => {
  // `review.provider` shipped in the config schema and was read nowhere, so
  // choosing a reviewer silently did nothing.
  it("inherits the implementer's adapter by default", async () => {
    const adapters = await buildAdapters(CONFIG, { demo: true, credentials: NO_CREDENTIALS });
    expect(adapters.reviewProvider).toBe(adapters.provider);
  });

  it("uses a separate adapter when a different reviewer is configured", async () => {
    // Independence is the point. A model reviewing its own work agrees with
    // itself for the same reasons it was wrong, and clearing context does not
    // change that.
    const cfg = { ...CONFIG, review: { ...CONFIG.review, provider: "claude" as const } };
    const adapters = await buildAdapters(cfg, { demo: true, credentials: NO_CREDENTIALS });
    expect(adapters.reviewProvider).not.toBe(adapters.provider);
    expect(adapters.live.reviewProvider).toBe(false);
  });

  it("reports reviewer liveness separately from the implementer", async () => {
    const adapters = await buildAdapters(CONFIG, { demo: true, credentials: NO_CREDENTIALS });
    expect(adapters.live).toHaveProperty("reviewProvider");
  });
});
