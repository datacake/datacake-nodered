import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "test-token-0123456789";
export const WORKSPACE_ID = "ws-1";

const product = {
  id: "p-1",
  name: "Cold Room Sensor",
  slug: "cold-room",
  deviceCount: 2,
  measurementFields: [
    { fieldName: "TEMPERATURE", verboseFieldName: "Temperature", fieldType: "FLOAT", unit: "°C" },
    { fieldName: "DOOR_OPEN", verboseFieldName: "Door open", fieldType: "BOOL", unit: null },
    { fieldName: "NOTE", verboseFieldName: "Note", fieldType: "STRING", unit: null },
  ],
};

export const DEVICES = [
  { id: "11111111-1111-1111-1111-111111111111", verboseName: "Cold Room 1", product },
  { id: "22222222-2222-2222-2222-222222222222", verboseName: "Cold Room 2", product },
];

export interface FakeApi {
  url: string;
  /** Operation names of all requests, in order. */
  operations: string[];
  /** Device ids requested per DatacakeDevices query. */
  deviceBatches: string[][];
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

/** A tiny stand-in for api.datacake.co that answers the operations the nodes use. */
export async function startFakeApi(): Promise<FakeApi> {
  const operations: string[] = [];
  const deviceBatches: string[][] = [];
  let available = true;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (!available) {
        send(503, { errors: [{ message: "unavailable" }] });
        return;
      }
      if (req.headers.authorization !== `Token ${TOKEN}`) {
        send(200, { data: null, errors: [{ message: "Not authenticated" }] });
        return;
      }
      const { query, variables } = JSON.parse(body) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = /query (\w+)/.exec(query)?.[1] ?? "unknown";
      operations.push(operation);
      switch (operation) {
        case "DatacakeWorkspaces":
          send(200, { data: { allWorkspaces: [{ id: WORKSPACE_ID, name: "Test Workspace" }] } });
          return;
        case "DatacakeDevices": {
          const ids = variables.ids as string[];
          deviceBatches.push(ids);
          send(200, { data: { allDevices: DEVICES.filter((d) => ids.includes(d.id)) } });
          return;
        }
        case "DatacakeProducts":
          send(200, { data: { workspace: { products: [product] } } });
          return;
        case "DatacakeSearchDevices": {
          const search = ((variables.search as string) || "").toLowerCase();
          const devices = DEVICES.filter((d) => d.verboseName.toLowerCase().includes(search));
          send(200, {
            data: { workspace: { devicesFiltered: { total: devices.length, devices } } },
          });
          return;
        }
        default:
          send(200, { data: null, errors: [{ message: `unknown operation ${operation}` }] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/graphql/`,
    operations,
    deviceBatches,
    setAvailable(value) {
      available = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
