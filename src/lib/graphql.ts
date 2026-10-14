export const DEFAULT_API_URL = "https://api.datacake.co/graphql/";
export const DEFAULT_MQTT_URL = "mqtts://mqtt.datacake.co:8883";

// Only meant for tests and local development; not exposed in the editor.
export function apiUrl(): string {
  return process.env.DATACAKE_API_URL || DEFAULT_API_URL;
}

export function mqttUrl(): string {
  return process.env.DATACAKE_MQTT_URL || DEFAULT_MQTT_URL;
}

export class DatacakeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DatacakeApiError";
  }
}

export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DatacakeApiError(`Datacake API not reachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new DatacakeApiError(`Datacake API responded with HTTP ${res.status}`, res.status);
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!body.data) {
    const message = body.errors?.map((e) => e.message).join("; ") || "empty response";
    throw new DatacakeApiError(`Datacake API error: ${message}`);
  }
  return body.data;
}

export interface FieldInfo {
  fieldName: string;
  label: string;
  fieldType?: string;
  unit?: string;
}

export interface ProductInfo {
  id: string;
  name: string;
  slug: string;
  deviceCount?: number;
  fields: FieldInfo[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  product: ProductInfo;
}

const FIELDS = "measurementFields(active: true) { fieldName verboseFieldName fieldType unit }";

interface RawField {
  fieldName: string;
  verboseFieldName: string;
  fieldType?: string;
  unit?: string | null;
}

interface RawProduct {
  id: string;
  name: string;
  slug: string;
  deviceCount?: number;
  measurementFields?: RawField[];
}

interface RawDevice {
  id: string;
  verboseName: string;
  product: RawProduct | null;
}

function toProduct(raw: RawProduct): ProductInfo {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    deviceCount: raw.deviceCount,
    fields: (raw.measurementFields ?? []).map((f) => ({
      fieldName: f.fieldName,
      label: f.verboseFieldName || f.fieldName,
      fieldType: f.fieldType,
      unit: f.unit || undefined,
    })),
  };
}

function toDevice(raw: RawDevice): DeviceInfo | undefined {
  if (!raw.product) {
    return undefined;
  }
  return { id: raw.id, name: raw.verboseName, product: toProduct(raw.product) };
}

export async function fetchWorkspaces(token: string): Promise<{ id: string; name: string }[]> {
  const data = await graphql<{ allWorkspaces: { id: string; name: string }[] | null }>(
    token,
    "query DatacakeWorkspaces { allWorkspaces { id name } }",
  );
  return data.allWorkspaces ?? [];
}

export async function searchDevices(
  token: string,
  workspaceId: string,
  search: string,
  page = 0,
  pageSize = 50,
): Promise<{
  total: number;
  devices: { id: string; name: string; product: Omit<ProductInfo, "fields"> }[];
}> {
  const data = await graphql<{
    workspace: {
      devicesFiltered: { total: number | null; devices: (RawDevice | null)[] | null } | null;
    } | null;
  }>(
    token,
    `
      query DatacakeSearchDevices(
        $workspaceId: String!
        $search: String
        $page: Int
        $pageSize: Int
      ) {
        workspace(id: $workspaceId) {
          devicesFiltered(
            search: $search
            page: $page
            pageSize: $pageSize
            orderBy: { verboseName: ASC }
          ) {
            total
            devices {
              id
              verboseName
              product {
                id
                name
                slug
              }
            }
          }
        }
      }
    `,
    { workspaceId, search: search || null, page, pageSize },
  );
  const list = data.workspace?.devicesFiltered;
  const devices = (list?.devices ?? [])
    .filter((d): d is RawDevice => !!d && !!d.product)
    .map((d) => ({
      id: d.id,
      name: d.verboseName,
      product: { id: d.product!.id, name: d.product!.name, slug: d.product!.slug },
    }));
  return { total: list?.total ?? devices.length, devices };
}

export async function fetchDevices(
  token: string,
  ids: string[],
  workspaceId?: string,
): Promise<DeviceInfo[]> {
  if (ids.length === 0) {
    return [];
  }
  const data = await graphql<{ allDevices: RawDevice[] | null }>(
    token,
    `query DatacakeDevices($ids: [UUID!], $workspaceId: String) {
      allDevices(idIn: $ids, inWorkspace: $workspaceId) {
        id verboseName product { id name slug ${FIELDS} }
      }
    }`,
    { ids, workspaceId: workspaceId || null },
  );
  return (data.allDevices ?? []).map(toDevice).filter((d): d is DeviceInfo => !!d);
}

export async function fetchProducts(token: string, workspaceId: string): Promise<ProductInfo[]> {
  const data = await graphql<{ workspace: { products: RawProduct[] | null } | null }>(
    token,
    `query DatacakeProducts($workspaceId: String!) {
      workspace(id: $workspaceId) { products { id name slug deviceCount ${FIELDS} } }
    }`,
    { workspaceId },
  );
  return (data.workspace?.products ?? []).map(toProduct);
}
