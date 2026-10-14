import type { DeviceInfo, FieldInfo, ProductInfo } from "./graphql";

export interface CacheSource {
  devices(ids: string[]): Promise<DeviceInfo[]>;
  products(): Promise<ProductInfo[]>;
}

interface Entry<T> {
  value: T | undefined;
  expires: number;
}

interface PendingDevice {
  promise: Promise<DeviceInfo | undefined>;
  resolve: (value: DeviceInfo | undefined) => void;
}

export interface CacheOptions {
  ttlMs?: number;
  /** How long a failed or empty lookup is remembered, so a broken token does not hammer the API. */
  negativeTtlMs?: number;
  /** Lookups requested within this window are sent as one GraphQL query. */
  batchDelayMs?: number;
  maxBatchSize?: number;
  now?: () => number;
}

/**
 * Names, product slugs and field definitions of devices, looked up lazily and in batches. Only
 * used to enrich messages and to type payloads, so every lookup may fail and resolve to undefined.
 */
export class DeviceCache {
  private readonly devices = new Map<string, Entry<DeviceInfo>>();
  private readonly products = new Map<string, Entry<ProductInfo>>();
  private readonly pendingDevices = new Map<string, PendingDevice>();
  private batchTimer: NodeJS.Timeout | undefined;
  private productsInFlight: Promise<void> | undefined;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly batchDelayMs: number;
  private readonly maxBatchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly source: CacheSource,
    options: CacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.negativeTtlMs = options.negativeTtlMs ?? 60 * 1000;
    this.batchDelayMs = options.batchDelayMs ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.now = options.now ?? Date.now;
  }

  peekDevice(id: string): DeviceInfo | undefined {
    return this.devices.get(id)?.value;
  }

  peekProduct(slug: string): ProductInfo | undefined {
    return this.products.get(slug)?.value;
  }

  peekField(productSlug: string, fieldName: string): FieldInfo | undefined {
    return this.peekProduct(productSlug)?.fields.find((f) => f.fieldName === fieldName);
  }

  /**
   * Resolves a device. Only the very first lookup waits (at most `waitMs`); known entries, even
   * expired ones, are returned immediately and refreshed in the background.
   */
  device(id: string, waitMs?: number): Promise<DeviceInfo | undefined> {
    const entry = this.devices.get(id);
    if (entry && entry.expires > this.now()) {
      return Promise.resolve(entry.value);
    }
    const pending = this.requestDevice(id);
    if (entry) {
      // Stale (or remembered as unknown): answer right away, the refresh runs in the background.
      return Promise.resolve(entry.value);
    }
    return withTimeout(pending, waitMs);
  }

  /** Resolves a product by slug through the product list of the workspace. */
  product(slug: string, waitMs?: number): Promise<ProductInfo | undefined> {
    const entry = this.products.get(slug);
    if (entry && entry.expires > this.now()) {
      return Promise.resolve(entry.value);
    }
    const loading = this.loadProducts().then(() => {
      const current = this.products.get(slug);
      if (!current || current.expires <= this.now()) {
        // Unknown slug or failed request: keep a stale value, but stop asking for a while.
        this.products.set(slug, {
          value: current?.value,
          expires: this.now() + this.negativeTtlMs,
        });
      }
      return this.products.get(slug)?.value;
    });
    if (entry) {
      return Promise.resolve(entry.value);
    }
    return withTimeout(loading, waitMs);
  }

  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    for (const pending of this.pendingDevices.values()) {
      pending.resolve(undefined);
    }
    this.pendingDevices.clear();
    this.devices.clear();
    this.products.clear();
  }

  private requestDevice(id: string): Promise<DeviceInfo | undefined> {
    const existing = this.pendingDevices.get(id);
    if (existing) {
      return existing.promise;
    }
    let resolve!: (value: DeviceInfo | undefined) => void;
    const promise = new Promise<DeviceInfo | undefined>((r) => (resolve = r));
    this.pendingDevices.set(id, { promise, resolve });
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.batchDelayMs);
    }
    return promise;
  }

  private flush(): void {
    this.batchTimer = undefined;
    const batch = new Map(this.pendingDevices);
    this.pendingDevices.clear();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += this.maxBatchSize) {
      const chunk = ids.slice(i, i + this.maxBatchSize);
      this.source.devices(chunk).then(
        (found) => {
          const byId = new Map(found.map((d) => [d.id, d]));
          for (const id of chunk) {
            const device = byId.get(id);
            this.storeDevice(id, device);
            batch.get(id)!.resolve(device);
          }
        },
        () => {
          for (const id of chunk) {
            this.storeDevice(id, this.devices.get(id)?.value, true);
            batch.get(id)!.resolve(this.devices.get(id)?.value);
          }
        },
      );
    }
  }

  private storeDevice(id: string, device: DeviceInfo | undefined, failed = false): void {
    const ttl = device && !failed ? this.ttlMs : this.negativeTtlMs;
    this.devices.set(id, { value: device, expires: this.now() + ttl });
    if (device && !failed) {
      this.products.set(device.product.slug, {
        value: device.product,
        expires: this.now() + this.ttlMs,
      });
    }
  }

  private loadProducts(): Promise<void> {
    if (!this.productsInFlight) {
      this.productsInFlight = this.source
        .products()
        .then(
          (products) => {
            for (const product of products) {
              this.products.set(product.slug, {
                value: product,
                expires: this.now() + this.ttlMs,
              });
            }
          },
          () => undefined,
        )
        .finally(() => {
          this.productsInFlight = undefined;
        });
    }
    return this.productsInFlight;
  }
}

function withTimeout<T>(promise: Promise<T | undefined>, ms?: number): Promise<T | undefined> {
  if (ms === undefined) {
    return promise;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
