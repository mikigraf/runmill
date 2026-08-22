import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function invalidJson(detail: string): never {
  throw new TypeError(`Cannot canonicalize value as JSON: ${detail}`);
}

function rejectLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return invalidJson("strings must not contain lone Unicode surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return invalidJson("strings must not contain lone Unicode surrogates");
    }
  }
}

function renderString(value: string): string {
  // JCS terminates on invalid Unicode rather than producing a signature that
  // another implementation may interpret differently.
  rejectLoneSurrogates(value);
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return invalidJson("string could not be rendered");
  return rendered;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "") return false;
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return renderString(value);
    case "number": {
      if (!Number.isFinite(value)) return invalidJson("numbers must be finite");
      // JSON.stringify uses ECMAScript's shortest round-trippable number
      // representation, which is the number serialization required by JCS.
      const rendered = JSON.stringify(value);
      if (rendered === undefined) return invalidJson("number could not be rendered");
      return rendered;
    }
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return invalidJson(`${typeof value} is not a JSON value`);
    case "object":
      break;
    default:
      return invalidJson("unsupported value");
  }

  if (ancestors.has(value)) return invalidJson("cyclic structures are not JSON values");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") {
          return invalidJson("symbol-keyed array properties are not JSON values");
        }
        if (key !== "length" && !isArrayIndex(key, value.length)) {
          return invalidJson(`array property ${renderString(key)} is not a JSON element`);
        }
      }

      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          return invalidJson(`array contains a hole at index ${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          return invalidJson(`array element ${index} must be a data property`);
        }
        elements.push(canonicalize(descriptor.value, ancestors));
      }
      return `[${elements.join(",")}]`;
    }

    if (!isPlainObject(value)) {
      const name = value.constructor?.name ?? "object";
      return invalidJson(`${name} is not a plain JSON object`);
    }

    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        return invalidJson("symbol-keyed object properties are not JSON values");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return invalidJson(`object property ${renderString(key)} must be a data property`);
      }
      if (!descriptor.enumerable) {
        return invalidJson(`object property ${renderString(key)} must be enumerable`);
      }
      descriptors.set(key, descriptor);
    }

    const members = [...descriptors.keys()]
      // RFC 8785 orders property names by their raw UTF-16 code units. The
      // default JavaScript string comparison has exactly that ordering.
      .sort()
      .map((key) => {
        const descriptor = descriptors.get(key);
        if (descriptor === undefined) return invalidJson("object changed during serialization");
        return `${renderString(key)}:${canonicalize(descriptor.value, ancestors)}`;
      });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Serialize a JSON value using deterministic RFC 8785/JCS member ordering. */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new WeakSet());
}

/** Digest the UTF-8 bytes of the canonical JSON representation. */
export function sha256Digest(value: JsonValue): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}
