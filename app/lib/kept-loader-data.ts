/**
 * The data a mounted page last showed, kept for its route's `clientLoader`.
 *
 * A read the router makes again (`revalidate()`) that fails in transit reaches
 * the route's error card. A `clientLoader` runs outside the component, so the
 * page hands it the data on screen through here, and it answers with that where
 * the server read did not come back. The page drops it on unmount: a later
 * visit that cannot read must not open on an earlier visit's data.
 *
 * `useReloadableLoaderData` reads the route's loader alone, through a fetcher:
 * `revalidate()` reads every loader on the page, and one parent's failure
 * (the app shell's) would replace the page whatever the route's own loader
 * answers.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { isUnreachable } from "~/lib/unreachable-write";

const kept = new Map<string, unknown>();

/** The data the mounted page under `key` last showed, or undefined. */
export function keptLoaderData<T>(key: string): T | undefined {
  return kept.get(key) as T | undefined;
}

/** Keeps `data` for `key` while the calling page is mounted. */
export function useKeepLoaderData(key: string, data: unknown): void {
  kept.set(key, data);
  useEffect(() => {
    kept.set(key, data);
    return () => {
      kept.delete(key);
    };
  }, [key, data]);
}

/**
 * `serverLoader()`, or the data the page last showed where the read failed in
 * transit. A redirect, a refusal and a read with nothing kept are thrown on.
 */
export async function readOrKept<T>(key: string, serverLoader: () => Promise<T>): Promise<T> {
  try {
    return await serverLoader();
  } catch (error) {
    const last = keptLoaderData<T>(key);
    if (last === undefined || !isUnreachable(error)) throw error;
    return last;
  }
}

/**
 * The page's loader data, with a `reload` that reads only this route's loader
 * (`href`) through a fetcher. A reload's answer replaces the data the router
 * gave until the router gives newer data. Kept for the route's `clientLoader`
 * under `key`, as `useKeepLoaderData` does.
 */
export function useReloadableLoaderData<T>(key: string, loaderData: T, href: string): { data: T; reload: () => void } {
  const fetcher = useFetcher<T>();
  const reloadedOver = useRef<T | null>(null);
  const data = fetcher.data !== undefined && reloadedOver.current === loaderData ? (fetcher.data as T) : loaderData;
  useKeepLoaderData(key, data);
  const load = fetcher.load;
  const reload = useCallback(() => {
    reloadedOver.current = loaderData;
    void load(href);
  }, [load, loaderData, href]);
  return { data, reload };
}
