import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatStatusValue,
  inSettings,
  isLoop,
  outSettings,
  type DatacakeInDef,
  type DatacakeOutDef,
} from "../../src/lib/settings";

const base = { id: "n1", type: "x", name: "", z: "f1", datacakeConfiguration: "c1" };

describe("settings of 0.x nodes", () => {
  it("datacake-in keeps one device and string payloads", () => {
    const legacy = { ...base, productSlug: "p", deviceId: "d1", fieldName: "+" } as DatacakeInDef;
    assert.deepEqual(inSettings(legacy), { source: "device", payloadType: "string" });
  });

  it("datacake-in uses the new options when set", () => {
    const node = { ...base, source: "product", payloadType: "auto" } as DatacakeInDef;
    assert.deepEqual(inSettings(node), { source: "product", payloadType: "auto" });
  });

  it("datacake-out with device and field stays fixed", () => {
    const legacy = {
      ...base,
      productSlug: "p",
      deviceId: "d1",
      fieldName: "TEMP",
    } as DatacakeOutDef;
    assert.deepEqual(outSettings(legacy), { target: "configured", fieldMode: "fixed" });
  });

  it("datacake-out 'Pass deviceId in msg object' takes the device from msg", () => {
    const legacy = { ...base, productSlug: "p", deviceId: "", fieldName: "TEMP" } as DatacakeOutDef;
    assert.deepEqual(outSettings(legacy), { target: "msg", fieldMode: "fixed" });
  });

  it("datacake-out 'All Measurements' takes the field from msg", () => {
    const legacy = { ...base, productSlug: "p", deviceId: "d1", fieldName: "+" } as DatacakeOutDef;
    assert.deepEqual(outSettings(legacy), { target: "configured", fieldMode: "msg" });
  });

  it("datacake-out uses explicit modes when set", () => {
    const node = { ...base, deviceId: "d1", target: "msg", fieldMode: "payload" } as DatacakeOutDef;
    assert.deepEqual(outSettings(node), { target: "msg", fieldMode: "payload" });
  });
});

describe("isLoop", () => {
  it("detects a message written back to its own device and field", () => {
    const origin = { deviceId: "d1", fieldName: "TEMP" };
    assert.equal(isLoop(origin, "d1", "TEMP"), true);
    assert.equal(isLoop(origin, "d1", "HUM"), false);
    assert.equal(isLoop(origin, "d2", "TEMP"), false);
    assert.equal(isLoop(undefined, "d1", "TEMP"), false);
    assert.equal(isLoop("text", "d1", "TEMP"), false);
  });
});

describe("formatStatusValue", () => {
  it("adds the unit and shortens long values", () => {
    assert.equal(formatStatusValue(4.2, "°C"), "4.2 °C");
    assert.equal(formatStatusValue(true), "true");
    assert.equal(formatStatusValue("x".repeat(40)).length, 24);
  });
});
