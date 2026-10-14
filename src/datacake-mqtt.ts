import type { Node, NodeAPI, NodeMessage, NodeMessageInFlow, NodeStatus } from "node-red";
import type { DatacakeConfigurationNode } from "./lib/config-node";
import type { ConnectionState, ConnectionUser, DatacakeConnection } from "./lib/connection";
import type { DeviceInfo } from "./lib/graphql";
import { parseIncoming, serializeValue, splitFields, type FieldValue } from "./lib/payload";
import {
  formatStatusTime,
  formatStatusValue,
  inSettings,
  isLoop,
  outSettings,
  type DatacakeInDef,
  type DatacakeMessageInfo,
  type DatacakeOutDef,
} from "./lib/settings";
import { ANY, isValidSegment, parseTopic, publishTopic, subscribeTopic } from "./lib/topics";

/** How long the first message of an unknown device waits for its name and field types. */
const LOOKUP_WAIT_MS = 2000;
/** How long an out node waits to resolve the product of a device given in msg.deviceId. */
const RESOLVE_WAIT_MS = 5000;
const MAX_STATUS_DETAIL = 40;

function truncate(text: string, max = MAX_STATUS_DETAIL): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export = function (RED: NodeAPI) {
  const t = (key: string, args?: Record<string, string>) =>
    RED._(`datacake-mqtt.${key}`, args) as string;

  function connectionStatus(state: ConnectionState, detail?: string): NodeStatus {
    switch (state) {
      case "connected":
        return { fill: "green", shape: "dot", text: t("status.connected") };
      case "connecting":
        return { fill: "yellow", shape: "ring", text: t("status.connecting") };
      default:
        return {
          fill: "red",
          shape: "ring",
          text: detail
            ? `${t("status.disconnected")}: ${truncate(detail)}`
            : t("status.disconnected"),
        };
    }
  }

  /** Shared setup: find the connection or show why there is none. */
  function attach(node: Node, configId: string): DatacakeConfigurationNode | undefined {
    const configNode = RED.nodes.getNode(configId) as DatacakeConfigurationNode | null;
    if (!configNode) {
      node.status({ fill: "red", shape: "ring", text: t("status.noConfig") });
      node.error(t("errors.noConfig"));
      return undefined;
    }
    if (!configNode.connection) {
      node.status({ fill: "red", shape: "ring", text: t("status.noToken") });
      node.error(t("errors.noToken"));
      return undefined;
    }
    return configNode;
  }

  function DatacakeIn(this: Node, config: DatacakeInDef) {
    RED.nodes.createNode(this, config);
    const node = this;
    const settings = inSettings(config);
    const configNode = attach(node, config.datacakeConfiguration);
    if (!configNode) {
      return;
    }
    const connection = configNode.connection as DatacakeConnection;

    let topic: string;
    try {
      topic = subscribeTopic(
        config.productSlug ?? "",
        settings.source === "product" ? ANY : (config.deviceId ?? ""),
        config.fieldName || ANY,
      );
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: t("status.invalidConfig") });
      node.error(`${t("errors.invalidConfig")}: ${(err as Error).message}`);
      return;
    }

    let state: ConnectionState = connection.state;
    let stateDetail: string | undefined;
    let subscribeError: string | undefined;
    let last: { value: string; time: Date } | undefined;
    let closed = false;
    let queue: Promise<void> = Promise.resolve();

    const render = () => {
      if (subscribeError) {
        node.status({
          fill: "red",
          shape: "ring",
          text: `${t("status.subscribeFailed")}: ${truncate(subscribeError)}`,
        });
        return;
      }
      const status = connectionStatus(state, stateDetail);
      if (state === "connected" && last) {
        status.text = `${status.text} · ${last.value} · ${formatStatusTime(last.time)}`;
      }
      node.status(status);
    };

    const user: ConnectionUser = {
      id: node.id,
      onState(newState, detail) {
        state = newState;
        stateDetail = detail;
        render();
      },
    };

    const handle = async (incomingTopic: string, raw: Buffer) => {
      const parts = parseTopic(incomingTopic);
      if (!parts) {
        return;
      }
      const cache = configNode.cache;
      const device: DeviceInfo | undefined = cache
        ? await cache.device(parts.deviceId, LOOKUP_WAIT_MS)
        : undefined;
      if (closed) {
        return;
      }
      const field =
        device?.product.fields.find((f) => f.fieldName === parts.fieldName) ??
        cache?.peekField(parts.productSlug, parts.fieldName);
      const payload = parseIncoming(raw, settings.payloadType, field?.fieldType);
      const info: DatacakeMessageInfo = {
        topic: incomingTopic,
        productSlug: parts.productSlug,
        productName: device?.product.name ?? cache?.peekProduct(parts.productSlug)?.name,
        deviceId: parts.deviceId,
        deviceName: device?.name,
        fieldName: parts.fieldName,
        fieldLabel: field?.label,
        unit: field?.unit,
      };
      node.send({
        topic: incomingTopic,
        payload,
        // Top-level properties as emitted by 0.x.
        deviceId: parts.deviceId,
        productSlug: parts.productSlug,
        fieldName: parts.fieldName,
        datacake: info,
      } as NodeMessage);
      last = { value: formatStatusValue(payload, field?.unit), time: new Date() };
      render();
    };

    connection.register(user);
    connection.subscribe(
      node.id,
      topic,
      (incomingTopic, raw) => {
        // Keep the order of messages even when the first one waits for a device lookup.
        queue = queue
          .then(() => handle(incomingTopic, raw))
          .catch((err: Error) => node.error(err.message));
      },
      (message) => {
        subscribeError = message;
        render();
      },
    );

    // Look up names and field types before the first message arrives.
    if (settings.source === "device" && config.deviceId) {
      void configNode.cache?.device(config.deviceId);
    } else if (config.productSlug) {
      void configNode.cache?.product(config.productSlug);
    }

    node.on("close", (_removed: boolean, done: () => void) => {
      closed = true;
      connection.unsubscribe(node.id, topic);
      connection.deregister(user);
      done();
    });
  }

  function DatacakeOut(this: Node, config: DatacakeOutDef) {
    RED.nodes.createNode(this, config);
    const node = this;
    const settings = outSettings(config);
    const dynamic = settings.target === "msg" || settings.fieldMode !== "fixed";
    const configNode = attach(node, config.datacakeConfiguration);

    let configError: string | undefined;
    if (!configNode) {
      configError = t("errors.noConfigOrToken");
    } else if (
      settings.target === "configured" &&
      !(isValidSegment(config.productSlug) && isValidSegment(config.deviceId))
    ) {
      configError = `${t("errors.invalidConfig")}: ${t("errors.noDevice")}`;
    } else if (settings.fieldMode === "fixed" && !isValidSegment(config.fieldName)) {
      configError = `${t("errors.invalidConfig")}: ${t("errors.noField")}`;
    }
    if (configNode && configError) {
      node.status({ fill: "red", shape: "ring", text: t("status.invalidConfig") });
      node.error(configError);
    }

    const connection = configError ? undefined : configNode?.connection;
    let state: ConnectionState = connection?.state ?? "disconnected";
    let stateDetail: string | undefined;
    let lastSent: Date | undefined;
    let warning: string | undefined;

    const render = () => {
      if (warning) {
        node.status({ fill: "yellow", shape: "dot", text: truncate(warning) });
        return;
      }
      const status = connectionStatus(state, stateDetail);
      if (state === "connected" && lastSent) {
        status.text = `${status.text} · ${t("status.sent")} ${formatStatusTime(lastSent)}`;
      }
      node.status(status);
    };

    const user: ConnectionUser = {
      id: node.id,
      onState(newState, detail) {
        state = newState;
        stateDetail = detail;
        render();
      },
    };

    async function resolveDevice(
      msg: NodeMessageInFlow & Record<string, unknown>,
    ): Promise<{ productSlug: string; deviceId: string; device?: DeviceInfo }> {
      const cache = configNode?.cache;
      if (settings.target === "configured") {
        const deviceId = config.deviceId as string;
        // Only the payload mode needs the field list, to validate the keys of msg.payload.
        const device =
          settings.fieldMode === "payload" && cache
            ? await cache.device(deviceId, RESOLVE_WAIT_MS)
            : cache?.peekDevice(deviceId);
        return { productSlug: config.productSlug as string, deviceId, device };
      }
      const deviceId = msg.deviceId;
      if (!isValidSegment(deviceId)) {
        throw new Error(t("errors.msgDeviceId"));
      }
      const device = cache ? await cache.device(deviceId, RESOLVE_WAIT_MS) : undefined;
      const productSlug =
        (isValidSegment(msg.productSlug) ? msg.productSlug : undefined) ??
        device?.product.slug ??
        // 0.x nodes stored the product of the device selected last; better than nothing.
        (isValidSegment(config.productSlug) ? config.productSlug : undefined);
      if (!productSlug) {
        throw new Error(t("errors.unknownProduct", { deviceId }));
      }
      return { productSlug, deviceId, device };
    }

    function collectValues(msg: NodeMessageInFlow & Record<string, unknown>, device?: DeviceInfo) {
      if (settings.fieldMode === "payload") {
        const { values, errors } = splitFields(msg.payload);
        const known = device?.product.fields;
        if (!known) {
          return { values, errors };
        }
        // Field identifiers are upper case in Datacake; accept other spellings, drop unknown ones.
        const resolved: FieldValue[] = [];
        for (const value of values) {
          const field =
            known.find((f) => f.fieldName === value.fieldName) ??
            known.find((f) => f.fieldName.toUpperCase() === value.fieldName.toUpperCase());
          if (field) {
            resolved.push({ fieldName: field.fieldName, value: value.value });
          } else {
            errors.push(t("errors.unknownField", { field: value.fieldName }));
          }
        }
        return { values: resolved, errors };
      }
      const fieldName = settings.fieldMode === "fixed" ? config.fieldName : msg.fieldName;
      if (!isValidSegment(fieldName)) {
        throw new Error(t("errors.msgFieldName"));
      }
      return {
        values: [{ fieldName, value: serializeValue(msg.payload) }],
        errors: [] as string[],
      };
    }

    node.on("input", (rawMsg: NodeMessageInFlow, _send: unknown, done: (err?: Error) => void) => {
      const msg = rawMsg as NodeMessageInFlow & Record<string, unknown>;
      if (!connection) {
        done(new Error(configError ?? t("errors.noConfigOrToken")));
        return;
      }
      (async () => {
        const target = await resolveDevice(msg);
        const { values, errors } = collectValues(msg, target.device);

        const publishes = values.filter((value) => {
          if (dynamic && isLoop(msg.datacake, target.deviceId, value.fieldName)) {
            errors.push(t("errors.loop", { field: value.fieldName }));
            return false;
          }
          return true;
        });
        if (publishes.length === 0) {
          throw new Error(errors.join("; ") || t("errors.nothingToSend"));
        }
        for (const value of publishes) {
          await connection.publish(
            publishTopic(target.productSlug, target.deviceId, value.fieldName),
            value.value,
          );
        }
        if (errors.length > 0) {
          node.warn(errors.join("; "));
          warning = errors[0];
        } else {
          warning = undefined;
        }
        lastSent = new Date();
        render();
      })().then(
        () => done(),
        (err: Error) => done(err),
      );
    });

    if (!connection) {
      return;
    }
    connection.register(user);
    if (settings.target === "configured" && config.deviceId) {
      void configNode?.cache?.device(config.deviceId);
    }

    node.on("close", (_removed: boolean, done: () => void) => {
      connection.deregister(user);
      done();
    });
  }

  RED.nodes.registerType("datacake-in", DatacakeIn);
  RED.nodes.registerType("datacake-out", DatacakeOut);
};
