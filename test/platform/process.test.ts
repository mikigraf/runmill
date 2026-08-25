import { describe, expect, it } from "vitest";
import { BoundedCapture, run, runOrThrow, runWithInput } from "../../src/platform/process.js";

describe("BoundedCapture", () => {
  it("returns everything when under the cap", () => {
    const c = new BoundedCapture(1024);
    c.push(Buffer.from("hello "));
    c.push(Buffer.from("world"));
    expect(c.text()).toBe("hello world");
  });

  it("is empty before anything is pushed", () => {
    expect(new BoundedCapture(1024).text()).toBe("");
  });

  it("keeps the tail and marks the truncation once past the cap", () => {
    const c = new BoundedCapture(16);
    for (let i = 0; i < 20; i += 1) c.push(Buffer.from("0123456789"));
    const text = c.text();
    expect(text).toContain("[...truncated...]");
    // The detectors read summary lines at the tail, so the tail is what is kept.
    expect(text.endsWith("0123456789")).toBe(true);
  });

  it("does not split a multi-byte UTF-8 sequence across chunk boundaries", () => {
    // Decoding per chunk emits U+FFFD in both halves; decoding once does not.
    const euro = Buffer.from("€", "utf8");
    const c = new BoundedCapture(1024);
    c.push(euro.subarray(0, 1));
    c.push(euro.subarray(1));
    expect(c.text()).toBe("€");
  });

  it("stays linear rather than re-copying the cap on every chunk", () => {
    // The string form (`buf = (buf + chunk).slice(-max)`) flattens the whole
    // rope per chunk, which measured ~500x slower on 64MB in 4KB chunks. This
    // asserts the shape stayed linear, with a ceiling loose enough not to be
    // flaky on a busy machine.
    const chunk = Buffer.alloc(4096, 0x61);
    const c = new BoundedCapture(512 * 1024);
    const started = Date.now();
    for (let i = 0; i < 16_384; i += 1) c.push(chunk); // 64 MB
    const elapsed = Date.now() - started;
    expect(c.text().length).toBeLessThanOrEqual(512 * 1024 + 32);
    expect(elapsed).toBeLessThan(400);
  });
});

describe("run", () => {
  it("captures stdout without throwing on success", async () => {
    const result = await run("/bin/echo", ["hi"]);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.code).toBe(0);
  });

  it("reports a non-zero exit as data rather than an exception", async () => {
    const result = await run("/bin/sh", ["-c", "echo oops >&2; exit 3"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("oops");
  });

  it("reports a missing binary rather than throwing", async () => {
    const result = await run("/definitely/not/a/binary", []);
    expect(result.ok).toBe(false);
  });

  it("survives output larger than execFile's 1MB default", async () => {
    // The default SIGTERMs the child on overflow, which would surface as a
    // generic failure for something like `git diff --name-only` on a big change.
    const result = await run("/bin/sh", ["-c", "yes abcdefghij | head -c 2000000"]);
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(1_500_000);
  }, 30_000);

  it("runs in the given directory", async () => {
    const result = await run("/bin/pwd", [], { cwd: "/tmp" });
    expect(result.stdout).toContain("tmp");
  });
});

describe("runOrThrow", () => {
  it("returns trimmed stdout on success", async () => {
    expect(await runOrThrow("/bin/echo", ["  hi  "])).toBe("hi");
  });

  it("throws with the stderr attached on failure", async () => {
    await expect(runOrThrow("/bin/sh", ["-c", "echo bad >&2; exit 1"])).rejects.toThrow(/bad/);
  });
});

describe("runWithInput", () => {
  it("delivers sensitive input on stdin without adding it to argv", async () => {
    const secret = "private-value-not-for-argv";
    const result = await runWithInput(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "let data=''; process.stdin.on('data', c => data += c); " +
          "process.stdin.on('end', () => process.stdout.write(JSON.stringify({argv:process.argv,data})));",
      ],
      secret,
    );

    expect(result.ok).toBe(true);
    const observed = JSON.parse(result.stdout) as { argv: string[]; data: string };
    expect(observed.data).toBe(secret);
    expect(observed.argv.join("\0")).not.toContain(secret);
  });

  it("never copies stdin into a failed command diagnostic", async () => {
    const secret = "diagnostic-secret";
    const result = await runWithInput(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => { console.error('refused'); process.exit(2); });",
      ],
      secret,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("refused");
    expect(result.stderr).not.toContain(secret);
  });

  it("terminates the child tree when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = runWithInput(
      process.execPath,
      ["--input-type=module", "-e", "process.stdin.resume(); setTimeout(() => {}, 60000);"],
      "",
      { signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("command cancelled");
  });
});
