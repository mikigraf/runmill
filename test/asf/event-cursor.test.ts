import { describe, expect, it } from "vitest";
import {
  decodeAsfEventCursor,
  encodeAsfEventCursor,
} from "../../src/asf/event-cursor.js";

describe("opaque ASF event cursors", () => {
  it("round-trips a run-bound monotonic sequence", () => {
    const cursor = encodeAsfEventCursor("run_01J", 42);
    expect(cursor).toMatch(/^asf1_[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain("run_01J");
    expect(decodeAsfEventCursor(cursor, "run_01J")).toBe(42);
  });

  it("refuses cross-run, unknown-version, malformed, and noncanonical cursors", () => {
    const cursor = encodeAsfEventCursor("run_01J", 7);
    expect(() => decodeAsfEventCursor(cursor, "run_other")).toThrow(/belongs to/u);
    expect(() => decodeAsfEventCursor(`asf2_${cursor.slice(5)}`, "run_01J")).toThrow(
      /unsupported/u,
    );
    expect(() => decodeAsfEventCursor("asf1_***", "run_01J")).toThrow(/encoding/u);

    const reordered = Buffer.from(
      '{"sequence":7,"run_id":"run_01J","schema":"asf.event-cursor/v1"}',
      "utf8",
    ).toString("base64url");
    expect(() => decodeAsfEventCursor(`asf1_${reordered}`, "run_01J")).toThrow(
      /non-canonical/u,
    );
  });

  it("refuses unsafe, negative, and fractional sequences before encoding", () => {
    expect(() => encodeAsfEventCursor("run_01J", -1)).toThrow();
    expect(() => encodeAsfEventCursor("run_01J", 1.5)).toThrow();
    expect(() => encodeAsfEventCursor("run_01J", Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
