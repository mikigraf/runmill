import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LinearClient } from "@linear/sdk";
import { stringify as stringifyYaml } from "yaml";
import { CODEX_DIALECT, CLAUDE_DIALECT, CliProviderAdapter } from "../agent/cli-provider.js";
import { CredentialStore } from "../credentials/store.js";
import { run } from "../platform/process.js";
import { writeSchemaBeside } from "./schema-asset.js";
import { tryGit } from "../platform/git.js";
import { parseConfig, validateConfig } from "./load.js";

export interface DiscoveredSetup {
  readonly repository: string;
  readonly baseBranch: string;
  readonly repositories: readonly { repo: string; baseBranch: string }[];
  readonly providers: readonly {
    implementation: "codex" | "claude";
    installed: boolean;
    authenticated: boolean;
  }[];
  readonly linearTeams: readonly { key: string; name: string; states: readonly string[] }[];
  readonly linearCredential: boolean;
  readonly githubAuthenticated: boolean;
}

export interface ConfigAnswers {
  readonly autonomy: "observe" | "pr-only" | "guarded-merge" | "continuous";
  readonly implementer: "codex" | "claude";
  readonly implementerModel?: string | undefined;
  readonly reviewer: "inherit" | "codex" | "claude";
  readonly reviewerModel?: string | undefined;
  readonly team: string;
  readonly eligibleStates: readonly string[];
  readonly claimState: string;
  readonly deliveredState: string;
  readonly completedState: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly includeLabels: readonly string[];
  readonly excludeLabels: readonly string[];
  readonly mergeMethod: "squash" | "merge" | "rebase";
  readonly maxWallMinutes: number;
  readonly maxCostUsd?: number | undefined;
}

function parseGitHubRepository(raw: string): { repo: string; baseBranch: string } | undefined {
  try {
    const value = JSON.parse(raw) as {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string } | null;
    };
    if (value.nameWithOwner === undefined) return undefined;
    return { repo: value.nameWithOwner, baseBranch: value.defaultBranchRef?.name ?? "main" };
  } catch {
    return undefined;
  }
}

export async function discoverSetup(
  root: string,
  credentials = new CredentialStore(),
): Promise<DiscoveredSetup> {
  const remote = await tryGit(root, ["remote", "get-url", "origin"]);
  const localRepo = remote.ok
    ? (remote.stdout.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? "owner/repo")
    : "owner/repo";
  const head = await tryGit(root, ["symbolic-ref", "--short", "HEAD"]);
  const localBranch = head.ok ? head.stdout.trim() : "main";

  const githubToken = await credentials.get("github");
  const ghOptions = githubToken === undefined
    ? {}
    : { env: { ...process.env, GH_TOKEN: githubToken } };
  const ghAuth = await run("gh", ["auth", "status"], ghOptions);
  const ghCurrent = ghAuth.ok
    ? parseGitHubRepository(
        (await run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], ghOptions)).stdout,
      )
    : undefined;
  const ghReposResult = ghAuth.ok
    ? await run("gh", ["repo", "list", "--limit", "100", "--json", "nameWithOwner,defaultBranchRef"], ghOptions)
    : undefined;
  const listedRepositories = (() => {
    try {
      const rows = JSON.parse(ghReposResult?.stdout ?? "[]") as {
        nameWithOwner?: string;
        defaultBranchRef?: { name?: string } | null;
      }[];
      return rows
        .filter((row) => row.nameWithOwner !== undefined)
        .map((row) => ({
          repo: row.nameWithOwner as string,
          baseBranch: row.defaultBranchRef?.name ?? "main",
        }));
    } catch {
      return [];
    }
  })();
  const current = ghCurrent ?? { repo: localRepo, baseBranch: localBranch };
  const repositories = [
    current,
    ...listedRepositories.filter((row) => row.repo !== current.repo),
  ];

  const providers = await Promise.all(
    ([CODEX_DIALECT, CLAUDE_DIALECT] as const).map(async (dialect) => {
      const adapter = new CliProviderAdapter({ dialect });
      const installation = await adapter.detect();
      const auth = installation.installed
        ? await adapter.authStatus()
        : { authenticated: false };
      return {
        implementation: dialect.name as "codex" | "claude",
        installed: installation.installed,
        authenticated: auth.authenticated,
      };
    }),
  );

  const linearKey = await credentials.get("linear");
  const linearTeams: { key: string; name: string; states: string[] }[] = [];
  if (linearKey !== undefined) {
    try {
      const client = new LinearClient({ apiKey: linearKey });
      const teams = await client.teams({ first: 50 });
      for (const team of teams.nodes) {
        const states = await team.states({ first: 100 });
        linearTeams.push({
          key: team.key,
          name: team.name,
          states: states.nodes.map((state) => state.name),
        });
      }
    } catch {
      // Discovery is best-effort. Validation and doctor report bad credentials.
    }
  }

  return {
    repository: current.repo,
    baseBranch: current.baseBranch,
    repositories,
    providers,
    linearTeams,
    linearCredential: linearKey !== undefined,
    githubAuthenticated: ghAuth.ok,
  };
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function defaultAnswers(discovered: DiscoveredSetup): ConfigAnswers {
  const implementer =
    discovered.providers.find((provider) => provider.authenticated)?.implementation ??
    discovered.providers.find((provider) => provider.installed)?.implementation ??
    "codex";
  const team = discovered.linearTeams[0];
  const states = team?.states ?? [];
  const readyStates = ["Todo", "Ready"].filter((state) => states.includes(state));
  return {
    autonomy: "pr-only",
    implementer,
    reviewer: "inherit",
    team: team?.key ?? "ENG",
    eligibleStates: readyStates.length > 0 ? readyStates : states.slice(0, 2).length > 0 ? states.slice(0, 2) : ["Todo", "Ready"],
    claimState: states.find((state) => /progress|started/i.test(state)) ?? "In Progress",
    deliveredState: states.find((state) => /review/i.test(state)) ?? "In Review",
    completedState: states.find((state) => /done|complete/i.test(state)) ?? "Done",
    repository: discovered.repository,
    baseBranch: discovered.baseBranch,
    includeLabels: ["agent-ready"],
    excludeLabels: ["needs-design", "no-agent"],
    mergeMethod: "squash",
    maxWallMinutes: 240,
  };
}

export function renderCreatedConfig(answers: ConfigAnswers): string {
  const config = {
    version: 1,
    autonomy: answers.autonomy,
    providers: {
      max_turns: 80,
      timeout_minutes: 120,
      implementer: {
        implementation: answers.implementer,
        ...(answers.implementerModel === undefined ? {} : { model: answers.implementerModel }),
      },
      reviewer: {
        implementation: answers.reviewer,
        ...(answers.reviewerModel === undefined ? {} : { model: answers.reviewerModel }),
      },
    },
    backlog: {
      provider: "linear",
      team: answers.team,
      eligible_states: answers.eligibleStates,
      claim_state: answers.claimState,
      delivered_state: answers.deliveredState,
      completed_state: answers.completedState,
      include_labels: answers.includeLabels,
      exclude_labels: answers.excludeLabels,
      allow_unassigned: true,
    },
    github: {
      repositories: [
        { match: { team: answers.team }, repo: answers.repository, base_branch: answers.baseBranch },
      ],
      draft_pr: true,
      merge: { method: answers.mergeMethod, delete_branch: true },
    },
    workspace: { git_isolation: "clone", sandbox: "native", network: "proxy" },
    verification: {
      manifest: ".runmill/checks.yaml",
      fail_on_missing_check: true,
      fail_on_skipped_check: true,
    },
    review: {
      max_fix_iterations: 3,
      merge_blocking_severities: ["critical", "high"],
      require_all_findings_resolved: true,
    },
    risk: {
      default: "medium",
      manual_approval: {
        paths: [".github/**", "infra/**"],
        labels: ["security", "database", "breaking-change"],
      },
    },
    budgets: {
      ...(answers.maxCostUsd === undefined ? {} : { max_cost_usd_per_issue: answers.maxCostUsd }),
      max_wall_minutes_per_issue: answers.maxWallMinutes,
      daily_window: "local",
      cost_enforcement: "auto",
    },
  };
  return `# yaml-language-server: $schema=./runmill.schema.json\n${stringifyYaml(config, { lineWidth: 100 })}`;
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options: readonly string[],
  defaultIndex = 0,
): Promise<string> {
  output.write(`\n${label}\n`);
  options.forEach((option, index) => output.write(`  ${index + 1}. ${option}${index === defaultIndex ? " (default)" : ""}\n`));
  const raw = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
  const index = raw === "" ? defaultIndex : Number(raw) - 1;
  return options[index] ?? options[defaultIndex] ?? "";
}

async function configureProviderAuth(
  rl: ReturnType<typeof createInterface>,
  implementation: "codex" | "claude",
  discovered: DiscoveredSetup,
): Promise<void> {
  const status = discovered.providers.find((provider) => provider.implementation === implementation);
  if (status?.installed !== true) {
    output.write(`\n${implementation} is not installed. Install it before running runmill.\n`);
    return;
  }
  const methods = status.authenticated
    ? ["Use the current authenticated CLI session", "Sign in with a subscription", "Sign in with an API key"]
    : ["Sign in with a subscription", "Sign in with an API key", "Configure later"];
  const method = await choose(rl, `${implementation} authentication`, methods);
  if (method.startsWith("Use") || method === "Configure later") return;
  if (method.includes("subscription")) {
    const args = implementation === "codex" ? ["login"] : ["auth", "login"];
    spawnSync(implementation, args, { stdio: "inherit" });
    return;
  }
  const envName = implementation === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const key = process.env[envName] ?? (await rl.question(`${envName} (not written to YAML): `)).trim();
  if (key === "") return;
  if (implementation === "codex") {
    spawnSync("codex", ["login", "--with-api-key"], { input: key, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  } else {
    spawnSync("claude", [], {
      env: { ...process.env, ANTHROPIC_API_KEY: key },
      stdio: "inherit",
    });
  }
}

export async function createConfiguration(inputOptions: {
  root: string;
  path: string;
  force?: boolean | undefined;
  defaults?: boolean | undefined;
  credentials?: CredentialStore | undefined;
}): Promise<{ path: string; config: string; discovered: DiscoveredSetup }> {
  if (existsSync(inputOptions.path) && inputOptions.force !== true) {
    throw new Error(`${inputOptions.path} already exists; pass --force to overwrite it`);
  }
  const credentials = inputOptions.credentials ?? new CredentialStore();
  let discovered = await discoverSetup(inputOptions.root, credentials);
  let answers = defaultAnswers(discovered);

  if (inputOptions.defaults !== true) {
    const rl = createInterface({ input, output });
    try {
      output.write("runmill configuration\nDetected values are preselected; press Enter to accept a default.\n");
      if (!discovered.githubAuthenticated) {
        const token = (await rl.question("GitHub token (leave blank to use local git defaults): ")).trim();
        if (token !== "") {
          try {
            await credentials.set("github", token);
          } catch {
            process.env["GITHUB_TOKEN"] = token;
          }
          discovered = await discoverSetup(inputOptions.root, credentials);
          answers = defaultAnswers(discovered);
        }
      }
      if (!discovered.linearCredential) {
        const key = (await rl.question("Linear API key (leave blank to configure later): ")).trim();
        if (key !== "") {
          try {
            await credentials.set("linear", key);
          } catch {
            process.env["LINEAR_API_KEY"] = key;
          }
          discovered = await discoverSetup(inputOptions.root, credentials);
          answers = defaultAnswers(discovered);
        }
      }
      const providerOptions = discovered.providers.filter((provider) => provider.installed).map((provider) => provider.implementation);
      answers = {
        ...answers,
        autonomy: (await choose(rl, "Autonomy", ["pr-only", "observe", "guarded-merge", "continuous"])) as ConfigAnswers["autonomy"],
        implementer: (await choose(rl, "Implementer", providerOptions.length > 0 ? providerOptions : ["codex", "claude"])) as ConfigAnswers["implementer"],
      };
      await configureProviderAuth(rl, answers.implementer, discovered);
      const implementerModel = (await rl.question("Implementer model (blank uses CLI default): ")).trim();
      const reviewer = (await choose(rl, "Reviewer", ["inherit", "codex", "claude"])) as ConfigAnswers["reviewer"];
      const reviewerModel = (await rl.question("Reviewer model (blank inherits/defaults): ")).trim();
      const repoOptions = discovered.repositories.map((repo) => `${repo.repo} [${repo.baseBranch}]`);
      const selectedRepo = await choose(rl, "GitHub repository", repoOptions.length > 0 ? repoOptions : [`${answers.repository} [${answers.baseBranch}]`]);
      const selectedIndex = Math.max(0, repoOptions.indexOf(selectedRepo));
      const repository = discovered.repositories[selectedIndex] ?? { repo: answers.repository, baseBranch: answers.baseBranch };
      const teamOptions = discovered.linearTeams.map((team) => `${team.key} — ${team.name}`);
      const selectedTeam = teamOptions.length > 0 ? await choose(rl, "Linear team", teamOptions) : answers.team;
      const teamKey = selectedTeam.split(" ")[0] ?? answers.team;
      const linearTeam = discovered.linearTeams.find((team) => team.key === teamKey);
      const eligibleDefault = answers.eligibleStates.join(", ");
      const eligible = (await rl.question(`Eligible states [${eligibleDefault}]: `)).trim();
      const maxWall = (await rl.question(`Maximum minutes per issue [${answers.maxWallMinutes}]: `)).trim();
      const maxCost = (await rl.question("Maximum USD per issue (blank disables dollar cap): ")).trim();
      answers = {
        ...answers,
        implementerModel: implementerModel === "" ? undefined : implementerModel,
        reviewer,
        reviewerModel: reviewerModel === "" ? undefined : reviewerModel,
        repository: repository.repo,
        baseBranch: repository.baseBranch,
        team: teamKey,
        eligibleStates: eligible === "" ? answers.eligibleStates : csv(eligible),
        claimState: linearTeam?.states.find((state) => /progress|started/i.test(state)) ?? answers.claimState,
        deliveredState: linearTeam?.states.find((state) => /review/i.test(state)) ?? answers.deliveredState,
        completedState: linearTeam?.states.find((state) => /done|complete/i.test(state)) ?? answers.completedState,
        maxWallMinutes: maxWall === "" ? answers.maxWallMinutes : Number(maxWall),
        maxCostUsd: maxCost === "" ? undefined : Number(maxCost),
      };
    } finally {
      rl.close();
    }
  }

  const config = renderCreatedConfig(answers);
  const validation = validateConfig(parseConfig(config));
  if (!validation.valid) throw new Error(`generated configuration is invalid: ${validation.errors.join("; ")}`);
  mkdirSync(dirname(inputOptions.path), { recursive: true });
  writeFileSync(inputOptions.path, config);
  // The config's first line points an editor at ./runmill.schema.json, so the
  // schema has to land beside it or that header resolves to nothing.
  writeSchemaBeside(inputOptions.path);
  return { path: inputOptions.path, config, discovered };
}
