import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import helper from "node-red-node-test-helper";
import configNodeModule from "../../src/datacake-configuration";
import mqttNodesModule from "../../src/datacake-mqtt";
import type { DatacakeConfigurationNode } from "../../src/lib/config-node";
import { startBroker, type TestBroker } from "../support/broker";
import { DEVICES, startFakeApi, TOKEN, WORKSPACE_ID, type FakeApi } from "../support/fake-api";
import { delay, waitFor } from "../support/wait";

helper.init(require.resolve("node-red"));

const NODES = [configNodeModule, mqttNodesModule];
const D1 = DEVICES[0].id;
const D2 = DEVICES[1].id;
const CONFIG = {
  id: "cfg",
  type: "datacake-configuration",
  workspaceId: WORKSPACE_ID,
  workspaceName: "Test Workspace",
};
const CREDENTIALS = { cfg: { apiToken: TOKEN } };

type Msg = Record<string, unknown> & { payload: unknown; datacake?: Record<string, unknown> };
type FlowNode = Record<string, unknown> & { id: string; type: string };

function inNode(id: string, props: Record<string, unknown>, wires: string[] = ["out"]): FlowNode {
  return {
    id,
    type: "datacake-in",
    z: "f1",
    datacakeConfiguration: "cfg",
    productSlug: "cold-room",
    wires: [wires],
    ...props,
  };
}

function outNode(id: string, props: Record<string, unknown>): FlowNode {
  return {
    id,
    type: "datacake-out",
    z: "f1",
    datacakeConfiguration: "cfg",
    productSlug: "cold-room",
    wires: [],
    ...props,
  };
}

const capture: FlowNode = { id: "out", type: "helper", z: "f1" };

describe("datacake nodes in Node-RED", () => {
  let broker: TestBroker;
  let api: FakeApi;

  before(async () => {
    broker = await startBroker();
    api = await startFakeApi();
    process.env.DATACAKE_MQTT_URL = broker.url;
    process.env.DATACAKE_API_URL = api.url;
    await helper.startServer();
  });

  after(async () => {
    await helper.stopServer();
    await broker.close();
    await api.close();
  });

  afterEach(async () => {
    await helper.unload();
    await waitFor(() => broker.broker.connectedClients === 0, "connections closed after unload");
  });

  function config(): DatacakeConfigurationNode {
    return helper.getNode("cfg") as DatacakeConfigurationNode;
  }

  function topicsOfClient(): Set<string> {
    const clientId = config().connection?.client?.options.clientId as string;
    return broker.subscriptions.get(clientId) ?? new Set();
  }

  async function connected(): Promise<void> {
    await waitFor(() => !!config()?.connection?.connected, "connected to broker");
  }

  function collect(nodeId = "out"): Msg[] {
    const messages: Msg[] = [];
    helper.getNode(nodeId).on("input", (msg: Msg) => messages.push(msg));
    return messages;
  }

  function errorsOf(nodeId: string): string[] {
    const errors: string[] = [];
    helper.getNode(nodeId).on("call:error", (call: { args: unknown[] }) => {
      const err = call.args[0];
      errors.push(err instanceof Error ? err.message : String(err));
    });
    return errors;
  }

  describe("datacake in", () => {
    it("emits typed values with device and field details", async () => {
      await helper.load(
        NODES,
        [CONFIG, inNode("in1", { deviceId: D1, fieldName: "+", payloadType: "auto" }), capture],
        CREDENTIALS,
      );
      const messages = collect();
      await waitFor(() => topicsOfClient().has(`dtck/cold-room/${D1}/+`), "subscribed");

      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "4.2");
      await broker.publish(`dtck/cold-room/${D1}/DOOR_OPEN`, "true");
      await broker.publish(`dtck/cold-room/${D1}/NOTE`, "123");
      await waitFor(() => messages.length === 3, "three messages");

      const [temperature, door, note] = messages;
      assert.equal(temperature.payload, 4.2);
      assert.equal(temperature.topic, `dtck/cold-room/${D1}/TEMPERATURE`);
      assert.equal(temperature.deviceId, D1);
      assert.equal(temperature.productSlug, "cold-room");
      assert.equal(temperature.fieldName, "TEMPERATURE");
      assert.deepEqual(temperature.datacake, {
        topic: `dtck/cold-room/${D1}/TEMPERATURE`,
        productSlug: "cold-room",
        productName: "Cold Room Sensor",
        deviceId: D1,
        deviceName: "Cold Room 1",
        fieldName: "TEMPERATURE",
        fieldLabel: "Temperature",
        unit: "°C",
      });
      assert.equal(door.payload, true);
      assert.equal(note.payload, "123", "STRING fields stay text even if they look numeric");
    });

    it("keeps 0.x behaviour for old nodes and plaintext tokens", async () => {
      // Exactly what 0.1.6 stored: token in the flow, no payloadType.
      const legacyConfig = { ...CONFIG, apiKey: TOKEN };
      await helper.load(
        NODES,
        [legacyConfig, inNode("in1", { deviceId: D1, fieldName: "TEMPERATURE" }), capture],
        {},
      );
      const messages = collect();
      await waitFor(() => topicsOfClient().has(`dtck/cold-room/${D1}/TEMPERATURE`), "subscribed");
      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "4.2");
      await waitFor(() => messages.length === 1, "message");
      assert.equal(messages[0].payload, "4.2");
      assert.equal(messages[0].deviceId, D1);
      assert.equal(messages[0].fieldName, "TEMPERATURE");
    });

    it("receives all devices of a product", async () => {
      await helper.load(
        NODES,
        [
          CONFIG,
          inNode("in1", { source: "product", fieldName: "TEMPERATURE", payloadType: "auto" }),
          capture,
        ],
        CREDENTIALS,
      );
      const messages = collect();
      await waitFor(() => topicsOfClient().has("dtck/cold-room/+/TEMPERATURE"), "subscribed");
      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "1");
      await broker.publish(`dtck/cold-room/${D2}/TEMPERATURE`, "2");
      await broker.publish(`dtck/cold-room/${D2}/DOOR_OPEN`, "true");
      await waitFor(() => messages.length === 2, "two messages");
      await delay(50);
      assert.equal(messages.length, 2, "other fields are not delivered");
      assert.deepEqual(
        messages.map((m) => [m.datacake?.deviceName, m.payload]),
        [
          ["Cold Room 1", 1],
          ["Cold Room 2", 2],
        ],
      );
    });

    it("looks up the devices of all nodes in one request", async () => {
      const batchesBefore = api.deviceBatches.length;
      await helper.load(
        NODES,
        [
          CONFIG,
          inNode("in1", { deviceId: D1, fieldName: "+" }),
          inNode("in2", { deviceId: D2, fieldName: "+" }),
          outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE" }),
          capture,
        ],
        CREDENTIALS,
      );
      await waitFor(() => api.deviceBatches.length > batchesBefore, "lookup");
      await delay(100);
      const batches = api.deviceBatches.slice(batchesBefore);
      assert.equal(batches.length, 1);
      assert.deepEqual([...batches[0]].sort(), [D1, D2].sort());
    });

    it("subscribes a node added by a partial deploy right away", async () => {
      const base = [CONFIG, outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE" }), capture];
      await helper.load(NODES, base, CREDENTIALS);
      await connected();
      await helper.setFlows(
        [...base, inNode("in1", { deviceId: D1, fieldName: "TEMPERATURE" })],
        "nodes",
        CREDENTIALS,
      );
      const messages = collect();
      await waitFor(() => topicsOfClient().has(`dtck/cold-room/${D1}/TEMPERATURE`), "subscribed");
      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "7");
      await waitFor(() => messages.length === 1, "message");
    });

    it("does not crash without configuration or token", async () => {
      await helper.load(
        NODES,
        [
          { ...CONFIG, id: "empty" },
          inNode("in1", { deviceId: D1, datacakeConfiguration: "missing" }),
          inNode("in2", { deviceId: D1, datacakeConfiguration: "empty" }),
          inNode("in3", { deviceId: "", fieldName: "+" }),
          capture,
        ],
        CREDENTIALS,
      );
      const statuses = ["in1", "in2"].map((id) => {
        const node = helper.getNode(id);
        return node.status.lastCall?.args[0];
      });
      assert.deepEqual(
        statuses.map((s: { fill: string }) => s.fill),
        ["red", "red"],
      );
      assert.equal(helper.getNode("in3").status.lastCall?.args[0].fill, "red");
    });
  });

  describe("datacake out", () => {
    async function send(nodeId: string, msg: Msg): Promise<void> {
      helper.getNode(nodeId).receive(msg);
      await delay(30);
    }

    function publishedTo(topic: string): string[] {
      return broker.published.filter((m) => m.topic === topic).map((m) => m.payload);
    }

    it("writes a value to the configured device and field", async () => {
      await helper.load(
        NODES,
        [CONFIG, outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE" })],
        CREDENTIALS,
      );
      await connected();
      await send("o1", { payload: 21.5 });
      await waitFor(
        () => publishedTo(`dtck-pub/cold-room/${D1}/TEMPERATURE`).includes("21.5"),
        "published",
      );
    });

    it("reports invalid payloads through done(err) instead of crashing", async () => {
      await helper.load(
        NODES,
        [CONFIG, outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE" })],
        CREDENTIALS,
      );
      await connected();
      const errors = errorsOf("o1");
      await send("o1", { payload: null });
      await send("o1", { payload: { a: 1 } });
      await waitFor(() => errors.length === 2, "two errors");
    });

    it("publishes one message per field of an object payload", async () => {
      await helper.load(
        NODES,
        [CONFIG, outNode("o1", { deviceId: D1, fieldName: "", fieldMode: "payload" })],
        CREDENTIALS,
      );
      await connected();
      const before = broker.published.length;
      await send("o1", { payload: { TEMPERATURE: 20, door_open: true, UNKNOWN: 1 } });
      await waitFor(() => broker.published.length - before === 2, "two publishes");
      await delay(50);
      assert.deepEqual(broker.published.slice(before), [
        { topic: `dtck-pub/cold-room/${D1}/TEMPERATURE`, payload: "20" },
        { topic: `dtck-pub/cold-room/${D1}/DOOR_OPEN`, payload: "true" },
      ]);
    });

    it("takes device and field from msg and resolves the product", async () => {
      await helper.load(
        NODES,
        [CONFIG, outNode("o1", { productSlug: "", deviceId: "", target: "msg", fieldMode: "msg" })],
        CREDENTIALS,
      );
      await connected();
      await send("o1", { payload: 5, deviceId: D2, fieldName: "TEMPERATURE" });
      await waitFor(
        () => publishedTo(`dtck-pub/cold-room/${D2}/TEMPERATURE`).includes("5"),
        "published",
      );
    });

    it("keeps the 0.x option 'Pass deviceId in msg object' working", async () => {
      await helper.load(
        NODES,
        [CONFIG, outNode("o1", { deviceId: "", fieldName: "TEMPERATURE" })],
        CREDENTIALS,
      );
      await connected();
      await send("o1", { payload: 6, deviceId: D2 });
      await waitFor(
        () => publishedTo(`dtck-pub/cold-room/${D2}/TEMPERATURE`).includes("6"),
        "published",
      );
    });

    it("never writes a value back to the field it came from", async () => {
      await helper.load(
        NODES,
        [
          CONFIG,
          inNode("in1", { deviceId: D1, fieldName: "TEMPERATURE" }, ["o1"]),
          outNode("o1", { productSlug: "", deviceId: "", target: "msg", fieldMode: "msg" }),
        ],
        CREDENTIALS,
      );
      const errors = errorsOf("o1");
      await waitFor(() => topicsOfClient().has(`dtck/cold-room/${D1}/TEMPERATURE`), "subscribed");
      const before = broker.published.length;
      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "4");
      await waitFor(() => errors.length === 1, "loop reported");
      assert.match(errors[0], /loop/);
      assert.equal(broker.published.length, before, "nothing published");
    });

    it("fails messages while the account is missing", async () => {
      await helper.load(
        NODES,
        [outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE", datacakeConfiguration: "x" })],
        CREDENTIALS,
      );
      const errors = errorsOf("o1");
      await send("o1", { payload: 1 });
      await waitFor(() => errors.length >= 1, "error");
    });
  });

  describe("resources across deploys", () => {
    const flow = (name = "") => [
      CONFIG,
      inNode("in1", { name, deviceId: D1, fieldName: "TEMPERATURE" }),
      inNode("in2", { deviceId: D2, fieldName: "+" }),
      inNode("in3", { source: "product", fieldName: "DOOR_OPEN" }),
      outNode("o1", { deviceId: D1, fieldName: "TEMPERATURE" }),
      capture,
    ];
    const topics = [
      `dtck/cold-room/${D1}/TEMPERATURE`,
      `dtck/cold-room/${D2}/+`,
      "dtck/cold-room/+/DOOR_OPEN",
    ];

    it("keeps one connection and one set of listeners over 100 full and 100 partial deploys", async () => {
      await helper.load(NODES, flow(), CREDENTIALS);
      await connected();
      await waitFor(() => topics.every((t) => topicsOfClient().has(t)), "subscribed");

      for (let i = 0; i < 100; i++) {
        await helper.setFlows(flow(), "full", CREDENTIALS);
      }
      await connected();
      await waitFor(() => broker.broker.connectedClients === 1, "a single connection");
      await waitFor(() => topics.every((t) => topicsOfClient().has(t)), "subscribed again");

      const configBefore = config();
      const subscribesBefore = broker.subscribeCount.get(topics[0]);
      for (let i = 0; i < 100; i++) {
        // Renaming restarts only in1; the configuration node and its connection stay.
        await helper.setFlows(flow(`rename ${i}`), "nodes", CREDENTIALS);
      }
      assert.equal(config(), configBefore);
      assert.equal(broker.broker.connectedClients, 1);
      assert.equal(config().connection?.client?.listenerCount("message"), 1);
      assert.equal(
        broker.subscribeCount.get(topics[0]),
        subscribesBefore,
        "the redeployed node reuses the existing subscription",
      );

      const messages = collect();
      await broker.publish(`dtck/cold-room/${D1}/TEMPERATURE`, "9");
      await waitFor(() => messages.length === 1, "message after the deploys");
      await delay(50);
      assert.equal(messages.length, 1, "exactly one message, no stale handlers");
    });

    it("unsubscribes topics of removed nodes", async () => {
      await helper.load(NODES, flow(), CREDENTIALS);
      await waitFor(() => topics.every((t) => topicsOfClient().has(t)), "subscribed");
      const withoutIn2 = flow().filter((n) => n.id !== "in2");
      await helper.setFlows(withoutIn2, "nodes", CREDENTIALS);
      await waitFor(() => !topicsOfClient().has(topics[1]), "in2 unsubscribed", 5000);
      assert.ok(topicsOfClient().has(topics[0]));
    });
  });

  describe("editor endpoints", () => {
    it("look up names with the stored token and never return it", async () => {
      await helper.load(NODES, [CONFIG, capture], CREDENTIALS);
      const res = await helper
        .request()
        .post("/datacake/names")
        .send({ configId: "cfg", deviceIds: [D1, "unknown"] })
        .expect(200);
      assert.equal(res.body.devices[D1].name, "Cold Room 1");
      assert.equal(res.body.devices[D1].fields.TEMPERATURE, "Temperature");
      assert.equal(res.body.devices.unknown, undefined);
      assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    });

    it("search devices and list products and workspaces", async () => {
      await helper.load(NODES, [CONFIG, capture], CREDENTIALS);
      const devices = await helper
        .request()
        .post("/datacake/devices")
        .send({ configId: "cfg", workspaceId: WORKSPACE_ID, search: "2" })
        .expect(200);
      assert.deepEqual(
        devices.body.devices.map((d: { name: string }) => d.name),
        ["Cold Room 2"],
      );
      const products = await helper
        .request()
        .post("/datacake/products")
        .send({ configId: "cfg", workspaceId: WORKSPACE_ID })
        .expect(200);
      assert.equal(products.body[0].fields.length, 3);
      // A token typed into a configuration node that is not deployed yet.
      const workspaces = await helper
        .request()
        .post("/datacake/workspaces")
        .send({ token: TOKEN })
        .expect(200);
      assert.deepEqual(workspaces.body, [{ id: WORKSPACE_ID, name: "Test Workspace" }]);
    });

    it("work with the plaintext token of 0.x configurations", async () => {
      await helper.load(NODES, [{ ...CONFIG, apiKey: TOKEN }, capture], {});
      await helper
        .request()
        .post("/datacake/workspaces")
        .send({ configId: "cfg", token: "__PWRD__" })
        .expect(200);
    });

    it("refuse requests without a token", async () => {
      await helper.load(NODES, [capture], {});
      const res = await helper.request().post("/datacake/workspaces").send({}).expect(400);
      assert.equal(res.body.error, "no_token");
    });
  });
});
