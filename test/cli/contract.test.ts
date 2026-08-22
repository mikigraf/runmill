/**
 * The CLI contract: everything runmill tells a developer to do must be real.
 *
 * A DX audit found 8 of 19 error codes whose only remedy was a command that
 * did not exist. A fix line pointing at a nonexistent command is worse than no
 * fix line — it costs a round trip and the developer's trust. These tests make
 * that class of defect impossible to reintroduce.
 */
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, DOCS_BASE } from "../../src/errors/runmill-error.js";
import type { ErrorCatalogEntry } from "../../src/errors/runmill-error.js";
import { buildProgram } from "../../src/cli/main.js";
import type { Command } from "commander";

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

function optionNames(program: Command, commandPath: string): Set<string> {
  const parts = commandPath.split(" ");
  let cmd: Command | undefined = program;
  for (const part of parts) {
    cmd = cmd?.commands.find((c) => c.name() === part);
  }
  const names = new Set<string>();
  for (const opt of cmd?.options ?? []) names.add(opt.long ?? "");
  for (const opt of program.options) names.add(opt.long ?? "");
  return names;
}

const program = buildProgram();
const COMMANDS = commandPaths(program);

/** Every `runmill ...` string the catalog suggests, with placeholders stripped. */
function citedRunmillCommands(): { code: string; command: string }[] {
  const cited: { code: string; command: string }[] = [];
  for (const [code, entry] of Object.entries<ErrorCatalogEntry>(ERROR_CATALOG)) {
    for (const fix of entry.fixes) {
      if (fix.command?.startsWith("runmill ") !== true) continue;
      cited.push({ code, command: fix.command });
    }
  }
  return cited;
}

describe("error catalog remediation commands", () => {
  it("cites at least one runmill command (guards against a vacuous pass)", () => {
    expect(citedRunmillCommands().length).toBeGreaterThan(5);
  });

  it.each(citedRunmillCommands())(
    "$code suggests `$command`, which must exist",
    ({ command }) => {
      const tokens = command
        .split(" ")
        .slice(1)
        .filter((t) => !t.startsWith("<") && !t.startsWith("-"));

      // A bare root option, e.g. `runmill --version`.
      if (tokens.length === 0) {
        const flags = command.split(" ").filter((t) => t.startsWith("--"));
        for (const flag of flags) {
          expect(
            program.options.some((o) => o.long === flag),
            `runmill has no root option ${flag}`,
          ).toBe(true);
        }
        return;
      }

      // Longest matching command path wins: `config validate` before `config`.
      const path = [tokens.slice(0, 2).join(" "), tokens[0] ?? ""].find((p) =>
        COMMANDS.has(p),
      );
      expect(path, `no such command: runmill ${tokens.join(" ")}`).toBeDefined();

      // Flags in the suggestion must be real flags on that command.
      for (const token of command.split(" ").slice(1)) {
        if (!token.startsWith("--")) continue;
        expect(
          optionNames(program, path as string).has(token),
          `runmill ${path} has no option ${token}`,
        ).toBe(true);
      }
    },
  );

  it("gives every entry at least one fix a developer can act on", () => {
    for (const [code, entry] of Object.entries<ErrorCatalogEntry>(ERROR_CATALOG)) {
      expect(entry.fixes.length, `${code} has no fixes`).toBeGreaterThan(0);
    }
  });

  it("points docs at a host that exists", () => {
    // runmill.dev did not resolve, so every Docs line in every error was dead.
    expect(DOCS_BASE).toMatch(/^https:\/\/github\.com\//);
  });
});

describe("CLI surface", () => {
  it("implements every command the README tells a developer to run", async () => {
    const readme = await import("node:fs").then((fs) =>
      fs.readFileSync("README.md", "utf8"),
    );
    // Only commands the README presents AS commands: inside backticks or a
    // fenced block. Prose that happens to start with the product name is not
    // an instruction to run anything.
    const inBackticks = [...readme.matchAll(/`runmill ([a-z][a-z0-9 |-]*?)`/g)].map((m) => m[1] ?? "");
    const inFences = [...readme.matchAll(/^\s*(?:\$ )?runmill ([a-z][a-z0-9 -]*)$/gm)].map((m) => m[1] ?? "");
    const cited = [...inBackticks, ...inFences]
      .flatMap((c) => c.split("|"))
      .map((c) => c.trim().split(" ").filter((t) => t !== "" && !t.startsWith("-") && !t.startsWith("<") && !t.startsWith("[")))
      .filter((t) => t.length > 0);

    for (const tokens of cited) {
      const path = [tokens.slice(0, 2).join(" "), tokens[0] ?? ""].find((p) =>
        COMMANDS.has(p),
      );
      expect(path, `README cites \`runmill ${tokens.join(" ")}\` which does not exist`).toBeDefined();
    }
  });

  it("exposes the commands the getting-started path depends on", () => {
    for (const required of [
      "demo",
      "init",
      "doctor",
      "next",
      "run",
      "start",
      "status",
      "stop",
      "config validate",
    ]) {
      expect(COMMANDS.has(required), `missing: runmill ${required}`).toBe(true);
    }
  });

  it("keeps standalone start as the default and puts ASF behind an explicit surface", () => {
    const start = program.commands.find((command) => command.name() === "start");
    expect(start).toBeDefined();
    expect(start?.options.some((option) => option.long === "--mode")).toBe(false);
    expect(COMMANDS.has("mcp serve")).toBe(true);
    expect(optionNames(program, "mcp serve").has("--stdio")).toBe(true);
    expect(COMMANDS.has("service start")).toBe(true);
    expect(optionNames(program, "service start").has("--mode")).toBe(true);
    expect(optionNames(program, "service start").has("--runtime-module")).toBe(true);
  });

  it("documents the environment variables that change behavior", async () => {
    const readme = await import("node:fs").then((fs) =>
      fs.readFileSync("README.md", "utf8"),
    );
    for (const v of [
      "RUNMILL_DEMO",
      "RUNMILL_FAKE_BACKLOG",
      "RUNMILL_SOURCE_REPO",
      "RUNMILL_DATA_DIR",
      "RUNMILL_ASF_RUNTIME_MODULE",
      "RUNMILL_ASF_DAEMON_REGISTRY",
    ]) {
      expect(readme, `README does not document ${v}`).toContain(v);
    }
  });
});

describe("commands cited anywhere in the source", () => {
  // The catalog scan missed `runmill gc`, cited by a plain `throw new Error` in
  // WorkspaceManager and never implemented. That advice reaches a developer
  // immediately after a crash — the moment a wild goose chase costs most.
  const SOURCE_FILES = (function walk(dir: string): string[] {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  })("src");

  it("scans a meaningful number of files", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(20);
  });

  it.each(SOURCE_FILES)("%s cites no command that does not exist", (file) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const body = fs.readFileSync(file, "utf8");
    // Only backticked citations — prose like "runmill reads issues" is English.
    for (const match of body.matchAll(/\\?`runmill ([a-z][a-z0-9 -]*?)\\?`/g)) {
      const tokens = (match[1] ?? "")
        .trim()
        .split(" ")
        .filter((t) => t !== "" && !t.startsWith("-"));
      if (tokens.length === 0) continue;
      const path = [tokens.slice(0, 2).join(" "), tokens[0] ?? ""].find((p) => COMMANDS.has(p));
      expect(path, `${file} cites \`runmill ${tokens.join(" ")}\` which does not exist`).toBeDefined();
    }
  });
});

describe("the advertised quickstart", () => {
  // The README's "Try it in 60 seconds" block once omitted RUNMILL_DEMO=1, so
  // the headline command printed "No eligible issue." — a first impression of
  // a product that appears to do nothing.
  it("seeds demo mode with issues, so the zero-credential path shows real output", async () => {
    const { buildAdapters, demoFixturePath } = await import("../../src/factory.js");
    const fs = await import("node:fs");
    expect(fs.existsSync(demoFixturePath()), "bundled demo fixture is missing").toBe(true);

    const config = (await import("../../src/config/load.js")).parseConfig(
      fs.readFileSync("examples/quickstart/runmill.yaml", "utf8"),
    );
    const { backlog } = await buildAdapters(config, { demo: true, need: ["backlog"] });
    const issues = await backlog.listCandidates({
      team: config.backlog.team,
      states: config.backlog.eligibleStates,
    });
    expect(issues.length, "demo backlog came back empty").toBeGreaterThan(0);
  });

  it("ships the demo fixture in the published package", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[] };
    expect(pkg.files.some((f) => f.startsWith("examples"))).toBe(true);
  });

  it("points the schema at a URL that resolves", async () => {
    // The $id is what developers paste into runmill.yaml for editor
    // autocomplete. Pointing it at an unregistered domain broke that silently.
    const fs = await import("node:fs");
    const schema = JSON.parse(fs.readFileSync("runmill.schema.json", "utf8")) as { $id: string };
    expect(schema.$id).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    for (const f of ["examples/quickstart/runmill.yaml", "README.md"]) {
      expect(fs.readFileSync(f, "utf8"), `${f} cites the dead host`).not.toContain("runmill.dev");
    }
  });
});

describe("published package", () => {
  it("declares a bin target that the build produces", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
      files: string[];
    };
    const target = pkg.bin["runmill"] ?? "";

    // The tarball once shipped 4 files and no code: bin pointed into dist/ and
    // nothing built it at pack time.
    expect(pkg.scripts["prepack"] ?? pkg.scripts["prepare"]).toBeDefined();
    expect(pkg.files.some((f) => target.includes(f))).toBe(true);
  });

  it("resolves its entrypoint through a symlink", async () => {
    // npm links node_modules/.bin/runmill to the real file, so argv[1] is the
    // SYMLINK. Comparing it to import.meta.url directly meant the installed
    // binary parsed nothing and exited 0 — on PATH and silently inert.
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/cli/main.ts", "utf8");
    expect(source).toContain("realpathSync");
    expect(source).not.toMatch(/import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/);
  });
});

describe("documentation", () => {
  it("ships an error page covering every catalog code", async () => {
    const fs = await import("node:fs");
    const docs = fs.readFileSync("docs/errors.md", "utf8");
    for (const code of Object.keys(ERROR_CATALOG)) {
      expect(docs, `docs/errors.md is missing ${code} — run npm run docs:errors`).toContain(code);
    }
  });

  it("documents every command in the README", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const readme = fs.readFileSync("README.md", "utf8");
    for (const path of COMMANDS) {
      // Subcommand groups appear via their children, e.g. `config validate`.
      const isGroup = [...COMMANDS].some((c) => c.startsWith(`${path} `));
      if (isGroup || path === "help") continue;
      expect(readme, `README does not document \`runmill ${path}\``).toContain(`runmill ${path}`);
    }
  });
});
