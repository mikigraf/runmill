import type { BacklogAdapter } from "./backlog/adapter.js";
import type { CodingAgentAdapter } from "./agent/adapter.js";
import type { ForgeAdapter } from "./pr/adapter.js";
import type { RunmillConfig } from "./config/types.js";
import { LinearBacklogAdapter } from "./backlog/linear.js";
import { GitHubForgeAdapter } from "./pr/github.js";
import { CliProviderAdapter, CODEX_DIALECT, CLAUDE_DIALECT } from "./agent/cli-provider.js";
import { CredentialStore } from "./credentials/store.js";
import { FakeBacklogAdapter } from "./testing/fake-backlog.js";
import { FakeForgeAdapter } from "./testing/fake-forge.js";
import { FakeProviderAdapter } from "./testing/fake-provider.js";
import { RunmillError } from "./errors/runmill-error.js";
import { existsSync, readFileSync } from "node:fs";

export interface AdapterSet {
  readonly backlog: BacklogAdapter;
  readonly provider: CodingAgentAdapter;
  readonly forge: ForgeAdapter;
  /** Which of the three resolved to a live implementation. */
  readonly live: { backlog: boolean; provider: boolean; forge: boolean };
}

export interface BuildAdaptersOptions {
  readonly credentials?: CredentialStore | undefined;
  /** Force in-memory implementations for every boundary. */
  readonly demo?: boolean | undefined;
}

/**
 * Resolve the three external boundaries.
 *
 * Each resolves independently: a real Linear credential with no GitHub token
 * still gives a live backlog. Nothing silently degrades — a boundary that
 * cannot resolve to a live implementation and has no explicit in-memory
 * substitute raises a named error, because a fake standing in for production
 * without the operator knowing is exactly how a governance system becomes a
 * theatre of one.
 */
export async function buildAdapters(
  config: RunmillConfig,
  options: BuildAdaptersOptions = {},
): Promise<AdapterSet> {
  const credentials = options.credentials ?? new CredentialStore();
  const demo = options.demo === true || process.env["RUNMILL_DEMO"] === "1";

  // -- backlog -----------------------------------------------------------
  let backlog: BacklogAdapter;
  let backlogLive = false;
  const fixture = process.env["RUNMILL_FAKE_BACKLOG"];
  if (fixture !== undefined && existsSync(fixture)) {
    backlog = new FakeBacklogAdapter(JSON.parse(readFileSync(fixture, "utf8")));
  } else if (config.backlog.provider === "linear") {
    const apiKey = await credentials.get("linear");
    if (apiKey !== undefined) {
      backlog = new LinearBacklogAdapter({ apiKey });
      backlogLive = true;
    } else if (demo) {
      backlog = new FakeBacklogAdapter([]);
    } else {
      throw RunmillError.fromCatalog("RM-AUTH-003", {
        whatHappened:
          "No Linear credential.\n" +
          "  Set $LINEAR_API_KEY, or store one in the keychain, or\n" +
          "  set RUNMILL_FAKE_BACKLOG=<fixture.json> to explore without one.",
      });
    }
  } else {
    throw RunmillError.fromCatalog("RM-CONFIG-001", {
      whatHappened: `No adapter for backlog.provider "${config.backlog.provider}"`,
    });
  }

  // -- provider ----------------------------------------------------------
  let provider: CodingAgentAdapter;
  let providerLive = false;
  const dialect = config.provider.implementation === "claude" ? CLAUDE_DIALECT : CODEX_DIALECT;
  const cli = new CliProviderAdapter({ dialect });
  const installation = await cli.detect();

  if (installation.installed && !demo) {
    const auth = await cli.authStatus();
    if (!auth.authenticated) {
      throw RunmillError.fromCatalog("RM-AUTH-003", {
        whatHappened:
          `${dialect.binary} is installed but not authenticated.` +
          (auth.detail === undefined || auth.detail === "" ? "" : `\n  ${auth.detail}`),
      });
    }
    provider = cli;
    providerLive = true;
  } else if (demo) {
    provider = new FakeProviderAdapter();
  } else {
    throw RunmillError.fromCatalog("RM-AUTH-003", {
      whatHappened:
        `${dialect.binary} is not installed.\n` +
        `  Install it, or set RUNMILL_DEMO=1 to run with an in-memory provider.`,
    });
  }

  // -- forge -------------------------------------------------------------
  let forge: ForgeAdapter;
  let forgeLive = false;
  const token = await credentials.get("github");
  if (token !== undefined && !demo) {
    forge = new GitHubForgeAdapter({ token });
    forgeLive = true;
  } else if (demo) {
    forge = new FakeForgeAdapter();
  } else {
    throw RunmillError.fromCatalog("RM-AUTH-003", {
      whatHappened:
        "No GitHub credential.\n" +
        "  Run `gh auth login`, set $GITHUB_TOKEN, or set RUNMILL_DEMO=1.",
    });
  }

  return {
    backlog,
    provider,
    forge,
    live: { backlog: backlogLive, provider: providerLive, forge: forgeLive },
  };
}
