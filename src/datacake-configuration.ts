import type { NodeAPI } from "node-red";
import { registerAdminApi } from "./lib/admin-api";
import {
  CONFIG_NODE_TYPE,
  resolveToken,
  type DatacakeConfigurationCredentials,
  type DatacakeConfigurationDef,
  type DatacakeConfigurationNode,
} from "./lib/config-node";
import { DatacakeConnection } from "./lib/connection";
import { DeviceCache } from "./lib/device-cache";
import { fetchDevices, fetchProducts, mqttUrl } from "./lib/graphql";

export = function (RED: NodeAPI) {
  function DatacakeConfiguration(
    this: DatacakeConfigurationNode,
    config: DatacakeConfigurationDef,
  ) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workspaceId = config.workspaceId || undefined;
    node.token = resolveToken(node.credentials, config);

    if (node.token) {
      const token = node.token;
      node.connection = new DatacakeConnection({
        url: mqttUrl(),
        token,
        log: { debug: (m) => node.debug(m), warn: (m) => node.warn(m) },
      });
      node.cache = new DeviceCache({
        devices: (ids) => fetchDevices(token, ids, node.workspaceId),
        products: () =>
          node.workspaceId ? fetchProducts(token, node.workspaceId) : Promise.resolve([]),
      });
    }

    node.on("close", (_removed: boolean, done: () => void) => {
      node.cache?.clear();
      const closing = node.connection?.close() ?? Promise.resolve();
      closing.then(done, done);
    });
  }

  RED.nodes.registerType<
    DatacakeConfigurationNode,
    DatacakeConfigurationDef,
    unknown,
    DatacakeConfigurationCredentials
  >(CONFIG_NODE_TYPE, DatacakeConfiguration, {
    credentials: { apiToken: { type: "password" } },
  });

  registerAdminApi(RED);
};
