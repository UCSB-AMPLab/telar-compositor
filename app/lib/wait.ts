/**
 * A pause of `ms` milliseconds, for retries that wait between tries.
 *
 * @version v1.5.0-beta
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
