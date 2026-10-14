import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  DatacakeConnection,
  type ConnectionState,
  type ConnectionUser,
} from "../../src/lib/connection";
import { startBroker, type TestBroker } from "../support/broker";
import { delay, waitFor } from "../support/wait";

const quietLog = { debug: () => undefined, warn: () => undefined };

function user(id: string): ConnectionUser & { states: ConnectionState[] } {
  const states: ConnectionState[] = [];
  return { id, states, onState: (state) => states.push(state) };
}

describe("DatacakeConnection", () => {
  let broker: TestBroker;

  before(async () => {
    broker = await startBroker();
  });
  after(async () => {
    await broker.close();
  });

  function connection(options: Partial<ConstructorParameters<typeof DatacakeConnection>[0]> = {}) {
    return new DatacakeConnection({
      url: broker.url,
      token: "token",
      log: quietLog,
      unsubscribeDelayMs: 50,
      idleDisconnectMs: 50,
      reconnectPeriodMs: 50,
      ...options,
    });
  }

  function brokerTopics(conn: DatacakeConnection): Set<string> {
    const clientId = conn.client?.options.clientId as string;
    return broker.subscriptions.get(clientId) ?? new Set();
  }

  it("connects lazily, shares one subscription and dispatches by wildcard", async () => {
    const conn = connection();
    // No connection before the first node registers.
    assert.equal(conn.state, "disconnected");
    assert.equal(broker.broker.connectedClients, 0);
    const a = user("a");
    const b = user("b");
    conn.register(a);
    conn.register(b);
    await waitFor(() => conn.connected, "connected");
    assert.deepEqual(a.states.slice(-1), ["connected"]);

    const received: string[] = [];
    conn.subscribe("a", "dtck/p/d1/TEMP", (t, p) => received.push(`a:${t}=${p}`));
    conn.subscribe("b", "dtck/p/d1/TEMP", (t, p) => received.push(`b:${t}=${p}`));
    conn.subscribe("b", "dtck/p/+/+", (t, p) => received.push(`b+:${t}=${p}`));
    await waitFor(() => brokerTopics(conn).size === 2, "broker subscriptions");
    assert.equal(broker.subscribeCount.get("dtck/p/d1/TEMP"), 1);

    await broker.publish("dtck/p/d1/TEMP", "21.5");
    await broker.publish("dtck/p/d2/HUM", "40");
    await waitFor(() => received.length === 4, "messages dispatched");
    assert.deepEqual(received.sort(), [
      "a:dtck/p/d1/TEMP=21.5",
      "b+:dtck/p/d1/TEMP=21.5",
      "b+:dtck/p/d2/HUM=40",
      "b:dtck/p/d1/TEMP=21.5",
    ]);
    assert.equal(conn.client?.listenerCount("message"), 1);
    await conn.close();
  });

  it("subscribes immediately when a node is added to an open connection", async () => {
    const conn = connection();
    conn.register(user("a"));
    await waitFor(() => conn.connected, "connected");
    const received: string[] = [];
    conn.register(user("late"));
    conn.subscribe("late", "dtck/p/late/+", (_t, p) => received.push(p.toString()));
    await waitFor(() => brokerTopics(conn).has("dtck/p/late/+"), "late subscription");
    await broker.publish("dtck/p/late/X", "1");
    await waitFor(() => received.length === 1, "late message");
    await conn.close();
  });

  it("unsubscribes unused topics after a delay, unless a node takes them over", async () => {
    const conn = connection();
    conn.register(user("a"));
    conn.subscribe("a", "dtck/p/d1/+", () => undefined);
    conn.subscribe("a", "dtck/p/d2/+", () => undefined);
    await waitFor(() => brokerTopics(conn).size === 2, "subscribed");

    // A redeployed node re-registers the same topic: no gap, no second SUBSCRIBE.
    conn.unsubscribe("a", "dtck/p/d1/+");
    conn.subscribe("a2", "dtck/p/d1/+", () => undefined);
    conn.unsubscribe("a", "dtck/p/d2/+");
    await delay(150);
    assert.deepEqual([...brokerTopics(conn)], ["dtck/p/d1/+"]);
    assert.equal(broker.subscribeCount.get("dtck/p/d1/+"), 1);
    await conn.close();
  });

  it("resubscribes after the broker dropped the connection", async () => {
    const conn = connection();
    const a = user("a");
    conn.register(a);
    const received: string[] = [];
    conn.subscribe("a", "dtck/p/re/+", (_t, p) => received.push(p.toString()));
    await waitFor(() => brokerTopics(conn).has("dtck/p/re/+"), "subscribed");

    broker.dropConnections();
    await waitFor(() => a.states.includes("disconnected"), "disconnected state");
    await waitFor(() => conn.connected && brokerTopics(conn).has("dtck/p/re/+"), "resubscribed");
    await broker.publish("dtck/p/re/X", "after");
    await waitFor(() => received.includes("after"), "message after reconnect");
    assert.equal(conn.client?.listenerCount("message"), 1);
    await conn.close();
  });

  it("rejects publishes while disconnected instead of queueing them", async () => {
    const conn = connection({ url: "mqtt://127.0.0.1:1" });
    conn.register(user("a"));
    await assert.rejects(conn.publish("dtck-pub/p/d/F", "1"), /Not connected/);
    await conn.close();
  });

  it("publishes while connected", async () => {
    const conn = connection();
    conn.register(user("a"));
    await waitFor(() => conn.connected, "connected");
    await conn.publish("dtck-pub/p/d1/TEMP", "22");
    await waitFor(
      () => broker.published.some((m) => m.topic === "dtck-pub/p/d1/TEMP" && m.payload === "22"),
      "published",
    );
    await conn.close();
  });

  it("closes the client and removes every listener", async () => {
    const conn = connection();
    conn.register(user("a"));
    await waitFor(() => conn.connected, "connected");
    const client = conn.client!;
    const before = broker.broker.connectedClients;
    await conn.close();
    assert.ok(!conn.client);
    // mqtt.js keeps its own internal connect/close listeners; ours must all be gone.
    for (const event of ["message", "offline", "reconnect"] as const) {
      assert.equal(client.listenerCount(event), 0, event);
    }
    await waitFor(() => broker.broker.connectedClients === before - 1, "client gone");
  });

  it("disconnects when the last node is gone", async () => {
    const conn = connection();
    const a = user("a");
    conn.register(a);
    await waitFor(() => conn.connected, "connected");
    conn.deregister(a);
    await waitFor(() => conn.client === undefined, "idle disconnect");
    // A new node opens a new connection.
    conn.register(user("b"));
    await waitFor(() => conn.connected, "reconnected");
    await conn.close();
  });
});
