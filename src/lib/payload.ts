import { isValidSegment } from "./topics";

export type PayloadType = "auto" | "string";

const NUMERIC_FIELD_TYPES = new Set(["FLOAT", "INT", "NUMERIC", "COUNTER"]);
const NUMBER_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  return NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : undefined;
}

function parseBoolean(text: string): boolean | undefined {
  switch (text.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

/**
 * Converts a raw MQTT payload into the value a datacake-in node emits.
 *
 * `string` keeps the 0.x behaviour. `auto` uses the field type from the product definition when it
 * is known and otherwise guesses from the text. Values that do not parse stay strings, so no
 * information is lost.
 */
export function parseIncoming(
  raw: Buffer | string,
  payloadType: PayloadType,
  fieldType?: string,
): string | number | boolean {
  const text = raw.toString();
  if (payloadType === "string") {
    return text;
  }
  if (fieldType && NUMERIC_FIELD_TYPES.has(fieldType)) {
    return parseNumber(text) ?? text;
  }
  if (fieldType === "BOOL") {
    return parseBoolean(text) ?? text;
  }
  if (fieldType === "STRING" || fieldType === "GEO") {
    return text;
  }
  // Unknown field type: only convert unambiguous values.
  const lower = text.trim().toLowerCase();
  if (lower === "true" || lower === "false") {
    return lower === "true";
  }
  return parseNumber(text) ?? text;
}

/** Converts one value from msg.payload into the string Datacake expects on `dtck-pub/...`. */
export function serializeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot publish non-finite number ${value}`);
      }
      return String(value);
    case "boolean":
    case "bigint":
      return String(value);
    default:
      break;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  if (value === null || value === undefined) {
    throw new Error("msg.payload is empty");
  }
  throw new Error(
    "msg.payload must be a string, number or boolean. To write several fields at once, " +
      "choose 'Fields from msg.payload' and send an object such as {TEMPERATURE: 21}",
  );
}

export interface FieldValue {
  fieldName: string;
  value: string;
}

/**
 * Splits `{TEMPERATURE: 21, HUMIDITY: 50}` into one value per field. Each field becomes its own
 * MQTT message, because Datacake addresses every field with its own topic.
 */
export function splitFields(payload: unknown): { values: FieldValue[]; errors: string[] } {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Buffer.isBuffer(payload)
  ) {
    throw new Error("msg.payload must be an object such as {TEMPERATURE: 21, HUMIDITY: 50}");
  }
  const values: FieldValue[] = [];
  const errors: string[] = [];
  for (const [fieldName, raw] of Object.entries(payload)) {
    if (!isValidSegment(fieldName)) {
      errors.push(`Invalid field name "${fieldName}"`);
      continue;
    }
    try {
      values.push({ fieldName, value: serializeValue(raw) });
    } catch (err) {
      errors.push(`${fieldName}: ${(err as Error).message}`);
    }
  }
  return { values, errors };
}
