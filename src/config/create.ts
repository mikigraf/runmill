import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LinearClient } from "@linear/sdk";
import { stringify as stringifyYaml } from "yaml";
import {
  CODEX_DIALECT,
  CLAUDE_DIALECT,
  CliProviderAdapter,
} from "../agent/cli-provider.js";
import { CredentialStore } from "../credentials/store.js";
import { run } from "../platform/process.js";
import { writeSchemaBeside } from "./schema-asset.js";
import { tryGit } from "../platform/git.js";
import { parseGitHubRepository as parseGitRemote } from "../workspace/repository-identity.js";
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
  readonly linearTeams: readonly {
    key: string;
    name: string;
    states: readonly string[];
    /** Linear workflow category keyed by exact state name. */
    stateTypes?: Readonly<Record<string, string>> | undefined;
  }[];
  readonly linearCredential: boolean;
  readonly githubAuthenticated: boolean;
}

type CredentialReader = Pick<CredentialStore, "get">;

interface ConfigurationPrompter {
  question(prompt: string): Promise<string>;
  close(): void;
}

interface InteractiveCommandResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

type InteractiveCommand = (
  command: string,
  args: readonly string[],
) => InteractiveCommandResult;

export interface ConfigAnswers {
  readonly autonomy: "observe" | "pr-only" | "guarded-merge" | "continuous";
  /** Set only after a separate, explicit acknowledgement in interactive setup. */
  readonly automaticMergeAcknowledged?: boolean | undefined;
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

function parseGhRepositoryJson(
  raw: string,
): { repo: string; baseBranch: string } | undefined {
  try {
    const value = JSON.parse(raw) as {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string } | null;
    };
    if (value.nameWithOwner === undefined) return undefined;
    return {
      repo: value.nameWithOwner,
      baseBranch: value.defaultBranchRef?.name ?? "main",
    };
  } catch {
    return undefined;
  }
}

export async function discoverSetup(
  root: string,
  credentials: CredentialReader = new CredentialStore(),
): Promise<DiscoveredSetup> {
  const remote = await tryGit(root, ["remote", "get-url", "origin"]);
  const localRepo = remote.ok
    ? (parseGitRemote(remote.stdout) ?? "owner/repo")
    : "owner/repo";
  const head = await tryGit(root, ["symbolic-ref", "--short", "HEAD"]);
  const localBranch = head.ok ? head.stdout.trim() : "main";

  const githubToken = await credentials.get("github");
  const ghOptions =
    githubToken === undefined
      ? {}
      : { env: { ...process.env, GH_TOKEN: githubToken } };
  const ghAuth = await run("gh", ["auth", "status"], ghOptions);
  const ghCurrent = ghAuth.ok
    ? parseGhRepositoryJson(
        (
          await run(
            "gh",
            ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
            ghOptions,
          )
        ).stdout,
      )
    : undefined;
  const current = ghCurrent ?? { repo: localRepo, baseBranch: localBranch };
  // This release manages one local checkout per daemon. Offering every repo
  // visible to `gh repo list` suggested cross-repository routing the runtime
  // cannot safely perform: it would clone this checkout and push that tree to
  // the selected target. The verified local origin is the only valid option.
  const repositories = [current];

  const providers = await Promise.all(
    ([CODEX_DIALECT, CLAUDE_DIALECT] as const).map(async (dialect) => {
      const adapter = new CliProviderAdapter({ dialect });
      const installation = await adapter.detect();
      const auth = installation.installed
        ? await adapter.sandboxAuthStatus()
        : { authenticated: false };
      return {
        implementation: dialect.name as "codex" | "claude",
        installed: installation.installed,
        authenticated: auth.authenticated,
      };
    }),
  );

  const linearKey = await credentials.get("linear");
  const linearTeams: {
    key: string;
    name: string;
    states: string[];
    stateTypes: Record<string, string>;
  }[] = [];
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
          stateTypes: Object.fromEntries(
            states.nodes.map((state) => [state.name, state.type]),
          ),
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
    // A configured token remains usable by the runtime even when `gh` is not
    // installed. `gh` enriches repository discovery; doctor proves the token
    // against the exact configured repository later.
    githubAuthenticated: githubToken !== undefined,
  };
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const LINEAR_PLACEHOLDERS = {
  team: "REPLACE_WITH_LINEAR_TEAM",
  eligible: "REPLACE_WITH_LINEAR_ELIGIBLE_STATE",
  claim: "REPLACE_WITH_LINEAR_CLAIM_STATE",
  delivered: "REPLACE_WITH_LINEAR_DELIVERED_STATE",
  completed: "REPLACE_WITH_LINEAR_COMPLETED_STATE",
} as const;

function workflowDefaults(
  team: DiscoveredSetup["linearTeams"][number] | undefined,
): Pick<
  ConfigAnswers,
  "team" | "eligibleStates" | "claimState" | "deliveredState" | "completedState"
> {
  if (team === undefined) {
    return {
      team: LINEAR_PLACEHOLDERS.team,
      eligibleStates: [LINEAR_PLACEHOLDERS.eligible],
      claimState: LINEAR_PLACEHOLDERS.claim,
      deliveredState: LINEAR_PLACEHOLDERS.delivered,
      completedState: LINEAR_PLACEHOLDERS.completed,
    };
  }

  // Use only names Linear actually returned. Types give us a safe fallback
  // when a team calls its states something other than Todo/In Progress/Done.
  const states = [...new Set(team.states.map((state) => state.trim()).filter(Boolean))];
  const typeOf = (state: string): string => team.stateTypes?.[state]?.toLowerCase() ?? "";
  const claim =
    states.find((state) => /progress|started|doing/i.test(state)) ??
    states.find((state) => typeOf(state) === "started") ??
    LINEAR_PLACEHOLDERS.claim;
  const delivered =
    states.find((state) => /review|delivered/i.test(state)) ??
    states.find((state) => typeOf(state) === "started" && state !== claim) ??
    (states.includes(claim) ? claim : LINEAR_PLACEHOLDERS.delivered);
  const completed =
    states.find((state) => /done|complete|merged/i.test(state)) ??
    states.find((state) => typeOf(state) === "completed") ??
    LINEAR_PLACEHOLDERS.completed;
  const lifecycle = new Set([claim, delivered, completed].map((state) => state.toLowerCase()));
  const queueStates = states.filter(
    (state) =>
      !lifecycle.has(state.toLowerCase()) &&
      (/todo|ready|backlog|triage/i.test(state) ||
        ["backlog", "unstarted", "triage"].includes(typeOf(state))),
  );
  const eligibleStates =
    queueStates.length > 0
      ? queueStates.slice(0, 2)
      : (states.find((state) => !lifecycle.has(state.toLowerCase())) === undefined
          ? [LINEAR_PLACEHOLDERS.eligible]
          : [states.find((state) => !lifecycle.has(state.toLowerCase())) as string]);

  return {
    team: team.key,
    eligibleStates,
    claimState: claim,
    deliveredState: delivered,
    completedState: completed,
  };
}

function defaultAnswers(discovered: DiscoveredSetup): ConfigAnswers {
  const implementer =
    discovered.providers.find((provider) => provider.authenticated)
      ?.implementation ??
    discovered.providers.find((provider) => provider.installed)
      ?.implementation ??
    "codex";
  const linear = workflowDefaults(discovered.linearTeams[0]);
  return {
    autonomy: "pr-only",
    implementer,
    reviewer: "inherit",
    ...linear,
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
    ...(answers.automaticMergeAcknowledged === true &&
    (answers.autonomy === "guarded-merge" || answers.autonomy === "continuous")
      ? { experimental: { automatic_merge: true } }
      : {}),
    providers: {
      max_turns: 80,
      timeout_minutes: 120,
      implementer: {
        implementation: answers.implementer,
        ...(answers.implementerModel === undefined
          ? {}
          : { model: answers.implementerModel }),
      },
      reviewer: {
        implementation: answers.reviewer,
        ...(answers.reviewerModel === undefined
          ? {}
          : { model: answers.reviewerModel }),
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
        {
          match: { team: answers.team },
          repo: answers.repository,
          base_branch: answers.baseBranch,
        },
      ],
      draft_pr: true,
      merge: { method: answers.mergeMethod },
    },
    workspace: { git_isolation: "clone", sandbox: "native", network: "proxy" },
    verification: {
      manifest: ".runmill/checks.yaml",
      fail_on_missing_check: true,
      // The starter manifest deliberately uses portable commands rather than
      // guessing a repository's reporter flags. In pr-only mode their passing
      // exit codes are retained honestly as `unproven`; enabling either merge
      // mode switches this proof gate back on and validation refuses a merge
      // policy that tries to turn it off.
      fail_on_skipped_check:
        answers.autonomy === "guarded-merge" ||
        answers.autonomy === "continuous",
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
      ...(answers.maxCostUsd === undefined
        ? {}
        : { max_cost_usd_per_issue: answers.maxCostUsd }),
      max_wall_minutes_per_issue: answers.maxWallMinutes,
      daily_window: "local",
      cost_enforcement: "auto",
    },
  };
  return `# yaml-language-server: $schema=./runmill.schema.json\n${stringifyYaml(config, { lineWidth: 100 })}`;
}

async function choose(
  rl: ConfigurationPrompter,
  write: (message: string) => void,
  label: string,
  options: readonly string[],
  defaultIndex = 0,
): Promise<string> {
  write(`\n${label}\n`);
  options.forEach((option, index) =>
    write(
      `  ${index + 1}. ${option}${index === defaultIndex ? " (default)" : ""}\n`,
    ),
  );
  const raw = (await rl.question(`Choose [${defaultIndex + 1}]: `)).trim();
  const index = raw === "" ? defaultIndex : Number(raw) - 1;
  return options[index] ?? options[defaultIndex] ?? "";
}

async function configureProviderAuth(
  rl: ConfigurationPrompter,
  write: (message: string) => void,
  runInteractive: InteractiveCommand,
  implementation: "codex" | "claude",
  discovered: DiscoveredSetup,
): Promise<void> {
  const status = discovered.providers.find(
    (provider) => provider.implementation === implementation,
  );
  if (status?.installed !== true) {
    write(
      `\n${implementation} is not installed. Install it before running runmill.\n`,
    );
    return;
  }
  const methods = status.authenticated
    ? [
        "Use the current authenticated CLI session",
        "Sign in with a subscription",
      ]
    : ["Sign in with a subscription", "Configure later"];
  const method = await choose(
    rl,
    write,
    `${implementation} authentication`,
    methods,
  );
  if (method.startsWith("Use") || method === "Configure later") return;
  const args = implementation === "codex" ? ["login"] : ["auth", "login"];
  const result = runInteractive(implementation, args);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${implementation} sign-in did not complete successfully` +
        (result.error === undefined ? "" : `: ${result.error.message}`),
    );
  }
}

export async function createConfiguration(inputOptions: {
  root: string;
  path: string;
  force?: boolean | undefined;
  defaults?: boolean | undefined;
  credentials?: CredentialReader | undefined;
  /** Test seams also let embedders provide their own terminal UI. */
  prompter?: ConfigurationPrompter | undefined;
  writeOutput?: ((message: string) => void) | undefined;
  runInteractive?: InteractiveCommand | undefined;
  discover?: typeof discoverSetup | undefined;
}): Promise<{ path: string; config: string; discovered: DiscoveredSetup }> {
  if (existsSync(inputOptions.path) && inputOptions.force !== true) {
    throw new Error(
      `${inputOptions.path} already exists; pass --force to overwrite it`,
    );
  }
  const credentials = inputOptions.credentials ?? new CredentialStore();
  const discover = inputOptions.discover ?? discoverSetup;
  let discovered = await discover(inputOptions.root, credentials);
  let answers = defaultAnswers(discovered);

  if (inputOptions.defaults !== true) {
    const rl = inputOptions.prompter ?? createInterface({ input, output });
    const write =
      inputOptions.writeOutput ?? ((message: string) => output.write(message));
    const runInteractive =
      inputOptions.runInteractive ??
      ((command, args) => {
        const result = spawnSync(command, [...args], { stdio: "inherit" });
        return {
          status: result.status,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      });
    try {
      write(
        "runmill configuration\nDetected values are preselected; press Enter to accept a default.\n",
      );
      if (!discovered.githubAuthenticated) {
        write(
          "\nNo GitHub credential was found. This wizard never asks for tokens because terminal " +
            "questions echo their answers. Use `gh auth login`, or export GITHUB_TOKEN before " +
            "rerunning setup. On macOS, you can store that environment value with `printenv " +
            "GITHUB_TOKEN | runmill auth login github`.\n",
        );
        const method = await choose(rl, write, "GitHub access", [
          "Continue with local repository values and configure GitHub later",
          "Run gh auth login now",
        ]);
        if (method.startsWith("Run")) {
          const result = runInteractive("gh", ["auth", "login"]);
          if (result.error !== undefined || result.status !== 0) {
            throw new Error(
              "gh auth login did not complete successfully" +
                (result.error === undefined ? "" : `: ${result.error.message}`),
            );
          }
          discovered = await discover(inputOptions.root, credentials);
          if (!discovered.githubAuthenticated) {
            throw new Error(
              "gh auth login completed, but no GitHub credential resolved; run `gh auth status` " +
                "and rerun init",
            );
          }
          answers = defaultAnswers(discovered);
        }
      }
      if (!discovered.linearCredential) {
        write(
          "\nNo Linear credential was found, so workflow defaults will be used. This wizard " +
            "never asks for API keys. Export LINEAR_API_KEY before rerunning setup. On macOS, " +
            "store an existing environment value with `printenv LINEAR_API_KEY | runmill auth " +
            "login linear`.\n",
        );
      }
      const providerOptions = discovered.providers
        .filter((provider) => provider.installed)
        .map((provider) => provider.implementation);
      const selectedAutonomy = (await choose(rl, write, "Autonomy", [
        "pr-only",
        "observe",
        "guarded-merge",
        "continuous",
      ])) as ConfigAnswers["autonomy"];
      let autonomy = selectedAutonomy;
      let automaticMergeAcknowledged = false;
      if (
        selectedAutonomy === "guarded-merge" ||
        selectedAutonomy === "continuous"
      ) {
        const acknowledgement = await choose(
          rl,
          write,
          `${selectedAutonomy} is experimental and can merge code automatically`,
          ["Keep pr-only", `Enable experimental ${selectedAutonomy}`],
        );
        if (acknowledgement.startsWith("Enable"))
          automaticMergeAcknowledged = true;
        else autonomy = "pr-only";
      }
      answers = {
        ...answers,
        autonomy,
        automaticMergeAcknowledged,
        implementer: (await choose(
          rl,
          write,
          "Implementer",
          providerOptions.length > 0 ? providerOptions : ["codex", "claude"],
        )) as ConfigAnswers["implementer"],
      };
      await configureProviderAuth(
        rl,
        write,
        runInteractive,
        answers.implementer,
        discovered,
      );
      discovered = await discover(inputOptions.root, credentials);
      const implementerModel = (
        await rl.question("Implementer model (blank uses CLI default): ")
      ).trim();
      const reviewerOptions = [
        "inherit",
        ...discovered.providers
          .filter((provider) => provider.installed)
          .map((provider) => provider.implementation),
      ];
      const reviewer = (await choose(rl, write, "Reviewer", [
        ...new Set(reviewerOptions),
      ])) as ConfigAnswers["reviewer"];
      if (reviewer !== "inherit") {
        await configureProviderAuth(
          rl,
          write,
          runInteractive,
          reviewer,
          discovered,
        );
        discovered = await discover(inputOptions.root, credentials);
      }
      const reviewerModel = (
        await rl.question("Reviewer model (blank inherits/defaults): ")
      ).trim();
      const repoOptions = discovered.repositories.map(
        (repo) => `${repo.repo} [${repo.baseBranch}]`,
      );
      const selectedRepo = await choose(
        rl,
        write,
        "GitHub repository",
        repoOptions.length > 0
          ? repoOptions
          : [`${answers.repository} [${answers.baseBranch}]`],
      );
      const selectedIndex = Math.max(0, repoOptions.indexOf(selectedRepo));
      const repository = discovered.repositories[selectedIndex] ?? {
        repo: answers.repository,
        baseBranch: answers.baseBranch,
      };
      const teamOptions = discovered.linearTeams.map(
        (team) => `${team.key} — ${team.name}`,
      );
      const selectedTeam =
        teamOptions.length > 0
          ? await choose(rl, write, "Linear team", teamOptions)
          : answers.team;
      const teamKey = selectedTeam.split(" ")[0] ?? answers.team;
      const linearTeam = discovered.linearTeams.find(
        (team) => team.key === teamKey,
      );
      const selectedWorkflow = workflowDefaults(linearTeam);
      const eligibleDefault = selectedWorkflow.eligibleStates.join(", ");
      const eligible = (
        await rl.question(`Eligible states [${eligibleDefault}]: `)
      ).trim();
      const maxWall = (
        await rl.question(
          `Maximum minutes per issue [${answers.maxWallMinutes}]: `,
        )
      ).trim();
      const maxCost = (
        await rl.question("Maximum USD per issue (blank disables dollar cap): ")
      ).trim();
      answers = {
        ...answers,
        implementerModel:
          implementerModel === "" ? undefined : implementerModel,
        reviewer,
        reviewerModel: reviewerModel === "" ? undefined : reviewerModel,
        repository: repository.repo,
        baseBranch: repository.baseBranch,
        team: teamKey,
        eligibleStates:
          eligible === "" ? selectedWorkflow.eligibleStates : csv(eligible),
        claimState: selectedWorkflow.claimState,
        deliveredState: selectedWorkflow.deliveredState,
        completedState: selectedWorkflow.completedState,
        maxWallMinutes:
          maxWall === "" ? answers.maxWallMinutes : Number(maxWall),
        maxCostUsd: maxCost === "" ? undefined : Number(maxCost),
      };
    } finally {
      rl.close();
    }
  }

  const config = renderCreatedConfig(answers);
  const validation = validateConfig(parseConfig(config));
  if (!validation.valid)
    throw new Error(
      `generated configuration is invalid: ${validation.errors.join("; ")}`,
    );
  mkdirSync(dirname(inputOptions.path), { recursive: true });
  writeFileSync(inputOptions.path, config);
  // The config's first line points an editor at ./runmill.schema.json, so the
  // schema has to land beside it or that header resolves to nothing.
  writeSchemaBeside(inputOptions.path);
  return { path: inputOptions.path, config, discovered };
}
