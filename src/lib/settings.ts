import type { NodeDef } from "node-red";
import type { PayloadType } from "./payload";
import { ANY } from "./topics";

export interface DatacakeNodeDef extends NodeDef {
  datacakeConfiguration: string;
  productSlug?: string;
  deviceId?: string;
  fieldName?: string;
  /** Snapshots for the editor label; not used by the runtime. */
  deviceName?: string;
  fieldLabel?: string;
  productName?: string;
}

export interface DatacakeInDef extends DatacakeNodeDef {
  source?: string;
  payloadType?: string;
}

export interface DatacakeOutDef extends DatacakeNodeDef {
  target?: string;
  fieldMode?: string;
}

export type InSource = "device" | "product";
export type OutTarget = "configured" | "msg";
export type OutFieldMode = "fixed" | "msg" | "payload";

/**
 * Properties added in 1.0 are missing on nodes created with 0.x. Their defaults reproduce the old
 * behaviour, so existing flows keep working unchanged.
 */
export function inSettings(config: DatacakeInDef): { source: InSource; payloadType: PayloadType } {
  return {
    source: config.source === "product" ? "product" : "device",
    payloadType: config.payloadType === "auto" ? "auto" : "string",
  };
}

/**
 * 0.x out nodes could be set to "Pass deviceId in msg object" (empty device) or "All Measurements"
 * (`+`). Until 0.1.6 both meant "take it from msg"; 1.0 restores that meaning, now protected
 * against loops.
 */
export function outSettings(config: DatacakeOutDef): {
  target: OutTarget;
  fieldMode: OutFieldMode;
} {
  let target: OutTarget;
  if (config.target === "configured" || config.target === "msg") {
    target = config.target;
  } else {
    target = config.deviceId ? "configured" : "msg";
  }
  let fieldMode: OutFieldMode;
  if (
    config.fieldMode === "fixed" ||
    config.fieldMode === "msg" ||
    config.fieldMode === "payload"
  ) {
    fieldMode = config.fieldMode;
  } else {
    fieldMode = config.fieldName && config.fieldName !== ANY ? "fixed" : "msg";
  }
  return { target, fieldMode };
}

/** Metadata a datacake-in node attaches as `msg.datacake`. */
export interface DatacakeMessageInfo {
  topic: string;
  productSlug: string;
  productName?: string;
  deviceId: string;
  deviceName?: string;
  fieldName: string;
  fieldLabel?: string;
  unit?: string;
}

/**
 * A message coming straight from a datacake-in node must not be written back to the field it was
 * read from: Datacake would publish the value again and the flow would loop forever.
 */
export function isLoop(origin: unknown, deviceId: string, fieldName: string): boolean {
  if (!origin || typeof origin !== "object") {
    return false;
  }
  const info = origin as Partial<DatacakeMessageInfo>;
  return info.deviceId === deviceId && info.fieldName === fieldName;
}

/** Short value for the node status, e.g. "4.2 °C". */
export function formatStatusValue(value: unknown, unit?: string, maxLength = 24): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > maxLength) {
    text = text.slice(0, maxLength - 1) + "…";
  }
  return unit ? `${text} ${unit}` : text;
}

export function formatStatusTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
