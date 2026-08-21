/**
 * The documentation contract.
 *
 * Prose rots faster than code because nothing fails when it does. These tests
 * give the docs the same guard the error catalog got: every command they tell a
 * developer to run must exist, every link must resolve, and every source file
 * they cite must be there. A doc that confidently describes a flag removed two
 * releases ago is worse than no doc — it costs a debugging session before the
 * developer concludes the documentation is lying.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { buildProgram } from "../../src/cli/main.js";
import { ERROR_CATALOG } from "../../src/errors/runmill-error.js";
import { parseConfig } from "../../src/config/load.js";
import type { Command } from "commander";

const DOCS_DIR = "docs";

function commandPaths(program: Command): Set<string> {
  const paths = new Set<string>();
  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const path = prefix === "" ? sub.name() : `${prefix} ${sub.name()}`;
      paths.add(path);
      walk(sub, path);
    }
  };
  walk(program, "");
  return paths;
}

const program = buildProgram();
const COMMANDS = commandPaths(program);
const ROOT_OPTIONS = new Set(program.options.map((o) => o.long ?? ""));

const docFiles = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => join(DOCS_DIR, f));

const CONCEPT_DOCS = [
  "docs/verification.md",
  "docs/leases.md",
  "docs/autonomy.md",
  "docs/sandbox.md",
  "docs/lifecycle.md",
  "docs/configuration.md",
  "docs/README.md",
];

describe("the documentation set", () => {
  it.each(CONCEPT_DOCS)("%s exists and is substantive", (path) => {
    expect(existsSync(path), `${path} is missing`).toBe(true);
    // A stub that exists is how a docs contract passes while documenting
    // nothing. 60 lines is roughly "explains one mechanism".
    expect(readFileSync(path, "utf8").split("\n").length).toBeGreaterThan(60);
  });

  it("covers the mechanisms a reader cannot infer from the CLI", () => {
    const topics: Record<string, string[]> = {
      "docs/verification.md": ["discovery", "coverage", "freshness", "declared_skips"],
      "docs/leases.md": ["compare-and-swap", "generation", "assertHeld", "takeover"],
      "docs/autonomy.md": ["guarded-merge", "branch protection", "crossCheckVerdict"],
      "docs/sandbox.md": ["Seatbelt", "bubblewrap", "SSH_AUTH_SOCK"],
      "docs/lifecycle.md": ["outbox", "QUARANTINED", "budgets"],
    };
    for (const [path, required] of Object.entries(topics)) {
      const body = readFileSync(path, "utf8").toLowerCase();
      for (const topic of required) {
        expect(body, `${path} does not cover "${topic}"`).toContain(topic.toLowerCase());
      }
    }
  });
});

describe("commands cited in the docs", () => {
  it("cites enough commands to make this test meaningful", () => {
    const all = docFiles.flatMap((f) => [
      ...readFileSync(f, "utf8").matchAll(/`runmill ([a-z][a-z0-9 -]*)`/g),
    ]);
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(docFiles)("%s only cites commands that exist", (file) => {
    const body = readFileSync(file, "utf8");
    const cited = [
      ...[...body.matchAll(/`runmill ([a-z][a-z0-9 |<>-]*?)`/g)].map((m) => m[1] ?? ""),
      ...[...body.matchAll(/^\s*(?:\$ )?runmill ([a-z][a-z0-9 -]*)$/gm)].map((m) => m[1] ?? ""),
    ];

    for (const raw of cited) {
      for (const variant of raw.split("|")) {
        const tokens = variant
          .trim()
          .split(" ")
          .filter((t) => t !== "" && !t.startsWith("-") && !t.startsWith("<"));
        if (tokens.length === 0) continue;
        const path = [tokens.slice(0, 2).join(" "), tokens[0] ?? ""].find((p) => COMMANDS.has(p));
        expect(path, `${file} cites \`runmill ${variant.trim()}\` which does not exist`).toBeDefined();
      }
    }
  });

  it.each(docFiles)("%s only cites flags that exist", (file) => {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/`runmill ([a-z][a-z0-9 -]*?) (--[a-z-]+)/g)) {
      const [, commandPath = "", flag = ""] = match;
      const tokens = commandPath.trim().split(" ");
      let cmd: Command | undefined = program;
      for (const part of tokens) cmd = cmd?.commands.find((c) => c.name() === part);
      const names = new Set([...(cmd?.options ?? []).map((o) => o.long ?? ""), ...ROOT_OPTIONS]);
      expect(names.has(flag), `${file}: \`runmill ${commandPath}\` has no ${flag}`).toBe(true);
    }
  });
});

describe("links and references", () => {
  it.each(docFiles)("%s has no broken relative links", (file) => {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/\]\((\.[^)#]*)(#[^)]*)?\)/g)) {
      const target = resolve(dirname(file), match[1] ?? "");
      expect(existsSync(target), `${file} links to missing ${match[1]}`).toBe(true);
    }
  });

  it.each(docFiles)("%s only cites source files that exist", (file) => {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/`(src\/[a-z0-9/-]+\.ts)`/g)) {
      expect(existsSync(match[1] ?? ""), `${file} cites missing ${match[1]}`).toBe(true);
    }
  });

  it.each(docFiles)("%s only cites error codes that exist", (file) => {
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/\b(RM-[A-Z]+-\d{3})\b/g)) {
      expect(ERROR_CATALOG, `${file} cites unknown ${match[1]}`).toHaveProperty(match[1] ?? "");
    }
  });

  it("reaches every concept doc from the index", () => {
    // A page nobody links to is a page nobody reads.
    const index = readFileSync("docs/README.md", "utf8");
    for (const path of CONCEPT_DOCS) {
      if (path === "docs/README.md") continue;
      expect(index, `docs/README.md does not link ${path}`).toContain(`./${path.slice(5)}`);
    }
  });

  it("reaches the docs index from the README", () => {
    expect(readFileSync("README.md", "utf8")).toContain("docs/README.md");
  });
});

describe("configuration reference", () => {
  it("requires the providers block that the parser accepts", () => {
    const schema = JSON.parse(readFileSync("runmill.schema.json", "utf8")) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("providers");
    expect(schema.required).not.toContain("provider");
    expect(schema.properties).not.toHaveProperty("provider");
  });

  it("documents every top-level configuration section", () => {
    const body = readFileSync("docs/configuration.md", "utf8");
    for (const section of [
      "providers",
      "backlog",
      "github",
      "workspace",
      "verification",
      "review",
      "risk",
      "budgets",
    ]) {
      expect(body, `configuration.md omits the "${section}" section`).toContain(`### \`${section}\``);
    }
  });

  it("states the git_isolation default the code actually uses", () => {
    // These drifted once already, in the direction that silently weakened
    // isolation for every real run.
    const actual = parseConfig(`
version: 1
autonomy: pr-only
providers:
  implementer: { implementation: codex }
backlog:
  provider: linear
  team: ENG
  eligible_states: [Todo]
  claim_state: In Progress
github:
  repositories:
    - match: { team: ENG }
      repo: acme/platform
`).workspace.gitIsolation;
    const body = readFileSync("docs/configuration.md", "utf8");
    expect(body).toMatch(new RegExp(`\\| \`git_isolation\` \\| \`${actual}\``));
  });

  it("does not advertise configuration controls the runtime does not consume", () => {
    const schema = readFileSync("runmill.schema.json", "utf8");
    const docs = readFileSync("docs/configuration.md", "utf8");
    for (const key of [
      "blocked_state",
      "delete_branch",
      "clean_untracked_files",
      "changed_area_rules",
      "entry_files",
      "max_initial_bytes",
      "progressive_disclosure",
    ]) {
      expect(schema, `schema still advertises ${key}`).not.toContain(`\"${key}\"`);
      expect(docs, `configuration docs still advertise ${key}`).not.toContain(`\`${key}\``);
    }
  });
});
