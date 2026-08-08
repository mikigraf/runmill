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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The issue fixture demo mode falls back to.
 *
 * Demo mode used to hand back an empty backlog, so the advertised
 * zero-credential quickstart printed "No eligible issue." — a demonstration of
 * nothing, indistinguishable from a real backlog with no work in it. A demo
 * with no data is not a demo. Shipped in `files` so this works from an
 * installed package, not just a clone.
 */
export function demoFixturePath(): string {
  // dist/factory.js and src/factory.ts are both one level below the root.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return join(root, "examples", "quickstart", "issues.json");
}

export interface AdapterSet {
  readonly backlog: BacklogAdapter;
  readonly provider: CodingAgentAdapter;
  /** Runs the review roles. The same adapter as `provider` unless configured otherwise. */
  readonly reviewProvider: CodingAgentAdapter;
  readonly forge: ForgeAdapter;
  /** Which boundary resolved to a live implementation. */
  readonly live: { backlog: boolean; provider: boolean; reviewProvider: boolean; forge: boolean };
}

export type Boundary = "backlog" | "provider" | "forge";

export interface BuildAdaptersOptions {
  readonly credentials?: CredentialStore | undefined;
  /** Force in-memory implementations for every boundary. */
  readonly demo?: boolean | undefined;
  /**
   * Which boundaries to resolve. Read-only commands need only the backlog,
   * and resolving a provider costs a subprocess — for one dialect, a real
   * billable inference — that `next` and `prepare` never use.
   */
  readonly need?: readonly Boundary[] | undefined;
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
  const need = options.need ?? (["backlog", "provider", "forge"] as const);
  const wants = (b: Boundary): boolean => need.includes(b);

  // -- backlog -----------------------------------------------------------
  let backlog: BacklogAdapter;
  let backlogLive = false;
  const fixture = process.env["RUNMILL_FAKE_BACKLOG"];
  if (fixture !== undefined && fixture !== "" && !existsSync(fixture)) {
    // Setting the variable is an explicit statement of intent. Falling through
    // to "no Linear credential" would answer a question the operator did not
    // ask and send them to fix the wrong thing.
    throw RunmillError.fromCatalog("RM-CONFIG-002", {
      whatHappened:
        `RUNMILL_FAKE_BACKLOG points at a file that does not exist:\n  ${fixture}`,
    });
  }
  if (fixture !== undefined && existsSync(fixture)) {
    backlog = new FakeBacklogAdapter(JSON.parse(readFileSync(fixture, "utf8")));
  } else if (config.backlog.provider === "linear") {
    const apiKey = await credentials.get("linear");
    if (apiKey !== undefined) {
      backlog = new LinearBacklogAdapter({ apiKey });
      backlogLive = true;
    } else if (demo) {
      // Prefer the caller's fixture; fall back to the bundled one so
      // RUNMILL_DEMO=1 always has something to demonstrate.
      const bundled = demoFixturePath();
      backlog = new FakeBacklogAdapter(
        existsSync(bundled) ? (JSON.parse(readFileSync(bundled, "utf8")) as never) : [],
      );
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
  const cli = new CliProviderAdapter({
    dialect,
    ...(config.provider.model === undefined ? {} : { model: config.provider.model }),
  });
  // Demo mode never uses the real provider, so probing for it is a subprocess
  // spawn (and for one dialect an auth check) whose result is discarded.
  const installation =
    wants("provider") && !demo ? await cli.detect() : { installed: false };

  if (!wants("provider")) {
    provider = new FakeProviderAdapter();
  } else if (installation.installed && !demo) {
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

  // -- reviewer ----------------------------------------------------------
  //
  // Two independent choices: which CLI, and which model. The same CLI running a
  // different model is a valid configuration and usually the cheapest useful
  // one, because it needs no second subscription and still gets a second
  // opinion that does not share the author's weights.
  //
  // Fresh context removes the implementer's narrative. A different model also
  // removes its blind spots, and a review that shares them agrees with the
  // author for the same reasons the author was wrong.
  let reviewProvider = provider;
  let reviewProviderLive = providerLive;

  const reviewImpl =
    config.review.provider === "inherit" ? config.provider.implementation : config.review.provider;
  const reviewModel = config.review.model ?? config.provider.model;
  const differs =
    reviewImpl !== config.provider.implementation || reviewModel !== config.provider.model;

  if (wants("provider") && differs) {
    if (demo) {
      reviewProvider = new FakeProviderAdapter();
      reviewProviderLive = false;
    } else {
      const reviewDialect = reviewImpl === "claude" ? CLAUDE_DIALECT : CODEX_DIALECT;
      const reviewCli = new CliProviderAdapter({
        dialect: reviewDialect,
        ...(reviewModel === undefined ? {} : { model: reviewModel }),
      });

      // Only re-probe when the CLI itself is different. Same binary, different
      // model needs no second detect or auth check, and skipping it keeps the
      // common case free.
      if (reviewImpl !== config.provider.implementation) {
        const found = await reviewCli.detect();
        if (!found.installed) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened:
              `review.provider is "${reviewImpl}" but ${reviewDialect.binary} is not installed.\n` +
              `  Install it, or set review.provider: inherit to review with ${dialect.binary}.`,
          });
        }
        const reviewAuth = await reviewCli.authStatus();
        if (!reviewAuth.authenticated) {
          throw RunmillError.fromCatalog("RM-AUTH-003", {
            whatHappened:
              `review.provider is "${reviewImpl}" but ${reviewDialect.binary} is not authenticated.` +
              (reviewAuth.detail === undefined || reviewAuth.detail === ""
                ? ""
                : `\n  ${reviewAuth.detail}`),
          });
        }
      }

      reviewProvider = reviewCli;
      reviewProviderLive = providerLive || reviewImpl !== config.provider.implementation;
    }
  }

  // -- forge -------------------------------------------------------------
  let forge: ForgeAdapter;
  let forgeLive = false;
  const token = wants("forge") ? await credentials.get("github") : undefined;
  if (!wants("forge")) {
    forge = new FakeForgeAdapter();
  } else if (token !== undefined && !demo) {
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
    reviewProvider,
    forge,
    live: {
      backlog: backlogLive,
      provider: providerLive,
      reviewProvider: reviewProviderLive,
      forge: forgeLive,
    },
  };
}
