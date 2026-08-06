<!-- /autoplan restore point: /Users/miki/.gstack/projects/runmill/main-autoplan-restore-20260806-202816.md -->
# runmill: Product Requirements Document for a Linear-Driven Coding Agent Harness

| Field | Definition |
|---|---|
| Product | runmill |
| Document status | Refined PRD |
| Version | Draft v0.9 |
| Date | August 6, 2026 |
| Primary user | Technical founder, staff engineer, or small engineering team operating Codex or Claude Code |
| Initial surface | Local-first TypeScript CLI and background daemon |
| Core integrations | Linear, GitHub, Git, Codex, Claude Code |
| Product category | Coding-agent control plane and workflow harness |
| Default operating mode | One issue at a time, isolated worktree, governed pull request, fail-closed merge |
| Product thesis | Human attention—not model output—is the scarce resource; runmill should automate routine engineering work while preserving deterministic control over scope, verification, credentials, and merge authority |

## Product definition

### Executive summary

runmill is a deterministic control plane that continuously converts eligible Linear issues into reviewed and governed GitHub pull requests by dispatching work to either Codex or Claude Code.

The user authenticates once from the CLI, chooses a coding-agent provider, maps Linear teams or projects to GitHub repositories, defines verification and merge policies, and starts the worker. runmill then:

1. Selects the highest-priority eligible Linear issue.
2. Claims it using an auditable lease.
3. Creates an isolated Git worktree or sandbox.
4. Constructs a bounded task packet from the issue and repository.
5. Dispatches implementation to Codex or Claude Code.
6. Runs deterministic checks.
7. Invokes an independent review skill in a fresh context.
8. Dispatches fixes and repeats verification within defined limits.
9. Opens a pull request.
10. Reviews the resulting PR against the issue, diff, and repository policies.
11. Waits for required CI and branch protections.
12. Merges through GitHub’s normal protected path when authorized.
13. Updates Linear and begins the next eligible issue.

runmill is **not another coding model** and should not attempt to reproduce the internal planning or editing abilities of Codex or Claude Code. It is the workflow, state, policy, observability, and verification layer around those agents.

That distinction follows the emerging harness literature: code-based harnesses convert otherwise transient model behavior into executable, inspectable, stateful, and verifiable processes. The harness controls what enters context, which actions are available, how state persists, how outputs are checked, and how failures are recovered. citeturn11view3turn12view3

### Problem statement

Current coding agents are effective interactive workers, but their default operating model leaves several production concerns to the user:

| Gap | Consequence |
|---|---|
| No deterministic issue scheduler | The user manually chooses and restates work. |
| No reliable claim or lease | Multiple workers may duplicate the same issue. |
| Provider-specific execution interfaces | Automation becomes tied to one CLI and breaks as it evolves. |
| Context assembled ad hoc | The agent may receive too much, too little, or stale information. |
| Self-review occurs in the same context | The reviewer can inherit the implementer’s assumptions and blind spots. |
| Tests may run without proving required coverage | An incomplete check suite can report an apparently successful result. |
| Merge authority is loosely coupled to risk | An agent can be either unnecessarily blocked or dangerously overprivileged. |
| Run history is ephemeral | Crashes, retries, debugging, and audit reconstruction are difficult. |
| Cost is measured separately from engineering outcome | Token usage can rise without improving accepted, maintainable changes. |
| Harness improvements are driven by anecdote | Prompt, skill, and tool changes can regress behavior without detection. |

The user research reflects these gaps. Practitioners report value from repeated independent verification, fresh contexts, explicit task boundaries, private-repository evaluations, quiet terminal output, progressive context disclosure, and fail-closed check coverage. They also repeatedly warn that tests alone do not measure maintainability and that unconstrained optimization tends to exploit incomplete evaluators. fileciteturn0file0

The OpenAI Codex case study likewise emphasizes repository-local knowledge, per-worktree environments, mechanically enforced architecture, agent-readable observability, iterative agent review, and continuous “garbage collection.” It is useful evidence of an operating model, but it is a first-party case study rather than a controlled demonstration that autonomous merging is safe for arbitrary repositories. fileciteturn0file3

### Product thesis

runmill should be designed around six principles.

| Principle | Product consequence |
|---|---|
| **The orchestrator owns side effects** | Linear mutations, PR creation, merging, and issue completion are executed by deterministic code, not by an unconstrained coding-agent session. |
| **The coding agent is an untrusted but capable worker** | It receives a scoped workspace and bounded tools, and cannot independently widen its authority. |
| **Verification is a coverage contract** | Success means every required gate ran against the intended commit and passed—not merely that some tests returned green. |
| **Review is independent and evidence-bearing** | Review runs in a fresh context and produces structured, source-grounded findings. |
| **Autonomy is risk-tiered** | Low-risk changes may merge automatically; sensitive changes require explicit human approval. |
| **Harness evolution is offline and gated** | Production policies, evaluators, and permissions cannot rewrite themselves from live runs. |

### Recommended product positioning

The clearest positioning is:

> **runmill is the local-first control plane that turns a Linear backlog into a governed stream of agent-authored pull requests.**

This positioning avoids competing directly with Codex or Claude Code. It also differentiates runmill from generic agent frameworks, issue-to-PR bots, and unrestricted “Ralph loop” scripts by emphasizing deterministic state, provider neutrality, review independence, merge governance, and measurable engineering outcomes.

## Research synthesis and product implications

### What the harness literature changes in this PRD

The initial concept—fetch an issue, run an agent, review it, and merge it—is directionally correct but underspecified. The recent literature implies that the durable product is not the loop itself; it is the **explicit control surface around the loop**.

Lilian Weng characterizes a harness as the deployment system that decides how a model plans, invokes tools, manages context, persists artifacts, evaluates results, and interacts with permissions. She identifies workflow automation, filesystem-backed memory, inspectable subagents, bounded self-improvement, and external evaluators as recurring patterns. Her central warning is directly relevant to runmill: the evaluator and permission layer should sit outside any loop that can modify the harness. fileciteturn0file1

The “Code as Agent Harness” survey adds a useful architectural boundary. Code is valuable as a harness substrate because it makes actions executable, intermediate behavior inspectable, and state persistent. That supports a TypeScript state machine and structured artifacts rather than a long master prompt that asks the agent to manage the entire SDLC implicitly. citeturn11view3turn12view3

Agentic Harness Engineering, or AHE, divides observability into three surfaces:

- **Component observability:** every editable harness component is explicitly represented.
- **Experience observability:** raw trajectories are distilled into layered evidence with drill-down access.
- **Decision observability:** every harness edit is paired with a falsifiable prediction.

In its Terminal-Bench 2 experiments, ten evolution iterations raised pass@1 from 69.7% to 77.0%, compared with 71.9% for the tested Codex harness. Its ablations found that tools, middleware, and long-term memory carried gains while the system-prompt-only configuration regressed. The result does not prove safe production merging, but it strongly argues against reducing harness engineering to prompt editing. citeturn10view0turn11view0turn12view0

Meta-Harness pushes the optimization target further: the harness itself is a stateful program, and a coding agent searches over its source, scores, and execution traces through filesystem access. For runmill, the immediate implication is not to self-modify production code. It is to make every policy, adapter, skill, and evaluation result inspectable and versioned so that later offline optimization is possible. citeturn10view1turn11view1turn12view1

Harness Handbook addresses a different but important problem: as a harness grows, neither humans nor agents can easily locate the code responsible for a behavior. Its approach combines static analysis, behavior-centric organization, a three-level hierarchy, and behavior-guided progressive disclosure. runmill should adopt a lightweight version of this pattern by generating a behavior catalog that maps workflow stages, policies, adapters, state transitions, and side effects back to source locations. citeturn10view2turn11view2turn12view2

Practitioner discussions reinforce several compatible patterns: a single explicit lifecycle, strict architectural boundaries, repository-local plans and worklogs, isolated environments, mechanical checks, and review loops. They also surface unresolved concerns around token cost, codebase growth, self-review correlation, and misleading throughput metrics such as lines of code or raw PR count. fileciteturn0file2

### Refined architecture decisions

The research leads to the following material changes from a naïve implementation.

| Naïve design | Refined runmill requirement |
|---|---|
| Let the agent read Linear and choose work | runmill deterministically queries, filters, scores, claims, and snapshots the issue. |
| Give the agent Linear and GitHub credentials | Keep external-system credentials in the control plane; expose only scoped task data to the worker. |
| Put all repository instructions in one prompt | Use a compact task contract plus progressive disclosure into repository-owned documentation. |
| Ask the implementer to review itself | Add a fresh-context reviewer, optionally using a different provider or model family. |
| Continue until the agent says it is satisfied | Stop on deterministic severity thresholds, verification gates, iteration limits, and budget limits. |
| Treat “tests passed” as sufficient | Verify that the full required check manifest was discovered, executed against the correct commit, and completed without skips. |
| Let the agent merge using `gh` | runmill evaluates risk and branch protections, then invokes the normal GitHub merge path. |
| Store state in the chat transcript | Persist a state machine, event log, artifacts, commands, checks, costs, and decisions locally. |
| Update prompts after failures | Generate candidate harness changes and validate them against private held-out tasks before promotion. |
| Optimize for PR throughput | Optimize for accepted, non-reverted work per unit of human attention and cost. |

### Evidence limitations

Most of the 2026 harness work remains preprint research conducted on coding benchmarks or constrained environments. Benchmark gains may not transfer to long-lived repositories with migrations, security boundaries, operational dependencies, unclear product requirements, or delayed post-merge failures. AHE itself reports that interactions between components are non-additive and that its self-attribution is better at predicting fixes than regressions. citeturn10view0turn11view0

Therefore, runmill should be built as a **governed autonomy system**, not as an assumption that model output is inherently trustworthy. Its strongest differentiator should be knowing when not to merge.

## Users, goals, and scope

### Primary user

The initial user is a technically sophisticated founder or senior engineer who:

- Maintains one or more GitHub repositories.
- Uses Linear as the operational backlog.
- Already uses Codex, Claude Code, or both.
- Has repository-level tests and CI.
- Wants to reduce time spent selecting tasks, restating context, monitoring agents, and performing repetitive first-pass review.
- Is willing to encode repository policies and acceptance criteria.
- Wants local control over source code, credentials, and execution.

A secondary user is a small engineering team that wants a shared agent worker but is not yet ready for a fully hosted enterprise platform.

### Jobs to be done

| Situation | User need | Desired outcome |
|---|---|---|
| A backlog contains several ready issues | Choose the next appropriate task without manual triage | The highest-priority eligible issue is claimed deterministically. |
| A coding agent needs repository context | Supply the minimum complete task and repository context | The agent begins with clear scope and progressively retrieves deeper context. |
| The agent believes implementation is complete | Establish correctness beyond self-confidence | Deterministic gates and independent review expose defects and scope violations. |
| A PR is ready | Decide whether it may merge automatically | Risk policy, CI, branch protection, and review requirements yield an auditable decision. |
| A run crashes or reaches a limit | Recover without losing work or duplicating side effects | The run resumes from durable state or escalates cleanly. |
| The same failures recur | Improve the harness without introducing hidden regressions | Evidence-backed candidate changes are evaluated offline before rollout. |

### Product goals

| Goal | Definition |
|---|---|
| Continuous issue execution | Process eligible Linear issues serially without repeated user prompting. |
| Provider neutrality | Support Codex and Claude Code through a stable internal adapter contract. |
| Deterministic orchestration | Keep scheduling, state transitions, side effects, budgets, and merge decisions outside model control. |
| Reviewable output | Reduce review from reading an unbounded diff to checking scope, evidence, and remaining risk. |
| Safe recovery | Resume or compensate after process crashes, timeouts, provider failures, and CI failures. |
| Auditable autonomy | Record why each issue was selected, what ran, what changed, which checks passed, and why a merge was allowed. |
| Harness-level FinOps | Measure cost per accepted outcome rather than tokens in isolation. |
| Progressive improvement | Learn from recurring failures without allowing live self-modification of protected controls. |

### Non-goals

The first release will not:

- Replace Linear’s project-management interface.
- Train or fine-tune coding models.
- Build a new general-purpose coding agent.
- Bypass GitHub branch protections or required reviews.
- Autonomously merge high-risk changes by default.
- Allow the coding agent to modify runmill’s evaluator, policy engine, credentials, or production configuration.
- Execute several issues concurrently in the same working tree.
- Coordinate multi-repository transactions.
- Guarantee that every Linear issue is sufficiently specified for autonomous execution.
- Use lines of code, token consumption, or raw PR count as the primary success metric.
- Treat an agent-authored review as equivalent to an independent human approval where repository policy requires a human.

### Autonomy modes

runmill should expose four explicit autonomy levels.

| Mode | Behavior |
|---|---|
| `observe` | Selects and plans an issue, but performs no repository mutation. |
| `pr-only` | Implements, verifies, reviews, fixes, and opens a PR; never merges. |
| `guarded-merge` | May merge low-risk changes after all automated and repository gates pass. This is the recommended default after initial calibration. |
| `continuous` | Repeats guarded execution until no eligible work remains, a global budget is reached, or a circuit breaker opens. |

`pr-only` should be the initial default. Auto-merge becomes available only after `runmill doctor` confirms branch protections, required checks, identity separation, repository mapping, and recovery configuration.

## End-to-end product experience

### Initial setup

The primary setup flow is:

```text
$ runmill init

Choose a coding agent:
  1. Codex
  2. Claude Code

Detected:
  Codex: authenticated
  Claude Code: not installed

Linear authentication:
  1. Personal API key
  2. OAuth

GitHub authentication:
  Existing gh session: authenticated as mickey
  Recommended merge identity: runmill-bot

Select Linear team: Engineering
Map repository: ENG -> github.com/acme/platform
Select eligible states: Todo, Ready
Select claim state: In Progress
Select completion state: Done
Select initial autonomy: PR only

Discovered repository checks:
  npm run typecheck
  npm run lint
  npm test

Configuration written to runmill.yaml
Credentials stored in OS keychain
Run `runmill doctor` before starting.
```

Linear provides a GraphQL API, a typed TypeScript SDK, API-key authentication, and OAuth. Its API supports priority filters such as urgent and high-priority issues, while warning that unprioritized issues use priority value zero and therefore require explicit exclusion when using numeric filters. runmill should query a bounded eligible set and perform its final deterministic ordering locally. citeturn3search0turn3search3turn3search4turn13search0

For a local personal tool, an API key stored in the operating-system keychain is the simplest MVP path. OAuth should also be supported for shared or distributed use, with the application actor used where the integration should visibly perform actions as the app rather than impersonating an individual. Linear’s current OAuth integration uses refresh tokens, so the credential manager must handle refresh, revocation, and rotation. citeturn3search5turn3search6

runmill should reuse an existing authenticated Codex, Claude Code, and `gh` installation wherever possible rather than collecting provider credentials itself. Claude Code exposes noninteractive execution, JSON and streaming JSON output, session resume, turn limits, and tool allow/deny controls suitable for an adapter. citeturn13search1turn13search2

Codex should be integrated behind the same adapter boundary, preferably through its supported SDK where practical and through a version-probed CLI runner where the user wants to reuse local Codex authentication. OpenAI describes the Codex SDK as embedding the same agent used by the CLI, while current Codex surfaces support skills, sandboxing, and long-running work. citeturn4search0turn4search7turn13search8

### Core CLI

| Command | Purpose |
|---|---|
| `runmill init` | Interactive provider, Linear, GitHub, repository, policy, and check setup |
| `runmill doctor` | Validate binaries, authentication, branch protection assumptions, checks, workspace isolation, and keychain access |
| `runmill next --dry-run` | Show which issue would be selected and the complete eligibility and scoring explanation |
| `runmill run` | Select and process one issue |
| `runmill run ENG-123` | Process a specific issue after eligibility validation |
| `runmill daemon` | Continuously process eligible issues |
| `runmill status` | Show active run, stage, elapsed time, budgets, and blockers |
| `runmill inspect <run-id>` | Open the run summary, task packet, events, checks, findings, and side effects |
| `runmill logs <run-id> --follow` | Stream normalized agent and orchestrator events |
| `runmill pause` | Stop dispatching new model work at the next safe checkpoint |
| `runmill resume <run-id>` | Resume a paused or recoverable run |
| `runmill abort <run-id>` | Cancel work, release or preserve the issue lease according to policy, and retain artifacts |
| `runmill retry <run-id> --from review` | Create a controlled retry from a valid checkpoint |
| `runmill policy explain <run-id>` | Explain why the run may or may not merge |
| `runmill eval replay <suite>` | Replay a private evaluation suite against a candidate harness configuration |

### Configuration model

A representative configuration is:

```yaml
version: 1

provider:
  implementation: codex # codex | claude
  execution: local
  max_turns: 80
  timeout_minutes: 120

linear:
  team: ENG
  eligible_states: [Todo, Ready]
  claim_state: In Progress
  completed_state: Done
  blocked_state: Blocked
  include_labels: [agent-ready]
  exclude_labels: [needs-design, no-agent]
  max_estimate: 5
  allow_unassigned: true
  claim_assignee: runmill
  selection:
    priority_first: true
    unprioritized_last: true
    due_date_tiebreaker: true
    oldest_first: true

github:
  repository: acme/platform
  base_branch: main
  branch_template: runmill/{issue_identifier}-{slug}
  draft_pr: true
  merge:
    mode: guarded
    method: squash
    use_merge_queue: true
    delete_branch: true

workspace:
  strategy: worktree
  sandbox: container
  network: restricted
  clean_untracked_files: true

context:
  entry_files:
    - AGENTS.md
    - ARCHITECTURE.md
  max_initial_bytes: 50000
  progressive_disclosure: true

verification:
  manifest: .runmill/checks.yaml
  fail_on_missing_check: true
  fail_on_skipped_check: true
  commands:
    - id: typecheck
      run: npm run typecheck
    - id: lint
      run: npm run lint
    - id: unit
      run: npm test
  changed_area_rules:
    migrations:
      additional_checks: [migration-dry-run]
    ui:
      additional_checks: [playwright]

review:
  local_review_skill: .runmill/skills/code-review.md
  pr_review_skill: .runmill/skills/pr-review.md
  fresh_context: true
  provider: inherit
  max_fix_iterations: 3
  merge_blocking_severities: [critical, high]
  require_all_findings_resolved: true

risk:
  default: medium
  manual_approval:
    paths:
      - infra/**
      - migrations/**
      - security/**
    labels:
      - security
      - billing
      - breaking-change
    conditions:
      - public_api_change
      - permissions_change
      - secret_related_change
      - missing_acceptance_criteria

budgets:
  max_cost_usd_per_issue: 50
  max_wall_minutes_per_issue: 240
  max_agent_invocations: 8
  daily_cost_usd: 200
```

Configuration should be split into three ownership classes:

| Class | Examples | Modification authority |
|---|---|---|
| User policy | Autonomy, budgets, risk rules, merge mode | Human only |
| Repository policy | Checks, architecture rules, review rubrics | Human-reviewed repository change |
| Runtime state | Run ID, lease expiry, session IDs, check results | runmill only |

A coding agent may propose changes to the first two classes, but cannot activate those changes during the run that produced the proposal.

### Issue selection and claim protocol

“Highest priority” must be defined deterministically rather than left to model interpretation.

An issue is eligible only when:

- It belongs to a mapped Linear team or project.
- Its workflow state is allowed.
- It is not canceled, completed, or actively leased.
- Its labels satisfy the configured allow and deny rules.
- Its repository mapping is unambiguous.
- Its estimate is within the configured maximum, when estimates are used.
- Its dependencies are not known to be blocked.
- Its description contains enough information to create a task packet, or an explicit `agent-ready` label overrides that readiness check.
- The global worker, repository, and cost limits allow another run.

Eligible issues are ordered by:

1. Explicit Linear priority, with urgent before high, high before medium, medium before low, and no-priority last.
2. Breached or nearest due date or SLA, when configured.
3. Manual within-priority rank if retrievable.
4. Oldest creation timestamp.
5. Stable issue identifier as the final tie breaker.

Linear recommends avoiding high-frequency polling and provides webhooks for change notifications. For the local MVP, runmill should query at safe task boundaries rather than continuously polling. A later hosted coordinator may accept signed webhooks and use them to wake the scheduler while still re-reading issue state before acting. citeturn3search1turn3search2

The claim operation must behave like a lease:

```text
Generate run ID
        ↓
Re-read issue eligibility
        ↓
Transition issue to claim state
        ↓
Assign configured bot/app identity
        ↓
Add structured claim marker with run ID and lease expiry
        ↓
Re-read issue and verify claim ownership
        ↓
Persist local lease
        ↓
Begin workspace creation
```

The claim marker should be human-readable and machine-parseable:

```text
runmill claimed this issue.

Run: run_01J...
Repository: acme/platform
Provider: codex
Claimed at: 2026-08-06T10:42:11Z
Lease expires: 2026-08-06T14:42:11Z
Host: sha256:...
```

If verification shows that another run owns the claim, runmill must abandon the attempt without editing the repository. Lease renewal occurs only at safe checkpoints. Expired claims are never silently stolen; runmill first verifies that the previous run is absent or explicitly recoverable.

### State machine

```text
DISCOVERED
    ↓
ELIGIBILITY_CHECKED
    ↓
CLAIMED
    ↓
WORKSPACE_READY
    ↓
TASK_PACKET_READY
    ↓
IMPLEMENTING
    ↓
LOCAL_VERIFY
    ↓
LOCAL_REVIEW
    ↙          ↘
FIXING       PR_READY
  ↑             ↓
  └──────── LOCAL_VERIFY
                ↓
             PR_OPEN
                ↓
             CI_WAIT
                ↓
             PR_REVIEW
             ↙       ↘
        PR_FIXING   MERGE_READY
             ↑          ↓
             └────── CI_WAIT
                        ↓
                  MERGE_QUEUED
                        ↓
                     MERGED
                        ↓
                  LINEAR_UPDATED
                        ↓
                     CLEANUP
                        ↓
                    COMPLETED
```

Every active state may transition to one of four controlled exception states:

| State | Meaning |
|---|---|
| `RETRY_WAIT` | A transient, classified failure is eligible for bounded retry. |
| `NEEDS_HUMAN` | Product judgment, credentials, an approval, or ambiguous requirements are required. |
| `QUARANTINED` | A safety, secret, corruption, evaluator, or unexpected-side-effect condition occurred. |
| `ABORTED` | A human or circuit breaker terminated the run. |

Each transition must be idempotent. On restart, runmill inspects durable state and external reality before repeating any side effect.

## Functional and technical requirements

### System architecture

```text
                         ┌────────────────────────┐
                         │      runmill CLI     │
                         └───────────┬────────────┘
                                     │
                         ┌───────────▼────────────┐
                         │ Orchestrator / State   │
                         │ Machine / Scheduler    │
                         └──────┬────┬────┬───────┘
                                │    │    │
             ┌──────────────────┘    │    └─────────────────┐
             │                       │                      │
     ┌───────▼────────┐     ┌────────▼─────────┐   ┌────────▼────────┐
     │ Linear Adapter │     │ Workspace Manager│   │  Policy Engine  │
     │ Selection/Lease│     │ Worktree/Sandbox │   │ Risk/Budget/RBAC│
     └────────────────┘     └────────┬─────────┘   └────────┬────────┘
                                     │                      │
                           ┌─────────▼─────────┐            │
                           │  Task Packet and  │            │
                           │ Context Builder   │            │
                           └─────────┬─────────┘            │
                                     │                      │
                       ┌─────────────▼─────────────┐        │
                       │ Provider Adapter Contract │        │
                       ├──────────────┬─────────────┤        │
                       │ Codex Adapter│Claude Adapter        │
                       └──────────────┴─────────────┘        │
                                     │                      │
                       ┌─────────────▼─────────────┐        │
                       │ Verify / Review / Fix Loop │◄───────┘
                       └─────────────┬─────────────┘
                                     │
                          ┌──────────▼───────────┐
                          │   GitHub Adapter     │
                          │ PR / CI / Queue/Merge│
                          └──────────┬───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │ Events / Artifacts / │
                          │ Metrics / Cost Store │
                          └──────────────────────┘
```

### Control-plane boundary

The orchestrator owns:

- Linear reads and mutations.
- Issue selection and leasing.
- Workspace creation and deletion.
- Provider invocation and cancellation.
- Time, token, invocation, and monetary budgets.
- Required check discovery.
- Verification execution.
- Review finding lifecycle.
- GitHub PR creation and updates.
- Merge eligibility and merge invocation.
- Linear completion and run summaries.
- Secret access and redaction.

The coding-agent worker owns:

- Repository inspection inside its assigned workspace.
- Planning the implementation.
- Editing allowed repository files.
- Running permitted local development commands.
- Producing requested structured artifacts.
- Addressing review findings.

By default, the worker does **not** receive Linear, GitHub, runmill, cloud-production, or secret-manager credentials. This prevents issue text or repository content from directly inducing external side effects.

### Provider adapter contract

Both provider integrations must implement a common interface:

```ts
interface CodingAgentAdapter {
  detect(): Promise<ProviderInstallation>;
  authStatus(): Promise<AuthStatus>;
  capabilities(): Promise<ProviderCapabilities>;

  start(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  resume(request: AgentResumeRequest): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;

  normalizeExit(result: ProviderExit): AgentRunResult;
}
```

`AgentRunRequest` includes:

- Run and issue identifiers.
- Role: `implementer`, `local-reviewer`, `fixer`, `pr-reviewer`, or `retrospective`.
- Working directory.
- Task packet path.
- Allowed tools and commands.
- Disallowed paths and commands.
- Network policy.
- Session budget.
- Output schema.
- Stop conditions.

Normalized events include:

```ts
type AgentEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "assistant.message"; text: string }
  | { type: "tool.requested"; tool: string; input: unknown }
  | { type: "tool.completed"; tool: string; outputRef: string }
  | { type: "command.started"; command: string }
  | { type: "command.completed"; exitCode: number; outputRef: string }
  | { type: "file.changed"; path: string }
  | { type: "permission.requested"; action: string }
  | { type: "usage.updated"; tokens?: number; costUsd?: number }
  | { type: "result"; status: "success" | "failure"; outputRef: string };
```

The Claude adapter can use print mode, streaming JSON, `--max-turns`, resume support, and explicit tool permissions. The adapter must never invoke `--dangerously-skip-permissions` in a non-ephemeral host environment. citeturn13search1turn13search4

Provider CLIs evolve independently. Therefore, `runmill doctor` must run a capability probe and adapters must have versioned conformance tests. Unknown or incompatible output formats must fail closed rather than being interpreted heuristically.

### Task packet

The initial agent prompt should remain small. Current model guidance also recommends lean prompts, exposing only relevant tools and validating prompt reductions on representative evaluations rather than accumulating repeated instructions. citeturn14search6

runmill should write a task packet to `.runmill/run/task.json`:

```json
{
  "run_id": "run_01J...",
  "issue": {
    "identifier": "ENG-123",
    "title": "Prevent duplicate webhook delivery processing",
    "description_file": "issue.md",
    "priority": "high",
    "labels": ["backend", "agent-ready"]
  },
  "objective": "Implement the issue exactly as specified.",
  "acceptance_criteria": [
    "Repeated delivery IDs are processed once",
    "The deduplication record expires after the configured retention period",
    "Existing webhook behavior remains backward compatible"
  ],
  "repository": {
    "base_commit": "abc123",
    "branch": "runmill/ENG-123-prevent-duplicate-webhook-processing"
  },
  "constraints": {
    "allowed_paths": ["src/**", "tests/**", "docs/**"],
    "forbidden_paths": [".github/workflows/release.yml"],
    "network": "restricted"
  },
  "required_checks": [
    "typecheck",
    "lint",
    "unit",
    "webhook-integration"
  ],
  "completion_contract": {
    "require_clean_git_status": false,
    "require_summary": true,
    "require_test_evidence": true,
    "require_scope_statement": true
  }
}
```

The human-readable task instruction should tell the agent where to retrieve deeper context rather than embedding all repository documentation. The repository remains the source of truth; the packet is a stable snapshot and contract.

### Persistent state and artifacts

State should be stored in SQLite, with large artifacts on disk:

```text
~/.local/share/runmill/
├── runmill.db
├── runs/
│   └── run_01J.../
│       ├── events.jsonl
│       ├── issue-snapshot.json
│       ├── task-packet.json
│       ├── sessions/
│       ├── commands/
│       ├── checks/
│       ├── reviews/
│       ├── diffs/
│       ├── policy-decisions/
│       └── summary.md
└── evals/
```

SQLite contains:

| Entity | Critical fields |
|---|---|
| `runs` | Run ID, issue ID, repository, provider, state, base commit, timestamps |
| `leases` | Issue ID, run ID, expiry, last renewal, external marker |
| `sessions` | Provider, role, provider session ID, status, usage |
| `events` | Sequence, event type, timestamp, artifact reference, redaction status |
| `checks` | Check ID, command, commit SHA, required status, result, duration |
| `findings` | Review ID, severity, evidence, status, resolution |
| `side_effects` | Idempotency key, external system, operation, remote ID |
| `budgets` | Wall time, cost, turns, invocations, command count |
| `policy_decisions` | Inputs, matched rules, outcome, explanation |
| `harness_versions` | Config hash, skill hashes, adapter version, policy version |

Every run must be reconstructable without access to the original model context. Sensitive values and high-volume command output should be stored as redacted artifacts with hashes and retention controls.

### Functional requirements

| ID | Requirement | Acceptance criterion |
|---|---|---|
| FR-01 | Interactive setup | A first-time user can configure one Linear team, one repository, and one provider without editing JSON manually. |
| FR-02 | Authentication validation | `runmill doctor` identifies missing, expired, or insufficient credentials before a run starts. |
| FR-03 | Explainable issue selection | `next --dry-run` lists eligible and rejected candidates with rule-by-rule explanations. |
| FR-04 | Exclusive claim | Two runmill processes attempting the same issue result in no more than one verified owner. |
| FR-05 | Snapshot consistency | The issue snapshot and base commit are persisted before model execution. |
| FR-06 | Workspace isolation | Each run receives a unique branch and worktree; no run can mutate another run’s workspace. |
| FR-07 | Provider interchangeability | The same fixture task can execute through either adapter without changing orchestration code. |
| FR-08 | Structured execution events | Agent output is normalized into typed events and survives a runmill restart. |
| FR-09 | Bounded implementation | Turn, time, cost, command, and retry limits stop further model work when exceeded. |
| FR-10 | Check-manifest enforcement | A run cannot become merge-ready if a required check is missing, skipped, canceled, stale, or run against a different commit. |
| FR-11 | Independent local review | Review starts in a fresh provider session with no hidden dependency on the implementer’s conversation. |
| FR-12 | Finding resolution | Every merge-blocking finding is either fixed and reverified or explicitly escalated. |
| FR-13 | PR traceability | The PR links the Linear issue and includes scope, evidence, checks, review summary, and runmill run ID. |
| FR-14 | CI reconciliation | runmill waits for the required check set returned by GitHub rather than assuming local checks are sufficient. |
| FR-15 | Protected merge | Merge occurs only through an allowed GitHub mechanism and never bypasses branch protection. |
| FR-16 | Linear synchronization | Successful merge produces an issue comment, PR link, summary, and configured completion transition. |
| FR-17 | Crash recovery | Terminating the daemon during implementation, CI wait, and merge wait allows deterministic recovery without duplicating a PR or merge. |
| FR-18 | Human escalation | A blocked run produces a concise explanation, the required decision, and a resumable checkpoint. |
| FR-19 | Continuous queue | In continuous mode, a completed run causes the next selection only after cleanup and global budget checks. |
| FR-20 | Audit export | A user can export a run bundle containing configuration hashes, events, checks, findings, side effects, and outcome. |

### Non-functional requirements

| Area | Requirement |
|---|---|
| Reliability | All external mutations are idempotent or reconciled after ambiguous responses. |
| Security | Secrets are stored in an OS keychain or external secret provider, never in repository files or task packets. |
| Portability | macOS and Linux are first-class; Windows through WSL may follow after worktree and process behavior is validated. |
| Performance | Orchestrator overhead excluding model and test execution should remain below five seconds per state transition. |
| Scalability | The data model supports multiple repositories and workers, although the MVP defaults to one active issue. |
| Auditability | Every merge decision includes policy inputs, required gates, their exact results, and the responsible identity. |
| Operability | Logs are structured, redacted, correlated by run ID, and available both interactively and as files. |
| Upgrade safety | Provider adapter upgrades run conformance tests before they may become the active version. |
| Data retention | Retention is configurable separately for source diffs, command output, model transcripts, and metadata. |
| Determinism | Selection, policy evaluation, check coverage, and state transitions do not depend on LLM judgment. |

## Verification, review, and merge governance

### Verification contract

The verification engine must answer four separate questions:

1. **Discovery:** Which checks are required for this change?
2. **Coverage:** Were all of those checks actually invoked?
3. **Freshness:** Did they run against the exact candidate commit?
4. **Outcome:** Did they complete successfully without prohibited skips or flakes?

A green command is insufficient if the expected integration suite was never discovered. This is the fail-closed coverage concern highlighted in the user research: an incomplete evaluator can be more dangerous than an openly weak one because it reports decisive success while omitting the case that would have failed. fileciteturn0file0

Required checks may come from:

- Static repository configuration.
- Changed-path rules.
- Issue labels.
- Risk classification.
- Language and package discovery.
- GitHub-required checks.
- Agent-proposed additional checks.

The agent may add checks, but it cannot remove checks from the resolved manifest.

Each result records:

```json
{
  "check_id": "unit",
  "required": true,
  "source": "repository-policy",
  "command": "npm test",
  "commit_sha": "def456",
  "started_at": "2026-08-06T12:01:00Z",
  "completed_at": "2026-08-06T12:03:14Z",
  "exit_code": 0,
  "skipped_tests": 0,
  "output_hash": "sha256:...",
  "status": "passed"
}
```

### Local review protocol

The local review happens before opening the PR and runs in a fresh context.

The reviewer receives:

- Issue snapshot and acceptance criteria.
- Base and candidate commits.
- Complete diff.
- Relevant repository policy.
- Check manifest and results.
- Changed-file list.
- No implementer chain of thought or self-justifying narrative.

The reviewer returns structured findings:

```json
{
  "verdict": "changes_required",
  "scope_assessment": "within_scope",
  "findings": [
    {
      "id": "REV-001",
      "severity": "high",
      "category": "correctness",
      "title": "Deduplication is not atomic",
      "evidence": {
        "path": "src/webhooks/dedupe.ts",
        "start_line": 41,
        "end_line": 56
      },
      "claim": "Two workers can both observe no record and process the same delivery.",
      "required_resolution": "Use an atomic insert-or-conflict operation and add a concurrent test.",
      "confidence": 0.93
    }
  ]
}
```

A valid review must:

- Tie every finding to evidence.
- Separate correctness, security, scope, maintainability, testing, and documentation concerns.
- Avoid inventing issues merely to satisfy a request for criticism.
- State `no_findings` when justified.
- Distinguish a required change from an optional suggestion.
- Verify acceptance criteria individually.
- Identify unnecessary or out-of-scope changes.
- Check whether the implementation relies on stale, guessed, or unvalidated data shapes.

The review loop terminates when:

- No critical or high findings remain.
- All required checks pass on the latest commit.
- Acceptance-criterion coverage is complete.
- The maximum iteration count has not been exceeded.
- The budget remains available.
- No policy escalation condition exists.

It does **not** terminate merely because the implementer claims completion or because the reviewer says “looks good.”

### Reviewer independence

runmill should support three review configurations:

| Configuration | Independence | Cost | Recommended use |
|---|---:|---:|---|
| Same provider, fresh session | Moderate | Lowest | Default MVP |
| Same provider, different model | Higher | Medium | Sensitive but bounded changes |
| Different provider family | Highest practical independence | Highest | Security, migrations, or calibration samples |

Repeated review by multiple model families can reduce correlated blind spots, but it can also increase cost and generate low-value speculative findings. The policy should therefore require additional reviewers based on risk rather than blindly repeating every review five to ten times. Practitioner reports support independent repetition but also note that subsequent verification is necessary to filter over-eager findings. fileciteturn0file0

### Pull request creation

The PR body should be generated from structured artifacts, not an unconstrained prose summary:

```markdown
## Linear issue
ENG-123 — Prevent duplicate webhook delivery processing

## Scope
Implemented atomic delivery-ID deduplication and retention cleanup.

## Acceptance criteria
- [x] Repeated delivery IDs are processed once
- [x] Deduplication records expire after configured retention
- [x] Existing webhook behavior remains backward compatible

## Verification
- typecheck: passed
- lint: passed
- unit: passed
- webhook-integration: passed
- local independent review: passed after one fix iteration

## Risk
Medium — persistence behavior changed; no schema migration required.

## runmill
Run: run_01J...
Provider: Codex
Harness version: sha256:...
```

The PR begins as a draft unless the policy explicitly allows immediate readiness. Once local review and local checks are complete, runmill marks it ready and waits for GitHub CI.

### PR review protocol

PR review is separate from local review because the remote PR may differ due to rebasing, generated files, CI-specific behavior, or subsequent commits.

The PR reviewer receives:

- The final GitHub diff.
- Current head and base SHAs.
- GitHub check results.
- Local review findings and resolutions.
- Relevant comments.
- The Linear issue snapshot.
- Merge and risk policies.

The reviewer must verify:

- The PR still matches the claimed local commit.
- The change remains within issue scope.
- Acceptance criteria remain satisfied.
- No merge-conflict resolution introduced new behavior.
- CI failures were fixed rather than hidden or disabled.
- Review comments have been resolved accurately.
- No protected configuration was weakened.
- The PR description and evidence remain truthful.

### GitHub identities and approval

GitHub does not allow a PR author to approve their own pull request. Therefore, an agent review posted by the same identity that authored the PR cannot satisfy a required independent approval. runmill must explicitly distinguish:

- Internal automated review evidence.
- GitHub review submitted by a separate bot identity.
- Required human approval.
- Repository-owner or code-owner approval. citeturn1search0

The initial product should not attempt to simulate human independence by creating several nominal bot identities controlled by one unrestricted credential. Identity separation is useful for audit and least privilege, but it does not transform correlated model judgments into human review.

### Merge eligibility

A run is `MERGE_READY` only if all conditions hold:

| Gate | Requirement |
|---|---|
| Issue lease | Active and owned by the run |
| Repository state | Candidate head is known and branch is not unexpectedly modified |
| Scope | Reviewer reports within scope |
| Findings | No unresolved merge-blocking finding |
| Local verification | Complete and fresh |
| GitHub checks | All required checks successful |
| Conversations | Resolved where branch policy requires it |
| Approval | Required human, code-owner, or independent approval present |
| Risk | Autonomy level permits the classified risk |
| Budget | No budget or circuit-breaker violation |
| Security | No secret, unauthorized-side-effect, or policy incident |
| Merge protection | Merge uses an allowed GitHub path |
| Linear state | Issue is still valid and not canceled or reassigned incompatibly |

GitHub branch protection can require status checks, approving reviews, conversation resolution, signed commits, linear history, deployments, and merge queues. runmill must discover and respect these controls rather than mirror a potentially stale subset in its own configuration. citeturn1search5

Where a repository uses GitHub’s merge queue, runmill should enqueue the PR rather than merge directly. The queue validates the PR against the latest base branch; CI workflows must also handle GitHub’s `merge_group` event for required queue checks. citeturn1search1turn1search4

### Risk classification

The policy engine computes risk deterministically from paths, labels, file types, diff properties, repository metadata, and issue characteristics. An agent may provide an advisory risk assessment but cannot reduce the deterministic classification.

| Risk | Typical examples | Default policy |
|---|---|---|
| Low | Documentation, isolated tests, internal refactor with unchanged behavior, narrow bug fix with strong regression test | Eligible for guarded auto-merge after calibration |
| Medium | Product behavior, internal API, persistence logic without migration, dependency updates | PR review required; auto-merge configurable |
| High | Authentication, authorization, cryptography, billing, public API, schema migration, infrastructure, IAM, deployment, secrets | Human approval required |
| Critical | Destructive migration, production credential changes, branch-protection changes, evaluator disabling, large unbounded rewrite | Automation stops and quarantines the run |

Risk is raised when:

- Acceptance criteria are missing or contradictory.
- The diff exceeds configured file or line thresholds.
- Unexpected repositories or submodules change.
- Required tests cannot run.
- The implementation adds broad permissions.
- CI configuration is weakened.
- The agent modifies its own verification or policy files during the task.
- Generated or vendored code dominates the diff.
- A new network dependency or executable download appears.
- The issue affects regulated, customer-data, financial, or safety-sensitive paths.

### Credential and execution security

runmill should follow a least-authority design:

| Credential | Holder | Worker visibility |
|---|---|---|
| Linear API key or OAuth token | runmill credential manager | None |
| GitHub merge credential | GitHub adapter | None |
| Provider local session | Provider subprocess | Only through provider runtime |
| Repository read/write | Isolated worktree | Yes |
| Production cloud credentials | Not available by default | None |
| Package registry credentials | Short-lived scoped helper where required | Command-specific |
| runmill policy key | Orchestrator | None |

The sandbox defaults to:

- Write access only to the run worktree and designated temporary directories.
- No access to other run directories.
- Restricted outbound network.
- Denial of privileged container operations.
- Redacted environment.
- Command and path policies.
- Maximum process count and resource limits.
- Explicit package-install policy.
- No direct access to OS keychain sockets.

Issue descriptions, PR comments, documentation, dependency output, and repository files must be treated as untrusted data. Instructions found there cannot override the task contract, allowed tools, or policy engine.

### Failure and recovery policy

| Failure | Default handling |
|---|---|
| Provider rate limit | Backoff within run deadline; retain lease |
| Provider process crash | Resume supported session or start a fresh role-specific session from artifacts |
| runmill crash | Reconcile SQLite state, Git state, Linear claim, PR state, and provider session before transition |
| Failed local check | Dispatch a bounded fix iteration |
| Flaky check | Retry only when the check is explicitly classified as retryable; preserve both results |
| Missing check | Fail closed and escalate |
| CI failure | Classify as code, infrastructure, or unknown before deciding whether to fix |
| Merge conflict | Rebase or update branch in a dedicated step, then rerun complete verification |
| Linear issue edited materially | Pause and regenerate the task packet; do not silently continue against stale scope |
| Lease lost | Stop model work and preserve workspace |
| Secret detected | Quarantine, rotate or revoke as applicable, and block PR creation |
| Cost limit reached | Pause at the next safe checkpoint and request approval |
| Repeated review failure | Escalate with unresolved findings and attempted resolutions |
| Ambiguous external mutation | Re-read external state before retrying; never assume failure means no side effect |

## Evaluation, metrics, and delivery plan

### North-star metric

The primary product metric should be:

> **Accepted, non-reverted Linear issues merged per hour of human attention, within quality and cost constraints.**

This avoids the principal weakness of raw PR count and lines of code. The OpenAI case study reports substantial PR and code throughput, while the accompanying practitioner discussion correctly questions whether volume alone establishes maintainability, user value, or long-term software quality. fileciteturn0file2turn0file3

### Product metrics

| Dimension | Metric |
|---|---|
| Outcome | Eligible issues completed and accepted |
| Human leverage | Median human attention minutes per completed issue |
| Cycle time | Claim-to-PR and claim-to-merge duration |
| First-pass quality | Percentage of implementations passing local verification before review fixes |
| Review quality | Critical and high findings per run; recurrence of previously encoded findings |
| Escaped defects | Reverts, hotfixes, incidents, or reopened issues attributable to merged agent work |
| Scope discipline | Percentage of PRs with no out-of-scope modifications |
| Reliability | Successful recovery rate after injected orchestrator and provider failures |
| Safety | Unauthorized external side effects, secret exposures, or protection bypasses; target zero |
| Cost | Model cost per opened PR and per accepted merged issue |
| Efficiency | Tokens, tool calls, command output bytes, and retries per accepted issue |
| Merge performance | Time waiting for CI or merge queue versus active implementation time |
| Calibration | Agreement between automated risk classification and human audit |
| Harness health | Candidate changes accepted, rejected, regressed, or rolled back in offline evaluation |

### Launch targets

The following are proposed pilot targets, not claims about current provider performance:

| Target | Pilot threshold |
|---|---:|
| Runs with complete reconstructable audit bundle | 100% |
| Merges bypassing configured GitHub protection | 0 |
| Secret or production credential exposure to coding worker | 0 |
| Duplicate verified claims under concurrency tests | 0 |
| Required checks omitted while run is marked merge-ready | 0 |
| Recoverable state-machine crash scenarios successfully resumed | At least 95% |
| Low-risk eligible issues reaching a PR without implementation intervention | At least 70% by end of pilot |
| Automatically merged changes reverted due to correctness defects | No worse than repository’s comparable human baseline |
| Median human attention for low-risk successful issue | Below 10 minutes |
| Run cost exceeding configured hard cap | 0 without explicit override |

### Private repository evaluation

Public benchmarks are useful for comparing broad agent capabilities, but runmill’s production fitness function must be repository-specific.

The evaluation corpus should be derived from historical issues and PRs:

```text
Historical issue
      +
Pre-change repository commit
      +
Original failing behavior or test
      +
Accepted post-change behavior
      +
Repository-specific review rubric
      =
Replayable runmill task
```

Tasks should span:

- Bug fixes.
- Small features.
- Refactors.
- Test additions.
- Documentation changes.
- Dependency changes.
- UI changes.
- Operational or observability work.
- Intentionally underspecified issues that should trigger escalation.
- High-risk issues that should be refused for autonomous merge.

Each task needs a composite evaluator:

| Evaluator | Role |
|---|---|
| Deterministic tests | Functional correctness |
| Static checks | Types, lint, architecture, security, policy |
| Diff-scope evaluator | Unnecessary or forbidden changes |
| Repository rubric | Maintainability and local engineering standards |
| Human calibration sample | Validate automated judgment |
| Delayed outcome | Revert, incident, or follow-up defect where historical data exists |

The suite must be separated into development, validation, and held-out sets. The harness optimizer may see development traces and validation scores, but not held-out task details or evaluator implementation. This separation follows the self-improvement literature’s concern that an optimizer will exploit whatever signal it can modify or infer. fileciteturn0file1

Because agent execution is stochastic, representative configurations should be run more than once. Comparisons should report confidence intervals or paired task outcomes rather than relying on one successful demonstration.

### Harness improvement loop

Production runs may generate a retrospective, but the retrospective has advisory authority only.

```text
Production traces
       ↓
Failure and success classification
       ↓
Recurring-pattern clustering
       ↓
Candidate harness change proposal
       ↓
Human-readable change manifest
       ↓
Private development evaluation
       ↓
Validation evaluation
       ↓
Held-out regression evaluation
       ↓
Human approval
       ↓
Canary rollout
       ↓
Promotion or rollback
```

A candidate manifest should contain:

```yaml
evidence:
  recurring_failure: review-finding-atomicity
  affected_runs: [run_01A, run_01B, run_01C]

root_cause:
  component: task-packet
  claim: acceptance criteria do not request concurrency analysis

change:
  files:
    - .runmill/skills/code-review.md
  description: require concurrency review for read-before-write persistence paths

prediction:
  expected_improvements:
    - atomicity-fixture-1
    - atomicity-fixture-3
  regression_risks:
    - increased false-positive review findings
    - higher review token cost

acceptance:
  no_held_out_regression: true
  maximum_cost_increase_percent: 10
```

This adapts AHE’s evidence, root-cause, targeted-fix, and predicted-impact model while preserving a stronger boundary: production policy, verifier code, held-out data, and permission controls remain read-only to the proposing agent. citeturn10view0turn12view0

### Behavior handbook

After the MVP stabilizes, runmill should generate a behavior-oriented handbook:

```text
runmill
├── Queue lifecycle
│   ├── Select issue
│   ├── Claim lease
│   └── Release or complete lease
├── Workspace lifecycle
│   ├── Create worktree
│   ├── Apply sandbox
│   └── Cleanup
├── Agent lifecycle
│   ├── Implement
│   ├── Review
│   ├── Fix
│   └── Cancel or resume
├── Verification lifecycle
│   ├── Resolve manifest
│   ├── Execute checks
│   └── Prove coverage
├── Pull request lifecycle
│   ├── Open
│   ├── Reconcile CI
│   ├── Review
│   └── Merge queue
└── Exception lifecycle
    ├── Retry
    ├── Escalate
    ├── Quarantine
    └── Recover
```

Each behavior entry should identify:

- Entry conditions.
- State transitions.
- Source files and functions.
- External side effects.
- Idempotency mechanism.
- Policy checks.
- Artifacts emitted.
- Failure and recovery paths.
- Tests covering the behavior.

This gives humans and future coding agents a progressive-disclosure map rather than requiring them to infer the control plane from files and classes. It is the most directly applicable productization of the Harness Handbook work. citeturn10view2turn12view2

### Delivery phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| Foundation | CLI setup, config, keychain, Linear query, deterministic selection, dry run, SQLite state | User can authenticate, inspect selection, and claim/release an issue without invoking a model |
| Agent execution | Worktree isolation, Codex adapter, Claude adapter, task packet, normalized events, budgets | The same fixture issue executes through both providers and survives an orchestrator restart |
| Verified PR | Check manifest, local review/fix loop, PR creation, CI reconciliation | An issue reliably becomes an evidence-bearing draft PR; no merge capability required |
| Governed merge | Risk engine, branch-protection discovery, approvals, merge queue, Linear completion | Low-risk fixture may merge; high-risk fixture always requires human approval |
| Continuous operation | Daemon, lease renewal, cleanup, circuit breakers, daily budgets | Worker processes several eligible issues serially without duplicate claims or lost state |
| Evaluation | Historical-task importer, replay runner, configuration comparison, held-out suite | Harness changes can be compared on quality, cost, and regressions |
| Harness maintainability | Behavior handbook, trace distillation, candidate-change workflow | A reviewer can locate and explain every critical workflow behavior from generated documentation |

### Recommended MVP boundary

The first commercially useful release should include:

- Local TypeScript CLI.
- One active issue at a time.
- Linear API-key authentication and optional OAuth.
- Existing `gh` authentication.
- Codex and Claude Code adapters.
- Worktree isolation.
- Deterministic issue selection and lease.
- Persistent SQLite state.
- Bounded implementation.
- Repository-defined check manifest.
- Fresh-context local review and fix loop.
- Draft PR creation.
- CI monitoring.
- `pr-only` and `guarded-merge` modes.
- Linear completion.
- Full run audit bundle.

The MVP should exclude:

- Live self-modification.
- Parallel issue execution.
- Cross-repository transactions.
- Hosted webhook infrastructure.
- Production cloud access.
- Automatic high-risk merging.
- Model fine-tuning.
- Automatic policy promotion.
- General-purpose multi-agent collaboration.

### Principal risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Linear issue is underspecified | Incorrect but plausible implementation | Readiness gate, acceptance-criteria extraction, human escalation |
| Two workers select the same issue | Duplicate code and conflicting PRs | Verified lease, stable run ID, re-read after claim, local uniqueness |
| Agent follows malicious repository instruction | Credential or policy compromise | No external credentials in worker, separate data and policy channels, sandbox |
| Reviewer repeats implementer assumptions | Defects survive review | Fresh context, evidence schema, optional cross-provider review |
| Tests pass but required coverage is absent | False confidence | Fail-closed manifest discovery and coverage proof |
| Agent disables or weakens checks | Unsafe merge | Protected paths, baseline comparison, risk escalation |
| Provider CLI changes | Broken automation or misparsed output | Capability probe, pinned range, adapter conformance suite |
| Long runs become expensive | Cost exceeds value | Per-session, per-issue, and daily budgets; early stop conditions |
| Review loops become endless | Cost and queue starvation | Severity thresholds, maximum iterations, escalation |
| Flaky CI causes repeated modifications | Agent “fixes” non-code failures | Failure classification, retry policy, no mutation until code cause established |
| Auto-merge introduces delayed defect | Customer or operational harm | Risk tiers, branch protections, canary rollout, revert monitoring |
| Harness optimizer reward-hacks tests | Misleading apparent improvement | Read-only evaluator, held-out suite, human approval, canary |
| Repository quality degrades gradually | Higher future agent and human cost | Architecture checks, recurring quality tasks, entropy metrics, behavior handbook |
| Human attention merely shifts to monitoring | Product fails its core promise | Measure attention minutes, escalation quality, and non-reverted outcomes |

### Decisions recommended for the initial build

| Decision | Recommendation |
|---|---|
| Implementation language | TypeScript, because Linear’s typed SDK and the broader CLI ecosystem fit the target user and integration surface |
| Local state | SQLite plus artifact files |
| Workspace | Git worktree inside an ephemeral container where available |
| Concurrency | One active issue globally for MVP; one per repository later |
| Default provider | User-selected during setup; no automatic model routing initially |
| Linear auth | Personal API key for solo MVP, OAuth for shared mode |
| GitHub auth | Existing `gh` session for initial PR-only mode; dedicated GitHub App or bot identity before shared auto-merge |
| Default autonomy | `pr-only` |
| Local reviewer | Same provider in a fresh session |
| Auto-merge eligibility | Low-risk only, after calibration and branch-protection verification |
| Merge mechanism | GitHub merge queue where configured; otherwise protected squash merge |
| Self-improvement | Offline proposals only |
| Primary metric | Accepted, non-reverted issues per human-attention hour |
| Product boundary | runmill controls workflow and side effects; Codex or Claude Code controls implementation inside the sandbox |

The resulting product is narrower than a general autonomous engineer but substantially more defensible: a transparent, provider-neutral, recoverable, and policy-governed system for converting a well-prepared backlog into reviewable software changes.

---

# APPENDIX A — /autoplan Review Findings

Generated by `/autoplan` on 2026-08-06. Branch `main`, commit `a0ca4b8`.
Mode: **SCOPE EXPANSION** (user directive: "build it all").
CEO voices: Claude subagent only (Codex strategy voice discarded at user instruction).

## A.0 Scope and premise decisions

| # | Decision | Source |
|---|---|---|
| D-01 | Build full PRD scope: all 7 delivery phases, both adapters, daemon, continuous mode, eval corpus, behavior handbook, audit export. No cuts. | User |
| D-02 | Sandbox = native OS mechanisms: Seatbelt (`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux. `container` becomes an opt-in second layer, not the default. | User |
| D-03 | Backlog source is generic. `BacklogAdapter` boundary with Linear as impl #1. | User (restated premise) |
| D-04 | Positioning is autonomy-forward; continuous operation is core product, not delivery phase 5. | User (restated premise) |
| E1 | ACCEPT: readiness scorer + `runmill prepare` — score issue specification, extract acceptance criteria, escalate with a decision-shaped question. | autoplan P1 |
| E2 | ACCEPT: `BacklogAdapter` boundary (see D-03). | autoplan P2 |
| E3 | ACCEPT: attention accounting — instrument human-attention minutes directly. | autoplan P1 |
| E4 | ACCEPT: semantic risk signals beyond path globs. | autoplan P1 (scope expansion) |
| E5 | ACCEPT: escalation quality as first-class output. | autoplan P1 |
| E6 | ACCEPT: provider-parity conformance suite. | autoplan P1 (scope expansion) |

## A.1 Critical gaps (fail-open defects)

Each of these lets a run reach `MERGE_READY` on evidence that is not real,
contradicting the verification contract at prd.md:71.

| ID | Gap | Fix |
|---|---|---|
| G-01 | **Agent-run tests vs orchestrator-run verification are conflated.** Worker owns "running permitted local development commands" (prd.md:569); orchestrator owns "verification execution" (prd.md:558). Same commands, different trust. An agent that stubs a test can satisfy the coverage contract. | Verification MUST re-execute the full resolved manifest in the orchestrator, in a clean checkout of the candidate commit, ignoring any result the agent reports. Agent test runs are advisory telemetry only, never coverage evidence. |
| G-02 | **`CheckFreshnessError` unrescued.** prd.md:761 asks "did they run against the exact candidate commit?" but specifies no mechanism. | Record `commit_sha` at check *start* AND *end*; re-read `git rev-parse HEAD` after each check; any mismatch invalidates the result. Worktree must be locked against agent writes during verification. |
| G-03 | **`CheckNeverReportedError` unrescued — CI_WAIT hangs forever.** GitHub returns required contexts that never report when path filters skip the workflow (prd.md:959-961). | Classify each required context after a bounded wait: reported / skipped-by-path-filter / never-scheduled. Path-filtered contexts resolve as satisfied only if GitHub itself reports them neutral/skipped. Hard wall-clock ceiling then escalate. |
| G-04 | **`MergeQueueContextError` unrescued.** Merge queue re-runs checks under the `merge_group` event with different check names; local check IDs will not match queue check IDs (prd.md:961). | Maintain an explicit mapping from local check id -> GitHub context name -> merge_group context name. Fail closed when the mapping is incomplete. |
| G-05 | **`SandboxUnavailableError` unrescued — silent downgrade.** `bwrap` fails where unprivileged user namespaces are disabled (Docker, many CI runners); Seatbelt profiles can be rejected. Config treats sandbox as a setting (prd.md:311-315) and the text hedges "where available". | Sandbox is non-optional. `runmill doctor` probes `bwrap --dev-bind / / true` / a minimal seatbelt profile and FAILS (not warns). No run starts without verified isolation. The credential table's "None" worker-visibility claims (prd.md:991-999) are false until this holds. |
| G-06 | **`ProviderProtocolError` unrescued.** prd.md:624 says unknown output "must fail closed" but no schema-version negotiation is specified. | Version-pin the adapter, validate every event against a schema, quarantine the run on an unknown discriminant. Never best-effort parse. |
| G-07 | **`WorktreeCollisionError` unrescued.** A crashed run leaves a worktree; the next run with the same issue collides. | Reconcile worktrees against SQLite `runs` on startup; adopt or garbage-collect with `git worktree prune`. |
| G-08 | **`ReviewSchemaError` unrescued.** Review returns model-authored JSON (prd.md:812-833) with no validation path. | Schema-validate; on failure retry once with a repair prompt, then escalate. A malformed review is never a passing review. |
| G-09 | **`fail_on_skipped_check: true` is unimplementable as written** (prd.md:327). Every real suite has legitimate skips (platform guards, optional integrations). Unqualified, this gate never opens. | Distinguish *declared* skips (an allowlist in `.runmill/checks.yaml`, matched by test id) from *undeclared* skips. Fail closed only on undeclared. |
| G-10 | **Ambient credential leakage.** The design reuses local authenticated `gh`, and the worker subprocess inherits an environment containing `~/.aws`, SSH agent socket, `~/.config`, `GH_TOKEN`. | Spawn the worker with an explicit allowlisted env (deny-by-default), no SSH agent forwarding, no keychain socket. Test it: a fixture task that attempts `gh auth status` inside the sandbox must fail. |

## A.2 High findings

| ID | Finding | Fix |
|---|---|---|
| H-01 | **Distribution entirely unspecified.** No npm vs single binary decision, no platform matrix, no publish pipeline. | Decide now: npm package + `bun build --compile` single binaries for darwin-arm64/darwin-x64/linux-x64/linux-arm64, published by CI on tag, plus Homebrew tap. |
| H-02 | **Lease authority ambiguous** — lives in both SQLite and the Linear comment (prd.md:410-443) with no stated winner. | External system is authoritative; SQLite is a cache. Always re-read external state before acting. |
| H-03 | **Adapter specced against CLIs when both providers ship first-party TypeScript SDKs** (prd.md:246-248). Subprocess + JSON-stream parsing is the fragility the PRD's own risk table names. | SDK-first (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`); CLI runner as fallback behind the same interface. |
| H-04 | **Setup cost never modeled.** ~60-key `runmill.yaml` + checks manifest + two review skills + risk rules before the first PR. | Zero-config first run: `runmill run ENG-123` works on a fresh repo by inferring checks and risk. Config overrides inferences, never enables the product. |
| H-05 | **Risk tier distribution unmeasured.** If 60%+ of issues land Medium/High, nearly every run escalates. | Two-hour validation: classify 100 historical merged PRs against the proposed rules; publish the distribution before building the risk engine. |
| H-06 | **North-star metric unmeasurable** — nobody instruments attention-minutes (prd.md:1040). | Ship E3 (attention accounting) in the same phase as the metric. Add an operable proxy: issues merged without the human opening the diff. |
| H-07 | **Prior art not searched.** Cyrus (open source) already implements Linear -> worktree -> headless Claude Code -> PR. Global rules mandate `gh search repos` / `gh search code` before net-new code. | Read it before writing the worktree + adapter layer. Adopt or explicitly reject with a reason. |
| H-08 | **Every `citeturn...` marker in the PRD is a dead token.** Citations unverifiable as written. | Replace with real URLs or delete. |
| H-09 | **No auto-revert path** for a bad merged PR (prd.md:1295 says only "revert monitoring"). | Define the detection signal and the revert procedure; make it part of the run lifecycle, not a manual afterthought. |
| H-10 | **Linear issue edited mid-run detected how?** prd.md:1027 requires pause-and-regenerate; prd.md:408 discourages polling. | Snapshot hash of issue title/description/labels/state; re-read and compare at every safe checkpoint. |

## A.3 Error & Rescue Registry

See the full 25-row map in the review transcript. Summary: 25 failure modes
identified against the PRD's 13. 7 unrescued, 5 of them critical (G-02..G-06).

## A.4 Failure Modes Registry

```
 CODEPATH                | FAILURE MODE            | RESCUED? | TEST? | USER SEES? | LOGGED?
 ------------------------|-------------------------|----------|-------|------------|--------
 VerificationEngine      | stale commit result     | N        | N     | Silent     | N   *** CRITICAL GAP
 GitHubAdapter#waitCI    | check never reports     | N        | N     | Silent     | N   *** CRITICAL GAP
 GitHubAdapter#merge     | merge_group name skew   | N        | N     | Silent     | N   *** CRITICAL GAP
 WorkspaceManager        | sandbox unavailable     | N        | N     | Silent     | N   *** CRITICAL GAP
 CodingAgentAdapter      | unknown event shape     | N        | N     | Silent     | N   *** CRITICAL GAP
 WorkspaceManager        | worktree collision      | N        | N     | Crash      | Y
 ReviewLoop              | malformed review JSON   | N        | N     | Crash      | Y
 BacklogAdapter#claim    | ambiguous mutation      | Y        | N     | Escalation | Y
 VerificationEngine      | undeclared skip         | Y        | N     | Message    | Y
 CodingAgentAdapter      | budget exceeded         | Y        | N     | Message    | Y
```

Any row with RESCUED=N and USER SEES=Silent is a **CRITICAL GAP**. Five present.

## A.5 NOT in scope

Nothing was cut. User directive is build-it-all. Items previously proposed for
deferral (E4 semantic risk signals, E6 provider-parity conformance suite) were
pulled back into scope under SCOPE EXPANSION mode.

Genuinely out of scope (unchanged from prd.md:1270-1279): live self-modification
of protected controls, parallel issue execution in one worktree, cross-repository
transactions, model fine-tuning, automatic policy promotion.

## A.6 What already exists

| Sub-problem | Reuse | Status in PRD |
|---|---|---|
| Linear read/mutate | `@linear/sdk` | Named, correct |
| GitHub PR/CI/merge | Octokit + `gh` | Named, correct |
| Worktree isolation | raw `git worktree` | Named, correct |
| Sandbox | Seatbelt (macOS) / bubblewrap (Linux) | D-02; PRD said `container` |
| Persistent state | `better-sqlite3` | Named, correct |
| Provider adapters | first-party TS SDKs | H-03: PRD specs CLI parsing instead |
| End-to-end Linear->worktree->Claude Code->PR | Cyrus (open source) | H-07: not searched |

## A.7 Dream state delta

Full build closes the execution loop and the governance loop. The remaining gap
at 12 months is the intake funnel: turning ambiguous intent into an executable,
verifiable contract. E1 (readiness scorer) is the first move toward it and is
now in scope.

## A.8 Eng review — Codex voice (26 defects)

Architecture-scoped review. Scope was fixed; no scope-cut arguments accepted.

### Critical (must fix before implementation)

| ID | Defect | Line | Fix |
|---|---|---|---|
| C-01 | Claim protocol provides no mutual exclusion. No compare-and-set, no unique remote lock, no fencing token. Two processes can both transition state, assign the bot, and add markers. FR-04 unguaranteeable. | 411-428 | Authoritative claim record + deterministic ownership rule + monotonic fencing generation, validated immediately before EVERY external mutation (push, PR create, enqueue, merge, backlog completion). State plainly that multi-host exclusivity is impossible via local SQLite alone. |
| C-02 | Local persistence happens AFTER the backlog mutations. Crash between marker-write and persist leaves an externally claimed issue with no durable local run. | 418-428 | Commit local run + lease + `PREPARED` side-effect intent BEFORE the first remote mutation. Each remote step gets SENT/CONFIRMED status, reconciliation predicate, and remote ID. |
| C-03 | Lease expiry has neither safety nor liveness semantics. Absence of a previous run cannot be established during crash or partition -> deadlock or split-brain. Renewal only at checkpoints guarantees expiry during long IMPLEMENTING / CI_WAIT / MERGE_QUEUED. | 444 | Define lease duration, renewal margin, authoritative clock, tolerated skew, heartbeat during long waits, atomic owner validation on renewal. |
| C-04 | State machine cannot represent `pr-only`, which is the default autonomy mode. Every success path runs through MERGE_READY -> MERGE_QUEUED -> MERGED. | 469-487 vs 192-199 | Add terminal `PR_DELIVERED`. Also add PAUSED, AWAITING_APPROVAL, PR_CLOSED, PR_SUPERSEDED, QUEUE_EJECTED, CLEANUP_FAILED. Define lease-hold policy for each. |
| C-05 | `commit_sha` does not prove freshness. A verifier can run tests in a dirty worktree and record HEAD. The task packet explicitly permits this via `require_clean_git_status: false`. | 762 + 664-669 | Materialize candidate as a commit; verify in an immutable checkout of that commit; capture tree identity before AND after each command; lock the worktree against provider writes during checks. |
| C-06 | Git worktrees violate the stated filesystem boundary. A worktree `.git` file points into the main repo's shared git dir, so git operations need access outside the run worktree, exposing shared refs, hooks, config, and other worktrees. | 723 + 1004-1005 | Isolate git metadata per run (separate clone or `--separate-git-dir`), OR route all git mutations through a trusted broker outside the sandbox. |
| C-07 | Provider auth and network isolation conflict. Provider needs network + credentials; worker commands must have neither. One sandbox boundary means shell tools inherit provider authority. | 574 + 996 | Privileged provider transport broker, separated from sandboxed tool execution. |
| C-08 | `permission.requested` has no request ID and the adapter interface has no approve/deny operation. A provider awaiting permission deadlocks forever. | 618 | Add request ID, scope, expiry; add `respondToPermission()` to the interface; add a resolution event. |
| C-09 | No `schema_version` / `user_version`, no migration locking, no min/max readable schema. Blocks stated upgrade-safety and deterministic-recovery requirements. | 710 | Forward-only migrations behind a cross-process lock; refuse to run mixed daemon/CLI binaries against incompatible schemas. |
| C-10 | Artifacts and DB rows cannot be committed atomically. Crash leaves a committed row pointing at a missing or truncated file. | 677-712 | temp file -> hash -> fsync -> atomic rename -> short DB transaction. Recovery GCs orphans and rejects hash mismatches. |

### High

| ID | Defect | Line |
|---|---|---|
| H-11 | `fail_on_skipped_check` not implementable from an integer `skipped_tests`. Cannot distinguish platform guard / committed `.skip` / zero-tests-selected / missing shard / framework that does not report. Some frameworks exit 0 after discovering nothing. | 325-340, 779-794 |
| H-12 | Check discovery has no freeze or recompute rule. A fixer adding a migration or touching CI config after manifest resolution keeps stale results. | 767-777 |
| H-13 | Result schema cannot prove coverage: no attempt number, parser version, discovered-vs-executed test identities, matrix cells, timeout/signal/cancel distinction, environment identity, trusted executor identity, input tree hash. | 779-794 |
| H-14 | Path-filtered required checks wait forever; no terminal classification for an absent context. | 731, 950-960 |
| H-15 | Local check IDs, GitHub contexts, and workflow job names are three namespaces treated as one. Required checks can be scoped to an expected App ID. A similarly-named untrusted status can satisfy reconciliation. | 783, 951 |
| H-16 | Merge-queue reconciliation underspecified. Merge-group SHA changes on rebuild; earlier results must be invalidated. Eviction, base advancement, conflict, timeout, manual dequeue need explicit transitions. Rulesets must be rediscovered at enqueue AND immediately before merge. | 962 |
| H-17 | `start()` exposes only an iterator. Provider stalling before `session.started` leaves no session ID to cancel. No AbortSignal, process handle, or startup ack. `normalizeExit` relationship to iterator completion undefined. | 580-591 |
| H-18 | Events have no event ID, provider sequence, timestamp, run/session ID, role, or attempt. Tool/command events lack call IDs. Replay after crash duplicates usage, commands, and audit entries, contradicting FR-08. | 607-620, 725 |
| H-19 | Terminal and usage semantics undefined: exactly-one-result? iterator completion without result = failure? events after result? usage cumulative or delta? token categories? model version for costing? | 619-620 |
| H-20 | Normalized telemetry too weak for enforcement. `file.changed` has no operation or before/after hash and misses changes made outside provider instrumentation. `command.*` omits cwd, env-policy hash, pid, timeout, and cannot distinguish signal / timeout / cancel / sandbox-denial. Policy must use supervisor-observed process and git state, not provider-reported events. | 615-617 |
| H-21 | Seatbelt and bubblewrap profiles are nowhere specified. No fallback, no capability probe, no failure policy. | 312-316, 1002-1012, 1307 |
| H-22 | bubblewrap needs mount/user namespaces (commonly disabled; blocked in nested Docker/K8s) AND provides no process/CPU/memory/IO limits. prd.md:1007-1010 requires those -> needs cgroups + supervisor. | 1007-1010 |
| H-23 | Seatbelt provides none of the assumed container semantics: no namespaces, no cgroups, no resource limits, no process-tree cleanup, no network restriction. `network: restricted` has no Seatbelt equivalent to bwrap netns. macOS and Linux therefore have materially different isolation guarantees despite both being first-class. | 745, 1002-1012 |
| H-24 | Table list is a field list, not a schema: no keys, FKs, indexes, transaction boundaries. Needs unique(issue_id) active lease, unique side-effect idempotency key, unique(run_id, sequence), optimistic version guard on transitions. FK enforcement must be enabled per connection. | 697-710 |
| H-25 | No SQLite runtime protocol: WAL, busy_timeout, BEGIN IMMEDIATE writers, checkpoint policy, synchronous level, integrity checks, file permissions, prohibition on network/cloud-synced filesystems. Concurrent `runmill status` against a running daemon produces SQLITE_BUSY. | 697-710 |

### Crash-behavior gaps by state

Every state below has unspecified crash semantics (prd.md:1022 covers none of them):

DISCOVERED/ELIGIBILITY_CHECKED (no durable selection epoch) · CLAIMED (partial remote mutation)
· WORKSPACE_READY (partial branch/worktree; retry collides) · TASK_PACKET_READY (no atomic
write/checksum; truncated packet on resume) · IMPLEMENTING (orphaned provider child becomes a
concurrent writer) · LOCAL_VERIFY (check process outlives orchestrator; partial output read as
complete) · LOCAL_REVIEW (result emitted but not persisted) · FIXING/PR_FIXING (uncommitted
partial edits; prior verification not invalidated) · PR_READY/PR_OPEN (commit+push+PR collapsed;
duplicate branches/PRs) · CI_WAIT (no durable observation cursor, expected-check snapshot, or
head-change invalidation) · PR_REVIEW (PR head can change mid-review; no compare-before-commit
guard) · MERGE_READY (no atomic merge-time revalidation) · MERGE_QUEUED (ambiguous admission;
rebuild/eject/cancel) · MERGED (GitHub merged while local says queued) · LINEAR_UPDATED (four
effects, partially applied) · CLEANUP (no inventory or retry semantics) · exception states (no
outgoing edges; RETRY_WAIT does not record return state).

**Required artifact:** a transition table with source, target, guard, durable inputs, side effect,
idempotency key, reconciliation operation, compensation, and retry classification for every edge.
"Each transition must be idempotent" (prd.md:499) is an assertion, not an implementation contract.

## A.9 DX review — Codex voice

Central defect: **the PRD describes what runmill knows, not what the developer sees or does next.**
Consistent across onboarding, errors, escalation, and doctor.

### Setup-flow contradictions (fix first — cheap and high impact)

| # | Contradiction | Lines | Developer experience |
|---|---|---|---|
| X-01 | `init` claims it writes only `runmill.yaml`, but config references `.runmill/checks.yaml` and two review skill files. Nothing creates them. | 238 vs 325, 342 | First run fails on missing files |
| X-02 | Setup selects `pr-only`; generated config has NO autonomy field and shows `merge.mode: guarded`. | 231 vs 301 | Choice appears not preserved, or contradicted |
| X-03 | Setup never asks about labels; sample config requires `agent-ready`. | 284 | **A correctly configured first run reports zero eligible issues.** Worst possible first-run outcome |
| X-04 | Discovered checks printed but never approved/edited/tested. `verification.commands` and the manifest are two sources of truth. | 233, 325 | Silent divergence between declared and executed checks |

### TTHW

12 user-visible steps minimum (prd.md:206-240), assuming provider + `gh` pre-authed, no doctor
remediation, correct inferred checks. Benchmark: >10 min = red flag tier. FR-01 (prd.md:716) only
requires "no manual JSON editing" — there is no timed onboarding acceptance criterion.

**Add:** timed onboarding test — fresh supported machine, existing repo, one prepared issue,
median interactive setup under 5 minutes, zero hand-edited files.

### CLI defects

- `retry --from review` is ambiguous between LOCAL_REVIEW and PR_REVIEW (prd.md:267)
- `pause` is global; every other lifecycle command needs a run ID. Should default to the sole active run
- `next --dry-run` redundant; `daemon` lifecycle unspecified; `abort` lease policy has no preview
- `inspect` "opens" artifacts without saying terminal / pager / browser / path

**Missing commands:** `auth status|login|logout` (error remediation depends on it), **`export`
(FR-20 at prd.md:737 requires audit export and no command exists)**, `config show|validate|edit`,
`runs list`, `resolve`/`approve` for NEEDS_HUMAN, `daemon start|stop|restart`, `prepare` (E1),
global `--json --quiet --verbose --no-color` + non-interactive flags + defined exit codes.

### NEEDS_HUMAN is a state name, not an interaction

One sentence at prd.md:490. FR-18 (prd.md:735) and `status` (prd.md:261) make promises nothing
connects. Unspecified: daemon notification, listing waiting decisions, submitting an answer,
whether editing the issue IS the answer, whether `resume` accepts NEEDS_HUMAN, lease-hold during
wait, timeout behavior, packet regeneration after clarification.

**Required:** every escalation emits a durable machine-readable decision request containing run,
issue, stage, stable reason code, evidence, preserved work, ONE decision-shaped question, allowed
responses, consequences, expiry, and the exact continuation command.

### Error message contract (none exists today)

Target shape:

```text
RM-AUTH-003 Linear credential expired
Account: miki@example.com
Required access: read issues, update issue state, create comments
Fix: runmill auth login linear
Then: runmill doctor --check linear
```

Stable code + identity + required scope + exact remediation + exact verification.
Apply to all 25 failure modes in the Error & Rescue Registry (A.3).

### Config: infer, do not configure

Infer from environment: repository (`git remote`), base branch (remote HEAD), merge method /
queue / required checks / rulesets (GitHub API), check commands (`package.json` + CI workflows,
shown for confirmation), context files (`AGENTS.md`, `README`), risk policy seed (rulesets +
`CODEOWNERS`), **sandbox implementation (OS + doctor probe, never a first-run question)**.
Ship built-in review policies; repo files become optional overrides.
Add `runmill config validate`, a documented schema, precedence rules, env overrides, deprecations.

### doctor output contract (unspecified)

Needs PASS/WARN/FAIL, stable diagnostic codes, observed vs expected, exact remediation commands,
redaction, `--json`, scoped reruns (`--check linear`), nonzero exit on blocking failure.
Sandbox probes must be positive AND negative: allowed worktree write, denied external write,
denied keychain access, enforced network policy.

### First-time docs — none planned

The only documentation plan is the behavior handbook "after the MVP stabilizes" (prd.md:1190),
whose entries emphasize source files and state transitions (prd.md:1223) — maintainer docs, not
onboarding. Missing: 5-minute quickstart with prerequisites, supported version matrix, required
Linear/GitHub permissions, "prepare your first issue" guide, repo-readiness guidance (monorepo,
submodules, LFS, generated code), explanation of every file `init` creates, full config reference,
first-run walkthrough, Ctrl-C/crash/pause/abort behavior, error-code catalog, upgrade/reset/
uninstall/credential-rotation, and source-transmission + retention + cost + privacy expectations.

## A.10 Eng review — Claude voice + cross-model consensus

### Cross-model CONFIRMED (both Claude and Codex found independently)

Highest-confidence findings in the entire review. Two models, no shared context.

| # | Confirmed defect | Claude | Codex |
|---|---|---|---|
| CM-01 | Git worktrees share the parent `.git`; FR-06 isolation and the sandbox model are both false as written | 1.1 | 19 |
| CM-02 | Claim protocol has no mutual exclusion, no CAS, no tiebreak. Both racers conclude they own the issue | 3.1 | 1 |
| CM-03 | Local lease persisted AFTER the remote mutation; a crash between orphans the issue permanently | 3.3 | 2 |
| CM-04 | `skipped_tests` unobtainable from a shell exit code; `fail_on_skipped_check` is decorative | 4.3, 4.4 | 6 |
| CM-05 | `commit_sha` is self-reported; freshness unproven; dirty worktree passes | 4.1 | 7 |
| CM-06 | Path-filtered required checks never report; every run hangs in CI_WAIT until budget death | 5.1 | 10 |
| CM-07 | `merge_group` check-name mismatch ejects PRs; local IDs vs contexts vs job names are three namespaces | 5.3 | 11, 12 |
| CM-08 | Cancellation impossible before `session.started`; no AbortSignal or process handle | 6.1 | 13 |
| CM-09 | `permission.requested` is undeliverable — AsyncIterable has no reverse channel, no approve/deny op | 6.4 | 15 |
| CM-10 | Lease TTL has no liveness/heartbeat semantics; renewal at checkpoints guarantees expiry mid-work | 3.2, 3.4 | 3 |
| CM-11 | No `user_version`, no migration lock, no downgrade story | 7.1 | 26 |
| CM-12 | No WAL / busy_timeout / writer discipline; concurrent `status` vs daemon breaks | 7.2 | 24, 25 |
| CM-13 | State machine missing states; no terminal for `pr-only`; no dequeue from MERGE_QUEUED | 2.8, 2.4 | 5 |
| CM-14 | Seatbelt/bubblewrap profiles unspecified; `network: restricted` not expressible in either | 8.1, 8.2 | 18, 20, 21 |
| CM-15 | No test plan; fakes for Linear/GitHub are the enabling investment | 9.1 | (implied) |

### Claude-only CRITICAL findings (Codex missed these)

| ID | Finding | Line |
|---|---|---|
| CL-01 | **Check execution is unsandboxed and runs agent-modified code with orchestrator privileges.** `npm run typecheck` resolves through `package.json` scripts, `node_modules/.bin`, and lifecycle hooks the agent just edited. The likely implementation (`execa` from the orchestrator inheriting `process.env`) hands the Linear key and GitHub token to the agent's diff on the first run. | 325-340, 550-563 |
| CL-02 | **"Agent-proposed additional checks" is a remote-code-execution primitive.** Checks are shell strings the orchestrator executes. Fix: agent-proposed checks are IDENTIFIERS referencing manifest-declared commands from the base commit, never free-form shell. | 775 |
| CL-03 | **The review channel, not the credential boundary, is the real privilege boundary.** Injected text in an issue, copied by the implementer into a code comment, reaches a reviewer whose approval releases code to main. No credential involved. Worse: the PR reviewer receives "relevant comments" — in a public repo, from anyone who can comment. Unauthenticated external input to the merge decision. | 574, 916, 1014 |
| CL-04 | **`runmill.yaml` location unspecified.** If it lives in the repo, the agent (or any inbound PR) can edit autonomy mode, budgets, and risk rules. Same for context entry files: `AGENTS.md` is read into every prompt, so a merged PR modifying it is persistent injection into all future runs. | 238, 375-383, 319-321 |
| CL-05 | **The merge credential can probably disable the governance governing it.** `gh`'s OAuth token typically carries broad scopes. If it can edit branch protection or is a ruleset bypass actor, "0 merges bypassing protection" is unverifiable. Fix: GitHub App token with `contents:write` + `pull_requests:write` and explicitly NOT `administration`; doctor asserts it CANNOT write branch protection. | 929-938, 1071 |
| CL-06 | **Ambient credential channels beyond env vars.** `~/.gitconfig` `credential.helper` -> `git push` silently uses the user's token; `~/.config/gh/hosts.yml`, `~/.npmrc` `_authToken`, `~/.netrc`, `~/.git-credentials` in plaintext. **`NODE_OPTIONS` force-loads a script into every node process including the check runner.** Also `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `PYTHONSTARTUP`, `PATH` shadowing. And `~/.claude/.credentials.json` / `~/.codex/auth.json` must be readable for the provider to work at all -> the agent can exfiltrate its own provider token. | 1008, 1012 |
| CL-07 | **`branch_template` is per-issue, not per-run, contradicting FR-06.** A second run (retry, or steal after lease expiry) collides with the first run's branch; GitHub rejects a duplicate PR for the same head/base with 422, so runmill **silently adopts the previous run's PR** — inheriting its reviews, CI history, and a head it did not produce. | 304, 723 |
| CL-08 | **Nobody owns `git commit` and `git push`.** Neither the worker's nor the orchestrator's responsibility list includes them. With `require_clean_git_status: false`, something must decide what to stage; `clean_untracked_files: true` would delete newly created source files. | 550-572, 665 |
| CL-09 | **Label-add authority becomes code-execution authority.** Anyone who can add `agent-ready` in Linear can cause autonomous code changes against a production repo. Most teams have never treated Linear label permissions as a security control. | 292, 398 |
| CL-10 | **Nesting contradiction at line 623.** Codex and Claude Code each run their own sandbox. Seatbelt profiles do not usefully nest. The workaround is passing provider bypass flags — which line 623 explicitly forbids "in a non-ephemeral host environment," which is exactly what a laptop is. **Requires an explicit decision: one enforcement layer per platform.** | 623, 1002-1012 |
| CL-11 | **`allowed_paths` / `forbidden_paths` have no enforcement mechanism.** They live in `task.json`, which is prompt input — advisory text. The claim that the worker "cannot independently widen its authority" rests entirely on them. | 71, 654-656 |

### Configuration contradictions in the document (cheap to fix now)

| Line(s) | Contradiction |
|---|---|
| 347 + 373 | `max_fix_iterations: 3` with `max_agent_invocations: 8`. Implementer(1) + local review(1) + 3x(fix+re-review)(6) = 8. **The default config exhausts its own budget before reaching PR_REVIEW.** |
| 282 + 370 | `timeout_minutes: 120` x 8 invocations = 16 hours against `max_wall_minutes_per_issue: 240`. Per-invocation timeout must clamp to remaining run budget. |
| 316 | `clean_untracked_files: true` deletes newly created source files if applied mid-run. Scope to teardown only. |
| 302 vs 227/395 | Config has a single `github.repository`; init describes team->repo mapping and eligibility requires "unambiguous repository mapping." The mapping structure does not exist in the config model. |
| 397 | "dependencies not known to be blocked" requires traversing Linear relations + sub-issues — paginated N+1 against a complexity-budgeted API. Rate limits bite during eligibility, not during the run. |
| 403 | Linear priority 0 = no priority, 1 = urgent. The sort key must map 0 -> +infinity. Caught for filtering at 243, not restated in the ordering rule. |
| 746 | "below five seconds per state transition" is both meaningless (CI_WAIT is network-bound) and far too lax (a local transition should be milliseconds). Restate as orchestrator CPU per transition, excluding I/O. |

## A.11 DX review — Claude voice + cross-model consensus

**Overall DX score: 2.6 / 10.** In 1,490 lines: one rendered CLI screen, zero error messages,
zero happy-path terminal output, zero documentation deliverables. Appendix A's own failure
registry has a column titled `USER SEES?` with the value `Silent` in five rows — the plan
diagnoses its own DX gap and does not close it.

| Dimension | Score | Cross-model |
|---|---:|---|
| 1. Getting started (TTHW 35-60 min vs <5 min target) | 3/10 | CONFIRMED |
| 2. CLI ergonomics (best part of the plan) | 6/10 | CONFIRMED |
| 3. Error messages | 2/10 | CONFIRMED |
| 4. Documentation & learning | 2/10 | CONFIRMED |
| 5. Upgrade path | 2/10 | CONFIRMED |
| 6. Developer environment | 3/10 | CONFIRMED |
| 7. Community & ecosystem | 2/10 | Claude only |
| 8. DX measurement | 1/10 | Claude only |

### Real TTHW: 35-60 minutes of human keyboard time

`init` covers ~12 of ~70 config keys. The rest surface at runtime. Hidden steps: create the
`agent-ready` label (never mentioned in init), author `.runmill/checks.yaml` (~10 min, no schema,
no example), author two review skill markdown files (~25 min, contract completely unspecified),
hand-edit budgets/risk/sandbox/context into `runmill.yaml` (~10 min), then hit a **mandatory
sandbox probe failure whose profiles are nowhere specified**.

### Claude-only DX findings

| ID | Finding |
|---|---|
| DX-19 | **`network: restricted` is silently a no-op on macOS.** Seatbelt has no netns equivalent. The same `runmill.yaml` means two different security postures on two platforms both declared first-class (prd.md:745), on the primary platform for the target persona. Fix: doctor prints a per-platform isolation matrix; requesting an unenforceable control is an ERROR, with `workspace.allow_unenforced: [network]` as a knowing opt-in. |
| DX-20 | **CI usage is effectively impossible as designed.** No `--non-interactive`, `init` is interactive-only, no `RUNMILL_*` env config path, no documented exit codes, credentials live in an OS keychain that doesn't exist on a CI runner, and bubblewrap fails on many runners. The plan neither says CI is unsupported nor how to support it. |
| DX-03 | **No cost answer at the moment of maximum anxiety.** `budgets` is not collected by init. The first run executes with no cap or an unspecified default, on a 240-minute leash. The loudest question before typing `runmill run` on your own repo is "what will this cost me," and the interface never answers it. |
| DX-23 | **No license, no OSS/closed decision.** The word "license" does not appear. For a local-first CLI with access to your code, "can I read the source" is a gating trust question. |
| DX-24 | **Review skills ARE the extension surface and are specified as two file paths.** They encode team-specific engineering judgment, vary most between repos, and are the primary artifact the harness improvement loop proposes changes to (prd.md:1168-1170). Fix: frontmatter (name, version, applies_to, severity_map), documented interpolation set, `runmill skills list|eject|validate`, resolution order (built-in -> package -> repo). Then they are versionable, diffable, distributable, and hash-trackable in `harness_versions` — which the plan already wants but cannot do against an unstructured blob. |
| DX-22 | **Cheapest win missed: no JSON Schema for `runmill.yaml`.** ~70 keys, no schema means no autocomplete, no inline validation, no hover docs. Publishing `runmill.schema.json` + emitting a `# yaml-language-server: $schema=` header from init is ~1 day and removes an entire error class. |
| DX-26 | **TTHW cannot be measured.** No init-funnel instrumentation, no record of which doctor checks fail most, no first-run success/abandonment rate, and no telemetry decision at all (opt-in vs opt-out vs none — for a security-conscious local-first tool this must be explicit). Fix: local-only funnel in SQLite + `runmill doctor --report` producing one shareable bundle that is simultaneously the support channel, the DX dataset, and the bug-report format. |

### The single highest-leverage DX fix (both voices converge here)

**Ship the defaults instead of the config.** Make `runmill.yaml` an override file a developer
never has to create, and validate every path in it eagerly at `doctor` rather than lazily at
point-of-use.

1. Every one of the ~70 keys gets a documented default. Both review skills and a check manifest
   ship IN THE PACKAGE, inferred from the repo when absent. `runmill skills eject` /
   `runmill config eject` write them out for customization.
2. `init` writes only what it cannot infer — roughly six keys — and prints the resolved rest.
3. `doctor` resolves and validates every referenced file, credential, label, and platform
   capability BEFORE any run starts. Nothing config-shaped may fail after the first dollar is spent.

Proposed new functional requirement:
**FR-21: `runmill run ENG-123` succeeds on a fresh clone with no `runmill.yaml` present.**

Why this one: it is the only fix that moves TTHW from ~45 min to under 5; it eliminates an entire
error class rather than improving its messages (dying at LOCAL_REVIEW on a missing file, 20 min
and real spend into a run, stops existing); it creates the extension surface for free; and it is
the prerequisite for docs, schema, error codes, and onboarding telemetry.

## A.12 Cross-phase themes

Concerns that surfaced independently in 2+ phases. Highest-confidence signal in the review.

**Theme 1: the PRD specifies the machine, never the human.** CEO (setup cost never modeled),
Eng (crash behavior undefined for all 20 states), DX (stated as the central defect). One rendered
CLI screen in 1,490 lines; zero error messages.

**Theme 2: verification fails open, not closed.** CEO Section 2 (5 unrescued critical gaps), Eng
(both voices, CM-04/CM-05/CM-06), DX (five rows rated `USER SEES? Silent`). Every instance lets a
run reach MERGE_READY on evidence that is not real — contradicting prd.md:71.

**Theme 3: the sandbox claims exceed what the sandbox can do.** CEO F9 (credential table's "None"
unenforced), Eng CM-01/CM-14/CL-01/CL-06 (worktree shares `.git`; check runner unsandboxed;
NODE_OPTIONS), DX DX-19 (`network: restricted` a no-op on macOS). The strongest safety claims in
the document are the least implemented.

## A.13 Final approval decisions

Resolved at the /autoplan approval gate on 2026-08-06.

| ID | Decision | Choice | Consequence |
|---|---|---|---|
| D-05 | Config model | **Explicit config stays as specced (~70 keys).** Cross-model recommendation to invert was reviewed and REJECTED by the user. Nothing inferred silently; governance rules stay human-authored. | T13 changes shape: config inversion is CUT. Review-skill format specification and eager doctor validation REMAIN (see D-05a). |
| D-05a | Review skill files | Consequence of D-05. `local_review_skill` / `pr_review_skill` (prd.md:343-344) become REQUIRED files a developer authors from nothing. Their format, contract, interpolation variables, and expected output schema MUST be specified in the PRD body. | Blocks first run for every user until specified. |
| D-05b | Config path validation | `doctor` resolves and validates every referenced file, credential, label, and platform capability BEFORE any run starts. Orthogonal to inference. | Kills the LOCAL_REVIEW-after-spend failure without inferring anything. |
| D-06 | Sandbox nesting | **runmill's sandbox is the single enforcement layer.** Provider runs with its own sandboxing disabled, inside Seatbelt (macOS) / bubblewrap (Linux). | prd.md:623 MUST be rewritten: provider bypass flags are permitted only when runmill's own verified sandbox is active. `doctor` positively tests escape attempts (forbidden write, forbidden read of `~/.ssh`, forbidden outbound connection) and FAILS if any succeeds. runmill now owns 100% of the isolation risk. |
| D-07 | Lease primitive | **Git ref is the authoritative lock.** `git push origin <sha>:refs/runmill/leases/<issue>` — atomic server-side ref creation, non-fast-forward rejected. Heartbeats are ref updates. Fencing generation derives from ref history. | Linear comment becomes human-visible status ONLY, never authoritative. Supersedes the claim protocol at prd.md:410-444 entirely. Requires ref cleanup on release and a `runmill gc` path for abandoned lease refs. Resolves CM-02, CM-10, and unblocks FR-04. |

### Revised P1 task list after gate decisions

- T1  WorkspaceManager — git isolation model (separate clone or `--separate-git-dir`) + `core.hooksPath=/dev/null`   [CM-01]
- T2  VerificationEngine — sandboxed check runner, allowlisted env, structured result only                          [CL-01]
- T3  Persistence — `side_effects` becomes a write-ahead outbox with per-operation `reconcile()`                     [CM-03]
- T4  BacklogAdapter — **git-ref lease** + monotonic fencing generation validated before every side effect   [D-07, CM-02]
- T5  VerificationEngine — verify in a detached worktree at the candidate SHA; tree hash before and after            [CM-05]
- T6  VerificationEngine — machine-readable check reports + differential baseline test inventory                     [CM-04]
- T7  StateMachine — full transition table (20 states x 4 exception edges) with guards and compensations             [CM-13]
- T8  Sandbox — child env built from empty via allowlist; deny gh/ssh/aws/netrc/git-credentials; scrub NODE_OPTIONS  [CL-06]
- T9  VerificationEngine — agent-proposed checks are identifiers, never shell strings                                [CL-02]
- T10 Config — `runmill.yaml` lives outside the repo; repo policy read from base commit and diffed                   [CL-04]
- T11 GitHubAdapter — branch name carries a run/attempt discriminator                                                [CL-07]
- T12 Testing — fake Linear + GitHub with fault injection, `crashpoint()` hooks, injected `Clock`                    [CM-15]
- T13 DX — **specify the review-skill file format** + eager doctor validation of every config path        [D-05a, D-05b]
- T14 DX — `RunmillError` first-class type + code for all 25 failure modes; no mode may be `USER SEES? Silent`       [DX-12]
- T15 Persistence — `user_version`, migration under cross-process lock, auto-backup, WAL + busy_timeout        [CM-11/12]
- T16 Sandbox — **rewrite prd.md:623**; provider bypass permitted only under a verified runmill sandbox              [D-06]
