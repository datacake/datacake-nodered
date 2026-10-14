import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { NodeAPI } from "node-red";
import {
  CONFIG_NODE_TYPE,
  type DatacakeConfigurationCredentials,
  type DatacakeConfigurationNode,
} from "./config-node";
import {
  DatacakeApiError,
  fetchDevices,
  fetchProducts,
  fetchWorkspaces,
  searchDevices,
  type DeviceInfo,
} from "./graphql";

/** Placeholder the editor sends for a stored password credential. */
const PASSWORD_PLACEHOLDER = "__PWRD__";
const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_NAME_IDS = 500;

interface RequestBody {
  configId?: unknown;
  token?: unknown;
  workspaceId?: unknown;
  search?: unknown;
  page?: unknown;
  deviceId?: unknown;
  deviceIds?: unknown;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Editor endpoints that proxy the few GraphQL queries the node dialogs need, so the API token
 * never has to reach the browser. A token typed into a not yet deployed configuration node is sent
 * along; otherwise the token of the deployed configuration node is used.
 */
export function registerAdminApi(RED: NodeAPI): void {
  const cache = new Map<string, { expires: number; value: unknown }>();

  function resolveToken(body: RequestBody): {
    token: string;
    configNode?: DatacakeConfigurationNode;
  } {
    const typed = str(body.token);
    if (typed && typed !== PASSWORD_PLACEHOLDER) {
      return { token: typed };
    }
    const configId = str(body.configId);
    if (configId) {
      const configNode = RED.nodes.getNode(configId) as DatacakeConfigurationNode | null;
      if (configNode?.type === CONFIG_NODE_TYPE && configNode.token) {
        return { token: configNode.token, configNode };
      }
      const credentials = RED.nodes.getCredentials(configId) as
        DatacakeConfigurationCredentials | undefined;
      if (credentials?.apiToken) {
        return { token: credentials.apiToken };
      }
    }
    throw new HttpError(400, "no_token");
  }

  async function cached<T>(key: string, token: string, load: () => Promise<T>): Promise<T> {
    const id = createHash("sha256").update(token).update("\0").update(key).digest("hex");
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) {
      return hit.value as T;
    }
    const value = await load();
    if (cache.size >= CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value!);
    }
    cache.set(id, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  function route(path: string, handler: (body: RequestBody) => Promise<unknown>): void {
    RED.httpAdmin.post(
      `/datacake/${path}`,
      RED.auth.needsPermission("datacake.read"),
      (req: Request, res: Response) => {
        handler((req.body ?? {}) as RequestBody).then(
          (result) => res.json(result),
          (err: Error) => {
            const status =
              err instanceof HttpError ? err.status : err instanceof DatacakeApiError ? 502 : 500;
            res.status(status).json({ error: err.message });
          },
        );
      },
    );
  }

  function requireWorkspace(body: RequestBody): string {
    const workspaceId = str(body.workspaceId);
    if (!workspaceId) {
      throw new HttpError(400, "workspaceId is required");
    }
    return workspaceId;
  }

  route("workspaces", async (body) => {
    const { token } = resolveToken(body);
    return cached("workspaces", token, () => fetchWorkspaces(token));
  });

  route("devices", async (body) => {
    const { token } = resolveToken(body);
    const workspaceId = requireWorkspace(body);
    const search = str(body.search) ?? "";
    const page = typeof body.page === "number" && body.page >= 0 ? Math.floor(body.page) : 0;
    return cached(`devices:${workspaceId}:${page}:${search}`, token, () =>
      searchDevices(token, workspaceId, search, page),
    );
  });

  route("products", async (body) => {
    const { token } = resolveToken(body);
    const workspaceId = requireWorkspace(body);
    return cached(`products:${workspaceId}`, token, () => fetchProducts(token, workspaceId));
  });

  route("device", async (body) => {
    const { token } = resolveToken(body);
    const deviceId = str(body.deviceId);
    if (!deviceId) {
      throw new HttpError(400, "deviceId is required");
    }
    const [device] = await fetchDevices(token, [deviceId], str(body.workspaceId));
    if (!device) {
      throw new HttpError(404, "device_not_found");
    }
    return device;
  });

  // Names for the node labels on the canvas, looked up in one batch per configuration node.
  route("names", async (body) => {
    const { token, configNode } = resolveToken(body);
    const ids = Array.isArray(body.deviceIds)
      ? [...new Set(body.deviceIds.filter((id): id is string => typeof id === "string"))]
      : [];
    if (ids.length > MAX_NAME_IDS) {
      throw new HttpError(400, `at most ${MAX_NAME_IDS} deviceIds per request`);
    }
    let devices: DeviceInfo[];
    if (configNode?.cache) {
      const found = await Promise.all(ids.map((id) => configNode.cache!.device(id)));
      devices = found.filter((d): d is DeviceInfo => !!d);
    } else {
      devices = await fetchDevices(token, ids, str(body.workspaceId));
    }
    const result: Record<
      string,
      { name: string; productName: string; productSlug: string; fields: Record<string, string> }
    > = {};
    for (const device of devices) {
      result[device.id] = {
        name: device.name,
        productName: device.product.name,
        productSlug: device.product.slug,
        fields: Object.fromEntries(device.product.fields.map((f) => [f.fieldName, f.label])),
      };
    }
    return { devices: result };
  });
}
