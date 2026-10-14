import { createServer, type AddressInfo, type Socket } from "node:net";
import Aedes from "aedes";

export interface TestBroker {
  url: string;
  broker: Aedes;
  /** Topics each connected client is subscribed to, as seen by the broker. */
  subscriptions: Map<string, Set<string>>;
  /** Messages published by clients (not by the broker itself). */
  published: { topic: string; payload: string }[];
  /** Number of SUBSCRIBE requests per topic, over the whole lifetime of the broker. */
  subscribeCount: Map<string, number>;
  publish(topic: string, payload: string): Promise<void>;
  /** Drops every client connection, as a broker restart would. */
  dropConnections(): void;
  close(): Promise<void>;
}

export async function startBroker(): Promise<TestBroker> {
  const broker = new Aedes();
  const subscriptions = new Map<string, Set<string>>();
  const subscribeCount = new Map<string, number>();
  const published: { topic: string; payload: string }[] = [];
  const sockets = new Set<Socket>();

  broker.on("subscribe", (subs, client) => {
    const set = subscriptions.get(client.id) ?? new Set<string>();
    for (const sub of subs) {
      set.add(sub.topic);
      subscribeCount.set(sub.topic, (subscribeCount.get(sub.topic) ?? 0) + 1);
    }
    subscriptions.set(client.id, set);
  });
  broker.on("unsubscribe", (topics, client) => {
    for (const topic of topics) {
      subscriptions.get(client.id)?.delete(topic);
    }
  });
  broker.on("clientDisconnect", (client) => subscriptions.delete(client.id));
  broker.on("publish", (packet, client) => {
    if (client) {
      published.push({ topic: packet.topic, payload: packet.payload.toString() });
    }
  });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    broker.handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `mqtt://127.0.0.1:${port}`,
    broker,
    subscriptions,
    published,
    subscribeCount,
    publish(topic, payload) {
      return new Promise((resolve, reject) =>
        broker.publish(
          {
            cmd: "publish",
            topic,
            payload: Buffer.from(payload),
            qos: 0,
            retain: false,
            dup: false,
          },
          (err) => (err ? reject(err) : resolve()),
        ),
      );
    },
    dropConnections() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
}
