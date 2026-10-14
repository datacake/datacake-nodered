import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIncoming, serializeValue, splitFields } from "../../src/lib/payload";

describe("parseIncoming", () => {
  it("keeps strings in string mode (0.x behaviour)", () => {
    assert.equal(parseIncoming(Buffer.from("21.5"), "string", "FLOAT"), "21.5");
  });

  it("converts by field type in auto mode", () => {
    assert.equal(parseIncoming(Buffer.from("21.5"), "auto", "FLOAT"), 21.5);
    assert.equal(parseIncoming(Buffer.from("-3"), "auto", "INT"), -3);
    assert.equal(parseIncoming(Buffer.from("1e3"), "auto", "NUMERIC"), 1000);
    assert.equal(parseIncoming(Buffer.from("12"), "auto", "COUNTER"), 12);
    assert.equal(parseIncoming(Buffer.from("True"), "auto", "BOOL"), true);
    assert.equal(parseIncoming(Buffer.from("0"), "auto", "BOOL"), false);
    assert.equal(parseIncoming(Buffer.from("123"), "auto", "STRING"), "123");
    assert.equal(parseIncoming(Buffer.from("(52.1,7.6)"), "auto", "GEO"), "(52.1,7.6)");
  });

  it("parses payloads as captured from the Datacake broker", () => {
    assert.equal(parseIncoming(Buffer.from("100.0"), "auto", "NUMERIC"), 100);
    assert.equal(parseIncoming(Buffer.from("-83.0"), "auto", "NUMERIC"), -83);
    assert.equal(parseIncoming(Buffer.from("101185.75"), "auto", "NUMERIC"), 101185.75);
    assert.equal(parseIncoming(Buffer.from("CELLULAR"), "auto", "STRING"), "CELLULAR");
    assert.equal(parseIncoming(Buffer.from("0.0.10_1"), "auto", "STRING"), "0.0.10_1");
    assert.equal(
      parseIncoming(Buffer.from("(48.735888,2.166076)"), "auto", "GEO"),
      "(48.735888,2.166076)",
    );
  });

  it("keeps values that do not match the field type as text", () => {
    assert.equal(parseIncoming(Buffer.from("n/a"), "auto", "FLOAT"), "n/a");
    assert.equal(parseIncoming(Buffer.from(""), "auto", "FLOAT"), "");
    assert.equal(parseIncoming(Buffer.from("maybe"), "auto", "BOOL"), "maybe");
  });

  it("guesses unambiguous values when the field type is unknown", () => {
    assert.equal(parseIncoming(Buffer.from("42"), "auto"), 42);
    assert.equal(parseIncoming(Buffer.from("false"), "auto"), false);
    assert.equal(parseIncoming(Buffer.from("1"), "auto"), 1);
    assert.equal(parseIncoming(Buffer.from("hello"), "auto"), "hello");
    assert.equal(parseIncoming(Buffer.from("0x1A"), "auto"), "0x1A");
  });
});

describe("serializeValue", () => {
  it("converts scalars", () => {
    assert.equal(serializeValue("x"), "x");
    assert.equal(serializeValue(21.5), "21.5");
    assert.equal(serializeValue(true), "true");
    assert.equal(serializeValue(Buffer.from("raw")), "raw");
  });

  it("rejects values 0.x silently broke (null crashed, objects became [object Object])", () => {
    assert.throws(() => serializeValue(null), /empty/);
    assert.throws(() => serializeValue(undefined), /empty/);
    assert.throws(() => serializeValue({ a: 1 }), /Fields from msg.payload/);
    assert.throws(() => serializeValue([1, 2]));
    assert.throws(() => serializeValue(NaN));
  });
});

describe("splitFields", () => {
  it("returns one value per field", () => {
    const { values, errors } = splitFields({ TEMPERATURE: 21.5, DOOR_OPEN: false });
    assert.deepEqual(values, [
      { fieldName: "TEMPERATURE", value: "21.5" },
      { fieldName: "DOOR_OPEN", value: "false" },
    ]);
    assert.deepEqual(errors, []);
  });

  it("reports invalid fields and values but keeps the valid ones", () => {
    const { values, errors } = splitFields({ "A/B": 1, NOTE: null, OK: 1 });
    assert.deepEqual(values, [{ fieldName: "OK", value: "1" }]);
    assert.equal(errors.length, 2);
  });

  it("requires a plain object", () => {
    assert.throws(() => splitFields("21"));
    assert.throws(() => splitFields([1]));
    assert.throws(() => splitFields(null));
  });
});
