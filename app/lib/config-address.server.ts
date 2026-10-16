/**
 * The save's check of the Site URL and Base URL, applied to the fields a
 * member may write. Each address present is settled (`settleSiteAddress`) and
 * checked against the rules in `site-address.ts`: a valid one is written back
 * in its settled form, and the keys that fail are returned for the save to
 * refuse. A value equal to the one stored is left as it is, so a stored
 * address that does not meet the rules does not stop the rest of the settings
 * from saving.
 *
 * @version v1.5.5-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { isBaseUrl, isSiteUrl, settleSiteAddress } from "~/lib/site-address";

type AddressKey = "url" | "baseurl";

/**
 * Settle the addresses present in `writable`, in place, and return the keys
 * that fail the rules, or an empty list when every one holds.
 */
export async function settleConfigAddresses(
  db: ReturnType<typeof getDb>,
  projectId: number,
  writable: Partial<Record<AddressKey, string | null>>,
): Promise<string[]> {
  const addressFields = (["url", "baseurl"] as const).filter((key) => key in writable);
  if (addressFields.length === 0) return [];
  const [stored] = await db
    .select({ url: project_config.url, baseurl: project_config.baseurl })
    .from(project_config)
    .where(eq(project_config.project_id, projectId))
    .limit(1);
  const invalidAddresses: string[] = [];
  for (const key of addressFields) {
    const raw = writable[key] ?? "";
    if (stored && raw === (stored[key] ?? "")) continue;
    const settled = settleSiteAddress(raw);
    const valid = key === "url" ? isSiteUrl(settled) : isBaseUrl(settled);
    if (valid) {
      writable[key] = settled;
    } else {
      invalidAddresses.push(key === "url" && settled === "" ? "url_empty" : key);
    }
  }
  return invalidAddresses;
}
