import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Digest,
  type JsonValue,
} from "../../src/asf/canonical-json.js";

function unchecked(value: unknown): JsonValue {
  return value as JsonValue;
}

describe("canonicalJson", () => {
  it("renders every JSON primitive", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("text")).toBe('"text"');
    expect(canonicalJson(42)).toBe("42");
  });

  it("orders object keys recursively while preserving array order", () => {
    expect(
      canonicalJson({
        z: { beta: 2, alpha: 1 },
        list: [{ z: 0, a: 1 }, "last", false],
        a: null,
      }),
    ).toBe('{"a":null,"list":[{"a":1,"z":0},"last",false],"z":{"alpha":1,"beta":2}}');
  });

  it("sorts raw UTF-16 property names as required by JCS", () => {
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };

    expect(canonicalJson(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("does not let JavaScript's integer-key enumeration override lexical order", () => {
    expect(canonicalJson({ "2": "two", "10": "ten", "1": "one" })).toBe(
      '{"1":"one","10":"ten","2":"two"}',
    );
  });

  it("uses ECMAScript JSON number rendering", () => {
    expect(
      canonicalJson([
        333333333.33333329,
        1e30,
        4.5,
        2e-3,
        1e-27,
        -0,
        0.000001,
        1e-7,
      ]),
    ).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27,0,0.000001,1e-7]");
  });

  it("uses JSON string escaping without Unicode normalization", () => {
    expect(canonicalJson("€$\u000f\nA'B\"\\/é")).toBe(
      '"€$\\u000f\\nA\'B\\"\\\\/é"',
    );
    expect(canonicalJson("e\u0301")).not.toBe(canonicalJson("é"));
  });

  it("rejects lone Unicode surrogates in values and property names", () => {
    expect(() => canonicalJson("\ud800")).toThrow(/lone Unicode surrogates/);
    expect(() => canonicalJson("\udc00")).toThrow(/lone Unicode surrogates/);
    expect(() => canonicalJson({ ["bad\ud800"]: true })).toThrow(/lone Unicode surrogates/);
  });

  it("accepts frozen and null-prototype JSON objects", () => {
    const dictionary = Object.create(null) as Record<string, JsonValue>;
    dictionary["b"] = 2;
    dictionary["a"] = Object.freeze([true, null]);
    expect(canonicalJson(Object.freeze(dictionary))).toBe('{"a":[true,null],"b":2}');
  });

  it("allows repeated references when they do not form a cycle", () => {
    const shared = { b: 2, a: 1 };
    expect(canonicalJson([shared, shared])).toBe(
      '[{"a":1,"b":2},{"a":1,"b":2}]',
    );
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite number %s", (value) => {
    expect(() => canonicalJson(unchecked(value))).toThrow(/numbers must be finite/);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("not-json")],
    ["bigint", 1n],
  ])("rejects %s values at the root", (_name, value) => {
    expect(() => canonicalJson(unchecked(value))).toThrow(/not a JSON value/);
  });

  it.each([
    ["object", { invalid: undefined }],
    ["array", [undefined]],
    ["nested function", { nested: { invalid: () => undefined } }],
    ["nested symbol", [Symbol("not-json")]],
    ["nested bigint", { invalid: 1n }],
  ])("rejects unsupported values nested in a JSON-shaped %s", (_name, value) => {
    expect(() => canonicalJson(unchecked(value))).toThrow(/not a JSON value/);
  });

  it("rejects sparse arrays rather than silently rendering holes as null", () => {
    const leadingHole = new Array<JsonValue>(2);
    leadingHole[1] = "present";
    expect(() => canonicalJson(leadingHole)).toThrow(/hole at index 0/);

    const deleted = ["first", "second"] as JsonValue[];
    Reflect.deleteProperty(deleted, "1");
    expect(() => canonicalJson(deleted)).toThrow(/hole at index 1/);
  });

  it.each([
    ["Date", new Date("2026-08-21T00:00:00Z")],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["RegExp", /not-json/],
    ["typed array", new Uint8Array([1, 2])],
    ["boxed primitive", new Number(1)],
    ["class instance", new (class RecordLike { readonly a = 1; })()],
  ])("rejects non-plain object: %s", (_name, value) => {
    expect(() => canonicalJson(unchecked(value))).toThrow(/not a plain JSON object/);
  });

  it("rejects direct and indirect cycles", () => {
    const direct: Record<string, unknown> = {};
    direct["self"] = direct;
    expect(() => canonicalJson(unchecked(direct))).toThrow(/cyclic structures/);

    const array: unknown[] = [];
    const object = { array };
    array.push(object);
    expect(() => canonicalJson(unchecked(object))).toThrow(/cyclic structures/);
  });

  it("rejects properties that JSON would silently ignore", () => {
    const symbolKeyed = { valid: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = false;
    expect(() => canonicalJson(unchecked(symbolKeyed))).toThrow(/symbol-keyed object/);

    const hidden = { visible: true };
    Object.defineProperty(hidden, "hidden", { value: false, enumerable: false });
    expect(() => canonicalJson(unchecked(hidden))).toThrow(/must be enumerable/);

    const array = [1] as unknown[] & { note?: string };
    array.note = "ignored by JSON.stringify";
    expect(() => canonicalJson(unchecked(array))).toThrow(/not a JSON element/);
  });

  it("rejects accessors instead of executing code during canonicalization", () => {
    const value = {};
    Object.defineProperty(value, "computed", {
      enumerable: true,
      get: () => "value",
    });
    expect(() => canonicalJson(unchecked(value))).toThrow(/must be a data property/);
  });
});

describe("sha256Digest", () => {
  it("hashes the UTF-8 canonical representation with a tagged lowercase digest", () => {
    expect(sha256Digest({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256Digest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces the same digest for insertion-order variants", () => {
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });
});
