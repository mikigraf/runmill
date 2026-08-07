/**
 * Generate docs/errors.md from the error catalog.
 *
 * Every error prints a Docs link. A hand-maintained page behind those links
 * drifts the moment a code is added, so the page is generated and CI fails if
 * it is stale.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { ERROR_CATALOG, DOCS_BASE } from "../src/errors/runmill-error.js";

function render(): string {
  const out: string[] = [
    "# Error reference",
    "",
    "Every runmill error carries a stable code, what happened, why, and how to fix it.",
    "This page is generated from the catalog in `src/errors/runmill-error.ts` —",
    "edit that, then run `npm run docs:errors`.",
    "",
    "| Code | Title | Recoverable |",
    "|---|---|---|",
  ];

  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    out.push(`| [\`${code}\`](#${code.toLowerCase()}) | ${entry.title} | ${entry.recoverable ? "yes" : "no"} |`);
  }
  out.push("");

  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    out.push(`## ${code}`);
    out.push("");
    out.push(`**${entry.title}**`);
    out.push("");
    out.push(entry.why);
    out.push("");
    out.push(entry.fixes.length === 1 ? "**Fix**" : "**Fix (pick one)**");
    out.push("");
    for (const fix of entry.fixes) {
      out.push(fix.command === undefined ? `- ${fix.description}` : `- \`${fix.command}\` — ${fix.description}`);
    }
    out.push("");
    out.push(entry.recoverable ? "Recoverable: the run can continue once resolved." : "Not recoverable: the run stops.");
    out.push("");
  }

  out.push(`<!-- Docs base: ${DOCS_BASE} -->`);
  return out.join("\n");
}

const target = "docs/errors.md";
const next = render();
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== next) {
    console.error(`${target} is out of date. Run: npm run docs:errors`);
    process.exit(1);
  }
  console.log(`${target} is up to date.`);
} else {
  writeFileSync(target, next);
  console.log(`Wrote ${target} (${Object.keys(ERROR_CATALOG).length} codes).`);
}
