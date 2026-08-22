/** A repository-relative path policy pinned in the task packet. */
export interface ChangeScope {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

export interface ChangeScopeViolation {
  readonly path: string;
  readonly reason: "outside-allowed-paths" | "forbidden-path" | "invalid-path" | "invalid-pattern";
  readonly pattern?: string | undefined;
  readonly detail: string;
}

/** Used only by callers that deliberately want an unrestricted test fixture. */
export const ALL_CHANGE_SCOPE: ChangeScope = { allowedPaths: ["**"], forbiddenPaths: [] };

/**
 * Normalize a path reported by Git without ever turning an escape into authority.
 *
 * Git reports repository-relative paths. Absolute paths, empty segments and
 * traversal therefore mean the evidence is malformed; they are rejected rather
 * than cleaned up into a path that might accidentally match an allow rule.
 */
export function normalizeRepositoryPath(value: string): string {
  // Git's repository-relative path format uses '/' on every supported host.
  // A backslash can therefore be a literal filename character, not a Windows
  // separator. Rewriting it would let `src\\escape.ts` borrow authority from
  // an allowed `src/**` path it is not actually under.
  const path = value;
  if (
    path === "" ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path)
  ) {
    throw new Error(`not a repository-relative path: ${JSON.stringify(value)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`ambiguous repository path: ${JSON.stringify(value)}`);
  }
  return segments.join("/");
}

interface CompiledPattern {
  readonly source: string;
  readonly segments: readonly string[];
  readonly directory: boolean;
  readonly recursiveDirectory: boolean;
  readonly basenameOnly: boolean;
}

function compilePattern(source: string): CompiledPattern {
  if (source === "" || source.includes("\0") || source.startsWith("!")) {
    throw new Error(`unsupported or empty path pattern: ${JSON.stringify(source)}`);
  }

  if (source.includes("\\")) {
    throw new Error(`backslashes are not supported in path patterns: ${JSON.stringify(source)}`);
  }
  let pattern = source;
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const directory = pattern.endsWith("/");
  if (directory) pattern = pattern.slice(0, -1);
  if (pattern === "") throw new Error(`empty path pattern: ${JSON.stringify(source)}`);

  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`ambiguous path pattern: ${JSON.stringify(source)}`);
  }

  return {
    source,
    segments,
    directory,
    recursiveDirectory: segments.length > 1 && segments.at(-1) === "**",
    basenameOnly: segments.length === 1 && !directory,
  };
}

const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|]/;

/** Compile one slash-free gitignore-style segment. */
function segmentExpression(pattern: string): RegExp {
  let expression = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      expression += "[^/]*";
      continue;
    }
    if (char === "?") {
      expression += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) throw new Error(`unterminated character class in ${JSON.stringify(pattern)}`);
      let body = pattern.slice(i + 1, close);
      if (body === "") throw new Error(`empty character class in ${JSON.stringify(pattern)}`);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      // A backslash inside a class can escape the closing bracket and make the
      // generated expression mean something other than the operator wrote.
      if (body.includes("\\")) {
        throw new Error(`backslashes are not supported in a character class: ${JSON.stringify(pattern)}`);
      }
      expression += `[${body}]`;
      i = close;
      continue;
    }
    expression += REGEXP_SPECIAL.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${expression}$`, "u");
}

function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;

    let matched: boolean;
    if (patternIndex === pattern.length) {
      matched = pathIndex === path.length;
    } else if (pattern[patternIndex] === "**") {
      matched =
        visit(patternIndex + 1, pathIndex) ||
        (pathIndex < path.length && visit(patternIndex, pathIndex + 1));
    } else {
      matched =
        pathIndex < path.length &&
        segmentExpression(pattern[patternIndex] ?? "").test(path[pathIndex] ?? "") &&
        visit(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

export function pathMatchesPattern(path: string, source: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  const pathSegments = normalized.split("/");
  const pattern = compilePattern(source);

  if (pattern.basenameOnly) {
    const only = pattern.segments[0] ?? "";
    if (only === "**") return true;
    return segmentExpression(only).test(pathSegments.at(-1) ?? "");
  }

  // A trailing slash names a directory, never a same-named file.
  if (pattern.directory) {
    if (pathSegments.length <= pattern.segments.length) return false;
    return segmentsMatch(pattern.segments, pathSegments.slice(0, pattern.segments.length));
  }

  // `src/**` means descendants of src. Treating a root file named `src` as a
  // match would be a false allow, so require at least one descendant segment.
  if (pattern.recursiveDirectory && pathSegments.length < pattern.segments.length) return false;
  return segmentsMatch(pattern.segments, pathSegments);
}

/** Deterministically evaluate the complete candidate diff. */
export function evaluateChangedPathScope(
  changedPaths: readonly string[],
  scope: ChangeScope,
): { readonly accepted: boolean; readonly violations: readonly ChangeScopeViolation[] } {
  let allowed: CompiledPattern[];
  let forbidden: CompiledPattern[];
  try {
    allowed = scope.allowedPaths.map(compilePattern);
    forbidden = scope.forbiddenPaths.map(compilePattern);
    // Compile every segment now. Otherwise a malformed class might be noticed
    // only for a path that happened to reach it, making policy validity depend
    // on the diff it is supposed to govern.
    for (const pattern of [...allowed, ...forbidden]) {
      for (const segment of pattern.segments) {
        if (segment !== "**") segmentExpression(segment);
      }
    }
  } catch (error) {
    return {
      accepted: false,
      violations: [
        {
          path: "<policy>",
          reason: "invalid-pattern",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const violations: ChangeScopeViolation[] = [];
  for (const candidate of changedPaths) {
    let path: string;
    try {
      path = normalizeRepositoryPath(candidate);
    } catch (error) {
      violations.push({
        path: candidate,
        reason: "invalid-path",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const denied = forbidden.find((pattern) => pathMatchesPattern(path, pattern.source));
    if (denied !== undefined) {
      violations.push({
        path,
        reason: "forbidden-path",
        pattern: denied.source,
        detail: `${path} matches forbidden_paths pattern ${JSON.stringify(denied.source)}`,
      });
      continue;
    }
    const permitted = allowed.some((pattern) => pathMatchesPattern(path, pattern.source));
    if (!permitted) {
      violations.push({
        path,
        reason: "outside-allowed-paths",
        detail: `${path} is outside allowed_paths`,
      });
    }
  }

  return { accepted: violations.length === 0, violations };
}

export class ChangeScopeError extends Error {
  readonly violations: readonly ChangeScopeViolation[];

  constructor(violations: readonly ChangeScopeViolation[]) {
    super(`candidate diff violates task path scope: ${violations.map((v) => v.detail).join("; ")}`);
    this.name = "ChangeScopeError";
    this.violations = violations;
  }
}

export function assertChangedPathScope(changedPaths: readonly string[], scope: ChangeScope): void {
  const result = evaluateChangedPathScope(changedPaths, scope);
  if (!result.accepted) throw new ChangeScopeError(result.violations);
}
