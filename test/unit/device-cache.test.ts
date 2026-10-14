import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeviceCache, type CacheSource } from "../../src/lib/device-cache";
import type { DeviceInfo, ProductInfo } from "../../src/lib/graphql";
import { delay } from "../support/wait";

const product: ProductInfo = {
  id: "p1",
  name: "Product",
  slug: "prod",
  fields: [{ fieldName: "TEMP", label: "Temperature", fieldType: "FLOAT", unit: "°C" }],
};
const device = (id: string): DeviceInfo => ({ id, name: `Device ${id}`, product });

function source(overrides: Partial<CacheSource> = {}) {
  const batches: string[][] = [];
  let productCalls = 0;
  const src: CacheSource = {
    devices: async (ids) => {
      batches.push(ids);
      return ids.filter((id) => id !== "missing").map(device);
    },
    products: async () => {
      productCalls++;
      return [product];
    },
    ...overrides,
  };
  return { src, batches, productCalls: () => productCalls };
}

describe("DeviceCache", () => {
  it("batches concurrent lookups into one request", async () => {
    const { src, batches } = source();
    const cache = new DeviceCache(src, { batchDelayMs: 5 });
    const [a, b, c] = await Promise.all([cache.device("a"), cache.device("b"), cache.device("a")]);
    assert.equal(a?.name, "Device a");
    assert.equal(b?.name, "Device b");
    assert.equal(c, a);
    assert.deepEqual(batches, [["a", "b"]]);
  });

  it("caches results, including unknown devices", async () => {
    const { src, batches } = source();
    const cache = new DeviceCache(src, { batchDelayMs: 1 });
    assert.equal(await cache.device("missing"), undefined);
    assert.equal(await cache.device("missing"), undefined);
    await cache.device("x");
    await cache.device("x");
    assert.equal(batches.length, 2);
  });

  it("knows the product and its fields after a device lookup", async () => {
    const cache = new DeviceCache(source().src, { batchDelayMs: 1 });
    await cache.device("a");
    assert.equal(cache.peekField("prod", "TEMP")?.unit, "°C");
  });

  it("returns stale entries immediately and refreshes them in the background", async () => {
    let now = 0;
    const { src, batches } = source();
    const cache = new DeviceCache(src, { batchDelayMs: 1, ttlMs: 100, now: () => now });
    await cache.device("a");
    now = 1000;
    assert.equal((await cache.device("a"))?.name, "Device a");
    await delay(10);
    assert.equal(batches.length, 2);
  });

  it("gives up waiting after waitMs but keeps the request running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { src } = source({
      devices: async (ids) => {
        await gate;
        return ids.map(device);
      },
    });
    const cache = new DeviceCache(src, { batchDelayMs: 1 });
    assert.equal(await cache.device("slow", 20), undefined);
    release();
    await delay(10);
    assert.equal(cache.peekDevice("slow")?.name, "Device slow");
  });

  it("survives API errors", async () => {
    const cache = new DeviceCache(
      {
        devices: () => Promise.reject(new Error("down")),
        products: () => Promise.reject(new Error("down")),
      },
      { batchDelayMs: 1 },
    );
    assert.equal(await cache.device("a"), undefined);
    assert.equal(await cache.product("prod"), undefined);
  });

  it("loads products once and remembers unknown slugs", async () => {
    const { src, productCalls } = source();
    const cache = new DeviceCache(src);
    assert.equal((await cache.product("prod"))?.name, "Product");
    assert.equal(await cache.product("unknown"), undefined);
    assert.equal(await cache.product("unknown"), undefined);
    assert.equal(productCalls(), 2);
  });
});
