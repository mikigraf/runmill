export const SUPPORTED_REPORT_FORMATS = ["junit", "tap", "go-json"] as const;

export type ReportTestStatus = "passed" | "failed" | "skipped";

export interface ReportTestResult {
  /** Canonical, format-specific identity used by declared_skips. */
  readonly id: string;
  readonly status: ReportTestStatus;
}

export interface ReportValidation {
  readonly valid: boolean;
  readonly detail: string;
  /** The report itself contradicts a successful process exit. */
  readonly failed: boolean;
  /** Machine-readable skips, retained for display compatibility. */
  readonly skipped: number;
  /** Exact test inventory. Empty whenever validation fails. */
  readonly tests: readonly ReportTestResult[];
}

function invalid(detail: string): ReportValidation {
  return { valid: false, detail, failed: false, skipped: 0, tests: [] };
}

function valid(format: string, tests: readonly ReportTestResult[]): ReportValidation {
  const skipped = tests.filter((test) => test.status === "skipped").length;
  return {
    valid: true,
    detail: `${format} report parsed (${tests.length} test${tests.length === 1 ? "" : "s"})`,
    failed: tests.some((test) => test.status === "failed"),
    skipped,
    tests,
  };
}

function rejectInvalidIdentities(
  format: string,
  tests: readonly ReportTestResult[],
): ReportValidation | undefined {
  const seen = new Set<string>();
  for (const test of tests) {
    if (test.id.trim() === "") return invalid(`${format} report contains an empty test id`);
    if (seen.has(test.id)) {
      return invalid(`${format} report contains duplicate test id ${JSON.stringify(test.id)}`);
    }
    seen.add(test.id);
  }
  return undefined;
}

function elementIsBalanced(source: string, name: string): boolean {
  const openings = source.match(new RegExp(`<${name}\\b[^>]*>`, "gim"))?.length ?? 0;
  const selfClosing =
    source.match(new RegExp(`<${name}\\b[^>]*\\/\\s*>`, "gim"))?.length ?? 0;
  const closings = source.match(new RegExp(`<\\/${name}\\s*>`, "gim"))?.length ?? 0;
  return openings - selfClosing === closings;
}

/** A small, deliberately strict XML scanner for the JUnit subset we accept. */
function xmlStructureProblem(source: string): string | undefined {
  const stack: string[] = [];
  let roots = 0;
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end === -1) return "unclosed XML comment";
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      const end = source.indexOf("]]>", start + 9);
      if (end === -1) return "unclosed CDATA section";
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", start)) {
      const end = source.indexOf("?>", start + 2);
      if (end === -1) return "unclosed XML processing instruction";
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", start)) {
      return "DOCTYPE and entity declarations are not accepted in JUnit evidence";
    }

    let end = start + 1;
    let quote: '"' | "'" | undefined;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= source.length) return "unclosed XML tag";

    let tag = source.slice(start + 1, end).trim();
    const closing = tag.startsWith("/");
    if (closing) tag = tag.slice(1).trim();
    const selfClosing = !closing && tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1).trim();
    const match = tag.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/);
    if (match?.[1] === undefined) return "malformed XML tag";
    const name = match[1];
    const rest = match[2] ?? "";
    if (closing) {
      if (rest.trim() !== "" || stack.pop() !== name) return `mismatched closing tag ${name}`;
    } else {
      if (xmlAttributes(rest) === undefined) return `malformed attributes on ${name}`;
      if (stack.length === 0) roots += 1;
      if (!selfClosing) stack.push(name);
    }
    index = end + 1;
  }
  if (stack.length > 0) return `unclosed XML tag ${stack.at(-1) ?? "unknown"}`;
  if (roots !== 1) return `JUnit XML must contain exactly one root element, found ${roots}`;
  return undefined;
}

function decodeXmlAttribute(source: string): string | undefined {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(source)) return undefined;
  let malformed = false;
  const decoded = source.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default: {
          const hex = entity.toLowerCase().startsWith("&#x");
          const digits = entity.slice(hex ? 3 : 2, -1);
          const point = Number.parseInt(digits, hex ? 16 : 10);
          if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff) {
            malformed = true;
            return "";
          }
          try {
            return String.fromCodePoint(point);
          } catch {
            malformed = true;
            return "";
          }
        }
      }
    },
  );
  if (malformed) return undefined;
  return decoded;
}

function xmlAttributes(source: string): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  const matched: Array<{ start: number; end: number }> = [];
  const pattern = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    const name = match[1];
    if (index === undefined || name === undefined) return undefined;
    const decoded = decodeXmlAttribute(match[2] ?? match[3] ?? "");
    if (decoded === undefined || attributes[name] !== undefined) return undefined;
    attributes[name] = decoded;
    matched.push({ start: index, end: index + match[0].length });
  }

  let remainder = source;
  for (const range of matched.reverse()) {
    remainder = `${remainder.slice(0, range.start)}${remainder.slice(range.end)}`;
  }
  return remainder.trim() === "" ? attributes : undefined;
}

function maskOpaqueXml(source: string): string {
  return source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (value) =>
    " ".repeat(value.length),
  );
}

function validateJunit(source: string): ReportValidation {
  const structureProblem = xmlStructureProblem(source);
  if (structureProblem !== undefined) return invalid(`JUnit report ${structureProblem}`);
  const visible = maskOpaqueXml(source);
  const hasSuites = /<testsuites\b[^>]*>/i.test(visible);
  const hasSuite = /<testsuite\b[^>]*>/i.test(visible);
  if (!hasSuites && !hasSuite) return invalid("JUnit report has no testsuite root");
  if (
    (hasSuites && !elementIsBalanced(visible, "testsuites")) ||
    (hasSuite && !elementIsBalanced(visible, "testsuite"))
  ) {
    return invalid("JUnit report contains an unclosed test suite");
  }

  const openingCount = visible.match(/<testcase\b/gim)?.length ?? 0;
  if (openingCount === 0) return invalid("JUnit report contains no test cases");
  if (!elementIsBalanced(visible, "testcase")) {
    return invalid("JUnit report contains an unclosed test case");
  }

  const tests: ReportTestResult[] = [];
  const cases = /<testcase\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/testcase\s*>)/gim;
  for (const match of visible.matchAll(cases)) {
    const attributes = xmlAttributes(match[1] ?? "");
    if (attributes === undefined) return invalid("JUnit testcase has malformed attributes");
    const name = (attributes["name"] ?? "").trim();
    const className = (attributes["classname"] ?? "").trim();
    const id = className === "" ? name : `${className}::${name}`;
    const body = match[2] ?? "";
    const hasFailure = /<(?:failure|error)\b/i.test(body);
    const hasSkip = /<skipped\b/i.test(body);
    if (hasFailure && hasSkip) {
      return invalid(`JUnit test ${JSON.stringify(id)} has contradictory failure and skip states`);
    }
    tests.push({
      id,
      status: hasSkip ? "skipped" : hasFailure ? "failed" : "passed",
    });
  }
  if (tests.length !== openingCount) {
    return invalid(`JUnit report declared ${openingCount} testcase element(s) but parsed ${tests.length}`);
  }

  return rejectInvalidIdentities("JUnit", tests) ?? valid("JUnit", tests);
}

interface TapResult {
  readonly test: ReportTestResult;
  readonly number?: number | undefined;
}

function tapResult(line: string): TapResult | undefined {
  const point = line.match(/^(not )?ok\b(.*)$/i);
  if (point === null) return undefined;
  let tail = point[2] ?? "";
  const directive = tail.match(/#\s*(skip|todo)\b.*$/i);
  if (directive?.index !== undefined) tail = tail.slice(0, directive.index);
  tail = tail.trim();
  const number = tail.match(/^(\d+)\b/)?.[1];
  tail = tail.replace(/^\d+\b\s*/, "").replace(/^-\s*/, "").trim();
  return {
    ...(number === undefined ? {} : { number: Number(number) }),
    test: {
      id: tail,
      status:
        directive !== null
          ? "skipped"
          : point[1] === undefined
            ? "passed"
            : "failed",
    },
  };
}

function validateTap(source: string): ReportValidation {
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => /^Bail out!/i.test(line))) {
    return invalid("TAP report contains a bailout");
  }
  const plans = lines
    .map((line) => line.match(/^1\.\.(\d+)(?:\s|$)/i))
    .filter((match) => match !== null);
  if (plans.length === 0) return invalid("TAP report has no test plan");
  if (plans.length > 1) return invalid(`TAP report has ${plans.length} test plans, expected one`);
  const plan = plans[0];
  if (plan?.[1] === undefined) return invalid("TAP report has no test plan");

  const planned = Number(plan[1]);
  const results = lines.flatMap((line) => {
    const result = tapResult(line);
    return result === undefined ? [] : [result];
  });
  if (planned === 0 || results.length !== planned) {
    return invalid(`TAP report planned ${planned} test(s) and reported ${results.length}`);
  }
  const numbered = results.filter((result) => result.number !== undefined);
  if (
    numbered.length > 0 &&
    (numbered.length !== results.length ||
      results.some((result, index) => result.number !== index + 1))
  ) {
    return invalid("TAP report has missing, duplicate, or out-of-order test point numbers");
  }

  const tests = results.map((result) => result.test);
  return rejectInvalidIdentities("TAP", tests) ?? valid("TAP", tests);
}

function validateGoJson(source: string): ReportValidation {
  const lines = source.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return invalid("Go JSON report is empty");

  const tests: ReportTestResult[] = [];
  for (const [index, line] of lines.entries()) {
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return invalid(`Go JSON event ${index + 1} is not an object`);
      }
      event = value as Record<string, unknown>;
    } catch (cause) {
      return invalid(`Go JSON event ${index + 1} is malformed: ${(cause as Error).message}`);
    }

    const action = event["Action"];
    if (!(["pass", "fail", "skip"] as const).includes(action as "pass" | "fail" | "skip")) {
      continue;
    }
    // Completion events without Test are package-level summaries, not test identities.
    if (event["Test"] === undefined) continue;
    if (typeof event["Test"] !== "string" || typeof event["Package"] !== "string") {
      return invalid(`Go JSON event ${index + 1} has a non-string Package or Test`);
    }
    if (event["Test"].trim() === "" || event["Package"].trim() === "") {
      return invalid(`Go JSON event ${index + 1} has an empty test id component`);
    }
    tests.push({
      id: `${event["Package"].trim()}::${event["Test"].trim()}`,
      status: action === "pass" ? "passed" : action === "fail" ? "failed" : "skipped",
    });
  }

  if (tests.length === 0) return invalid("Go JSON report contains no completed test events");
  return rejectInvalidIdentities("Go JSON", tests) ?? valid("Go JSON", tests);
}

/**
 * Structural validation and exact test inventory for every accepted report.
 * A declaration is not evidence until every test has a unique, non-empty id.
 */
export function validateReportContent(format: string, source: string): ReportValidation {
  if (source.trim() === "") return invalid(`${format || "declared"} report is empty`);
  switch (format) {
    case "junit":
      return validateJunit(source);
    case "tap":
      return validateTap(source);
    case "go-json":
      return validateGoJson(source);
    default:
      return invalid(`unsupported report format ${JSON.stringify(format)}`);
  }
}
