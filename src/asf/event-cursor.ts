import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

export const ASF_EVENT_CURSOR_SCHEMA = "asf.event-cursor/v1" as const;
const CURSOR_PREFIX = "asf1_";

const cursorPayloadSchema = z
  .object({
    schema: z.literal(ASF_EVENT_CURSOR_SCHEMA),
    run_id: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export type AsfEventCursorPayload = z.infer<typeof cursorPayloadSchema>;

/** Cursor bytes are deliberately opaque to clients but contain no authority. */
export function encodeAsfEventCursor(runId: string, sequence: number): string {
  const payload = cursorPayloadSchema.parse({
    schema: ASF_EVENT_CURSOR_SCHEMA,
    run_id: runId,
    sequence,
  });
  return `${CURSOR_PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;
}

/** Strict, canonical and run-bound decoding prevents cursor mix-ups. */
export function decodeAsfEventCursor(cursor: string, expectedRunId: string): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error("unsupported ASF event cursor version");
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url");
    }
    decoded = bytes.toString("utf8");
  } catch {
    throw new Error("invalid ASF event cursor encoding");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("invalid ASF event cursor JSON");
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== decoded) {
    throw new Error("invalid or non-canonical ASF event cursor payload");
  }
  if (parsed.data.run_id !== expectedRunId) {
    throw new Error(
      `ASF event cursor belongs to ${parsed.data.run_id}, not ${expectedRunId}`,
    );
  }
  return parsed.data.sequence;
}
