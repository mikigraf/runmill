/**
 * Create the test-drive issues in a real Linear workspace.
 *
 *   LINEAR_API_KEY=lin_api_... npx tsx scripts/seed-linear.ts --team RT
 *   npx tsx scripts/seed-linear.ts --list-teams
 *   npx tsx scripts/seed-linear.ts --team RT --dry-run
 *
 * Deliberately conservative about a workspace it does not own:
 *
 *   - It never creates a team, a label, or a workflow state. Those are
 *     structural decisions about someone's workspace.
 *   - It skips any issue whose title already exists in the team, so running it
 *     twice does not produce twenty issues.
 *   - --dry-run prints exactly what would be created and touches nothing.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.linear.app/graphql";

interface Fixture {
  identifier: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = process.env["LINEAR_API_KEY"];
  if (key === undefined || key === "") {
    throw new Error(
      "LINEAR_API_KEY is not set.\n" +
        "  Create a personal API key at https://linear.app/settings/api\n" +
        "  then: export LINEAR_API_KEY=lin_api_...",
    );
  }

  const response = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Linear API returned ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error("Linear API returned no data");
  return body.data;
}

interface Team {
  id: string;
  key: string;
  name: string;
  states: { nodes: { id: string; name: string; type: string }[] };
}

async function listTeams(): Promise<Team[]> {
  const data = await graphql<{ teams: { nodes: Team[] } }>(`
    query {
      teams(first: 50) {
        nodes {
          id
          key
          name
          states(first: 50) { nodes { id name type } }
        }
      }
    }
  `);
  return data.teams.nodes;
}

async function existingTitles(teamId: string): Promise<Set<string>> {
  const data = await graphql<{ issues: { nodes: { title: string }[] } }>(
    `query ($teamId: ID!) {
       issues(first: 250, filter: { team: { id: { eq: $teamId } } }) {
         nodes { title }
       }
     }`,
    { teamId },
  );
  return new Set(data.issues.nodes.map((n) => n.title));
}

async function createIssue(input: {
  teamId: string;
  title: string;
  description: string;
  priority: number;
  stateId?: string | undefined;
  labelIds?: string[] | undefined;
}): Promise<{ identifier: string; url: string }> {
  const data = await graphql<{
    issueCreate: { success: boolean; issue: { identifier: string; url: string } };
  }>(
    `mutation ($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue { identifier url }
       }
     }`,
    { input },
  );
  if (!data.issueCreate.success) throw new Error(`failed to create "${input.title}"`);
  return data.issueCreate.issue;
}

/** Resolve or create the label, so `include_labels: [agent-ready]` matches. */
async function ensureLabel(teamId: string, name: string): Promise<string | undefined> {
  const found = await graphql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
    `query ($teamId: ID!) {
       issueLabels(first: 100, filter: { team: { id: { eq: $teamId } } }) {
         nodes { id name }
       }
     }`,
    { teamId },
  );
  const match = found.issueLabels.nodes.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (match !== undefined) return match.id;

  const created = await graphql<{
    issueLabelCreate: { success: boolean; issueLabel: { id: string } };
  }>(
    `mutation ($input: IssueLabelCreateInput!) {
       issueLabelCreate(input: $input) { success issueLabel { id } }
     }`,
    { input: { teamId, name, color: "#5E6AD2" } },
  );
  return created.issueLabelCreate.success ? created.issueLabelCreate.issueLabel.id : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const dryRun = argv.includes("--dry-run");

  const teams = await listTeams();

  if (argv.includes("--list-teams")) {
    process.stdout.write("Teams in this workspace:\n");
    for (const team of teams) {
      const states = team.states.nodes.map((s) => `${s.name} (${s.type})`).join(", ");
      process.stdout.write(`  ${team.key.padEnd(8)} ${team.name}\n      states: ${states}\n`);
    }
    return;
  }

  const wanted = flag("team");
  if (wanted === undefined) {
    process.stderr.write(
      "Pass --team <KEY>, or --list-teams to see what exists.\n" +
        `Available: ${teams.map((t) => t.key).join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const team = teams.find((t) => t.key.toLowerCase() === wanted.toLowerCase());
  if (team === undefined) {
    process.stderr.write(
      `No team with key "${wanted}".\nAvailable: ${teams.map((t) => t.key).join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const fixtures = JSON.parse(
    readFileSync(join(here, "..", "examples", "testdrive", "issues.json"), "utf8"),
  ) as Fixture[];

  // The state an issue must be in to be eligible. `unstarted` is Linear's
  // "Todo" bucket; picking it by TYPE rather than by name keeps this working in
  // a workspace whose columns are named something else.
  const todo = team.states.nodes.find((s) => s.type === "unstarted") ?? team.states.nodes[0];
  const already = await existingTitles(team.id);

  process.stdout.write(
    `${dryRun ? "Would create" : "Creating"} issues in ${team.key} (${team.name})\n` +
      `  state: ${todo?.name ?? "(default)"}\n\n`,
  );

  const labelId = dryRun ? undefined : await ensureLabel(team.id, "agent-ready");
  let created = 0;
  let skipped = 0;

  for (const fixture of fixtures) {
    if (already.has(fixture.title)) {
      process.stdout.write(`  · skip    ${fixture.title}  (already exists)\n`);
      skipped += 1;
      continue;
    }
    if (dryRun) {
      process.stdout.write(`  + create  ${fixture.title}\n`);
      created += 1;
      continue;
    }

    const issue = await createIssue({
      teamId: team.id,
      title: fixture.title,
      description: fixture.description,
      priority: fixture.priority,
      ...(todo === undefined ? {} : { stateId: todo.id }),
      ...(labelId === undefined ? {} : { labelIds: [labelId] }),
    });
    process.stdout.write(`  ✓ ${issue.identifier.padEnd(8)} ${fixture.title}\n`);
    created += 1;
  }

  process.stdout.write(
    `\n${dryRun ? "Would create" : "Created"} ${created}, skipped ${skipped}.\n`,
  );
  if (!dryRun && created > 0) {
    process.stdout.write(
      `\nNext:\n` +
        `  runmill init\n` +
        `  # set backlog.team: ${team.key} and claim_state/delivered_state to real column names\n` +
        `  runmill next --dry-run\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
