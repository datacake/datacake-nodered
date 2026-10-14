import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchKeys,
  isValidSegment,
  parseTopic,
  publishTopic,
  subscribeTopic,
} from "../../src/lib/topics";

describe("topics", () => {
  it("builds subscription filters with wildcards for device and field", () => {
    assert.equal(subscribeTopic("cold-room", "d1", "TEMPERATURE"), "dtck/cold-room/d1/TEMPERATURE");
    assert.equal(subscribeTopic("cold-room", "d1", "+"), "dtck/cold-room/d1/+");
    assert.equal(subscribeTopic("cold-room", "+", "+"), "dtck/cold-room/+/+");
  });

  it("rejects empty or wildcard product slugs and broken segments", () => {
    assert.throws(() => subscribeTopic("", "d1", "+"));
    assert.throws(() => subscribeTopic("+", "d1", "+"));
    assert.throws(() => subscribeTopic("p", "", "+"));
    assert.throws(() => subscribeTopic("p", "d/1", "+"));
    assert.throws(() => subscribeTopic("p", "d1", "#"));
  });

  it("never builds publish topics with wildcards or empty levels (0.x bug)", () => {
    assert.equal(publishTopic("p", "d1", "TEMP"), "dtck-pub/p/d1/TEMP");
    assert.throws(() => publishTopic("p", "", "TEMP"), /device/);
    assert.throws(() => publishTopic("p", "d1", "+"), /field/);
    assert.throws(() => publishTopic("p", "d1", "A/B"));
  });

  it("validates segments", () => {
    assert.equal(isValidSegment("TEMPERATURE"), true);
    assert.equal(isValidSegment(""), false);
    assert.equal(isValidSegment(undefined), false);
    assert.equal(isValidSegment(42), false);
    assert.equal(isValidSegment("a\0b"), false);
  });

  it("parses incoming topics", () => {
    assert.deepEqual(parseTopic("dtck/p/d1/TEMP"), {
      productSlug: "p",
      deviceId: "d1",
      fieldName: "TEMP",
    });
    assert.equal(parseTopic("dtck-pub/p/d1/TEMP"), undefined);
    assert.equal(parseTopic("dtck/p/d1"), undefined);
  });

  it("lists every filter that can match an incoming topic", () => {
    assert.deepEqual(dispatchKeys("dtck/p/d1/TEMP"), [
      "dtck/p/d1/TEMP",
      "dtck/p/d1/+",
      "dtck/p/+/TEMP",
      "dtck/p/+/+",
    ]);
    assert.deepEqual(dispatchKeys("other/topic"), ["other/topic"]);
  });
});
