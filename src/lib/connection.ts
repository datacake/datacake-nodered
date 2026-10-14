import { randomBytes } from "node:crypto";
import { connect as mqttConnect } from "mqtt";
import type { IClientOptions, ISubscriptionGrant, MqttClient } from "mqtt";
import { dispatchKeys } from "./topics";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface ConnectionUser {
  id: string;
  /** Called on every state change and once on register. `detail` carries the last broker error. */
  onState(state: ConnectionState, detail?: string): void;
}

export type MessageHandler = (topic: string, payload: Buffer) => void;
export type SubscribeErrorHandler = (message: string) => void;

export interface ConnectionLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface ConnectionOptions {
  url: string;
  token: string;
  log: ConnectionLogger;
  /** Delay before an unused topic is unsubscribed; a redeployed node re-registering in time keeps it. */
  unsubscribeDelayMs?: number;
  /** Delay before the connection is closed once the last node is gone. */
  idleDisconnectMs?: number;
  reconnectPeriodMs?: number;
  connectFn?: (url: string, options: IClientOptions) => MqttClient;
}

interface Subscriber {
  handler: MessageHandler;
  onError?: SubscribeErrorHandler;
}

type ClientEvent = "connect" | "reconnect" | "close" | "offline" | "error" | "message";

/**
 * One MQTT connection per configuration node, shared by all datacake-in/-out nodes using it.
 *
 * The client gets exactly one set of listeners. Nodes register for state changes and subscribe
 * topics with a handler; subscriptions are reference counted, so the broker sees each topic once
 * and topics nobody uses any more are unsubscribed.
 */
export class DatacakeConnection {
  private mqtt: MqttClient | undefined;
  private readonly listeners: [ClientEvent, (...args: never[]) => void][] = [];
  private readonly users = new Map<string, ConnectionUser>();
  private readonly subscriptions = new Map<string, Map<string, Subscriber>>();
  private readonly pendingUnsubscribes = new Map<string, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | undefined;
  private currentState: ConnectionState = "disconnected";
  private lastError: string | undefined;
  private closed = false;
  private readonly unsubscribeDelayMs: number;
  private readonly idleDisconnectMs: number;

  constructor(private readonly options: ConnectionOptions) {
    this.unsubscribeDelayMs = options.unsubscribeDelayMs ?? 2000;
    this.idleDisconnectMs = options.idleDisconnectMs ?? 5000;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get connected(): boolean {
    return this.currentState === "connected";
  }

  /** The underlying client; exposed for diagnostics and tests. */
  get client(): MqttClient | undefined {
    return this.mqtt;
  }

  /** Topics currently subscribed at the broker (including ones waiting for a delayed unsubscribe). */
  get subscribedTopics(): string[] {
    return [...new Set([...this.subscriptions.keys(), ...this.pendingUnsubscribes.keys()])];
  }

  register(user: ConnectionUser): void {
    if (this.closed) {
      return;
    }
    this.users.set(user.id, user);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (!this.mqtt) {
      this.connect();
    }
    user.onState(this.currentState, this.lastError);
  }

  deregister(user: ConnectionUser): void {
    if (this.users.get(user.id) !== user) {
      return;
    }
    this.users.delete(user.id);
    for (const topic of [...this.subscriptions.keys()]) {
      this.unsubscribe(user.id, topic);
    }
    if (this.users.size === 0 && this.mqtt && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        if (this.users.size === 0) {
          this.options.log.debug("No Datacake nodes left, closing MQTT connection");
          void this.disconnect();
        }
      }, this.idleDisconnectMs);
    }
  }

  subscribe(
    userId: string,
    topic: string,
    handler: MessageHandler,
    onError?: SubscribeErrorHandler,
  ): void {
    if (this.closed) {
      return;
    }
    let subscribers = this.subscriptions.get(topic);
    if (!subscribers) {
      subscribers = new Map();
      this.subscriptions.set(topic, subscribers);
    }
    subscribers.set(userId, { handler, onError });

    const pending = this.pendingUnsubscribes.get(topic);
    if (pending) {
      // Still subscribed at the broker; the node was only redeployed.
      clearTimeout(pending);
      this.pendingUnsubscribes.delete(topic);
    } else if (subscribers.size === 1 && this.mqtt) {
      this.brokerSubscribe(topic);
    }
  }

  unsubscribe(userId: string, topic: string): void {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers?.delete(userId) || subscribers.size > 0) {
      return;
    }
    this.subscriptions.delete(topic);
    const timer = setTimeout(() => {
      this.pendingUnsubscribes.delete(topic);
      if (!this.subscriptions.has(topic)) {
        this.mqtt?.unsubscribe(topic);
      }
    }, this.unsubscribeDelayMs);
    this.pendingUnsubscribes.set(topic, timer);
  }

  publish(topic: string, payload: string): Promise<void> {
    const client = this.mqtt;
    if (!client || !this.connected) {
      return Promise.reject(new Error("Not connected to the Datacake MQTT broker"));
    }
    return new Promise((resolve, reject) => {
      client.publish(topic, payload, { qos: 0, retain: false }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Ends the connection for good; used when the configuration node closes. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const timer of this.pendingUnsubscribes.values()) {
      clearTimeout(timer);
    }
    this.pendingUnsubscribes.clear();
    this.subscriptions.clear();
    await this.disconnect();
    this.users.clear();
  }

  private connect(): void {
    const clientId = "cakered_mqtt_" + randomBytes(6).toString("hex");
    const connectFn = this.options.connectFn ?? mqttConnect;
    const client = connectFn(this.options.url, {
      clientId,
      username: this.options.token,
      password: this.options.token,
      protocolVersion: 4,
      clean: true,
      // mqtt.js queues subscribes while offline and re-sends them after a reconnect.
      resubscribe: true,
      reconnectPeriod: this.options.reconnectPeriodMs ?? 5000,
      connectTimeout: 30 * 1000,
      // Never buffer QoS 0 publishes while offline; the out node reports the error instead.
      queueQoSZero: false,
    });
    this.mqtt = client;
    this.setState("connecting");

    this.on(client, "connect", () => {
      this.lastError = undefined;
      this.setState("connected");
    });
    this.on(client, "reconnect", () => this.setState("connecting"));
    this.on(client, "close", () => this.setState("disconnected"));
    this.on(client, "offline", () => this.setState("disconnected"));
    this.on(client, "error", (err: Error) => {
      this.lastError = err.message;
      this.options.log.warn(`Datacake MQTT: ${err.message}`);
      this.setState(this.currentState);
    });
    this.on(client, "message", (topic: string, payload: Buffer) => this.dispatch(topic, payload));

    for (const topic of this.subscriptions.keys()) {
      this.brokerSubscribe(topic);
    }
  }

  private on<A extends unknown[]>(
    client: MqttClient,
    event: ClientEvent,
    listener: (...args: A) => void,
  ): void {
    client.on(event, listener as never);
    this.listeners.push([event, listener as never]);
  }

  private disconnect(): Promise<void> {
    const client = this.mqtt;
    if (!client) {
      return Promise.resolve();
    }
    this.mqtt = undefined;
    for (const timer of this.pendingUnsubscribes.values()) {
      clearTimeout(timer);
    }
    this.pendingUnsubscribes.clear();
    for (const [event, listener] of this.listeners) {
      client.removeListener(event, listener);
    }
    this.listeners.length = 0;
    // Swallow errors emitted while shutting down instead of crashing the process.
    client.on("error", () => undefined);
    this.setState("disconnected");
    return new Promise((resolve) => {
      const timer = setTimeout(() => client.end(true, () => resolve()), 2000);
      client.end(false, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private brokerSubscribe(topic: string): void {
    this.mqtt?.subscribe(topic, { qos: 0 }, (err, granted?: ISubscriptionGrant[]) => {
      let message: string | undefined;
      if (err) {
        message = err.message;
      } else if (granted?.some((g) => g.qos === 128)) {
        message = "Subscription not authorized";
      }
      if (message) {
        this.options.log.warn(`Datacake MQTT: could not subscribe to ${topic}: ${message}`);
        for (const subscriber of this.subscriptions.get(topic)?.values() ?? []) {
          subscriber.onError?.(message);
        }
      }
    });
  }

  private dispatch(topic: string, payload: Buffer): void {
    for (const key of dispatchKeys(topic)) {
      const subscribers = this.subscriptions.get(key);
      if (!subscribers) {
        continue;
      }
      for (const subscriber of subscribers.values()) {
        try {
          subscriber.handler(topic, payload);
        } catch (err) {
          this.options.log.warn(`Datacake MQTT: message handler failed: ${(err as Error).message}`);
        }
      }
    }
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    for (const user of this.users.values()) {
      user.onState(state, this.lastError);
    }
  }
}
