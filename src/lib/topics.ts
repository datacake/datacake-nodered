// Datacake publishes every field write on `dtck/<productSlug>/<deviceId>/<FIELD>` and accepts
// values on `dtck-pub/<productSlug>/<deviceId>/<FIELD>`.
export const SUBSCRIBE_PREFIX = "dtck";
export const PUBLISH_PREFIX = "dtck-pub";
export const ANY = "+";

export interface TopicParts {
  productSlug: string;
  deviceId: string;
  fieldName: string;
}

/** A single topic level: non-empty and free of separators, wildcards and NUL. */
export function isValidSegment(segment: unknown): segment is string {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    !/[/+#]/.test(segment) &&
    !segment.includes("\0")
  );
}

function isValidFilterSegment(segment: unknown): segment is string {
  return segment === ANY || isValidSegment(segment);
}

/**
 * Topic filter for subscriptions. `deviceId` and `fieldName` may be `+` (all devices of a product,
 * all fields of a device); the product slug never is.
 */
export function subscribeTopic(productSlug: string, deviceId: string, fieldName: string): string {
  if (!isValidSegment(productSlug)) {
    throw new Error(`Invalid product slug "${productSlug ?? ""}"`);
  }
  if (!isValidFilterSegment(deviceId)) {
    throw new Error(`Invalid device id "${deviceId ?? ""}"`);
  }
  if (!isValidFilterSegment(fieldName)) {
    throw new Error(`Invalid field "${fieldName ?? ""}"`);
  }
  return `${SUBSCRIBE_PREFIX}/${productSlug}/${deviceId}/${fieldName}`;
}

/** Concrete topic for publishing; wildcards are a protocol violation and are rejected. */
export function publishTopic(productSlug: string, deviceId: string, fieldName: string): string {
  if (!isValidSegment(productSlug)) {
    throw new Error(`Invalid product slug "${productSlug ?? ""}"`);
  }
  if (!isValidSegment(deviceId)) {
    throw new Error(`Invalid device id "${deviceId ?? ""}"`);
  }
  if (!isValidSegment(fieldName)) {
    throw new Error(`Invalid field "${fieldName ?? ""}"`);
  }
  return `${PUBLISH_PREFIX}/${productSlug}/${deviceId}/${fieldName}`;
}

/** Splits an incoming `dtck/...` topic; returns undefined for anything else. */
export function parseTopic(topic: string): TopicParts | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== SUBSCRIBE_PREFIX) {
    return undefined;
  }
  return { productSlug: parts[1], deviceId: parts[2], fieldName: parts[3] };
}

/**
 * Every subscription filter that can match an incoming topic. Our filters only ever use `+` for
 * the device and/or field level, so four lookups replace generic wildcard matching.
 */
export function dispatchKeys(topic: string): string[] {
  const parts = parseTopic(topic);
  if (!parts) {
    return [topic];
  }
  const base = `${SUBSCRIBE_PREFIX}/${parts.productSlug}`;
  return [
    topic,
    `${base}/${parts.deviceId}/${ANY}`,
    `${base}/${ANY}/${parts.fieldName}`,
    `${base}/${ANY}/${ANY}`,
  ];
}
