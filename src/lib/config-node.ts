import type { Node, NodeDef } from "node-red";
import type { DatacakeConnection } from "./connection";
import type { DeviceCache } from "./device-cache";

export const CONFIG_NODE_TYPE = "datacake-configuration";

export interface DatacakeConfigurationDef extends NodeDef {
  workspaceId?: string;
  workspaceName?: string;
  /** Plaintext token of 0.x versions; superseded by the `apiToken` credential. */
  apiKey?: string;
}

export interface DatacakeConfigurationCredentials {
  apiToken?: string;
}

export interface DatacakeConfigurationNode extends Node<DatacakeConfigurationCredentials> {
  workspaceId?: string;
  /** API token from the credentials, or the legacy plaintext `apiKey`. */
  token?: string;
  /** Undefined when no token is configured. */
  connection?: DatacakeConnection;
  cache?: DeviceCache;
}

export function resolveToken(
  credentials: DatacakeConfigurationCredentials | undefined,
  config: { apiKey?: string },
): string | undefined {
  return credentials?.apiToken || config.apiKey || undefined;
}
