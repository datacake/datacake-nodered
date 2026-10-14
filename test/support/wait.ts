export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true; fails with `message` after `timeoutMs`. */
export async function waitFor(
  check: () => boolean,
  message: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out: ${message}`);
    }
    await delay(10);
  }
}
