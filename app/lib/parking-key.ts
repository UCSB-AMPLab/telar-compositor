/**
 * The keys the collaboration snapshot gives a row only while a batch is in
 * flight: a renamed row is parked at `~park-<random>`, and a new row whose key
 * another row still holds is inserted at `~new-<uuid>`, each given its own
 * key in the same batch. A batch that fails can leave a page at one, and a
 * page whose document slug is empty keeps the slug D1 holds, so publish
 * reads a page at a parking key as having no slug.
 *
 * @version v1.5.0-beta
 */

export const PARKED_KEY_PREFIX = "~park-";
export const PLACEHOLDER_KEY_PREFIX = "~new-";

const HEX = "[0-9a-f]";
/** SQLite GLOB patterns matching exactly what `isParkingKey` matches. */
export const PARKED_KEY_GLOB = `${PARKED_KEY_PREFIX}${HEX.repeat(16)}`;
export const PLACEHOLDER_KEY_GLOB =
  `${PLACEHOLDER_KEY_PREFIX}${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}`;

const PARKED_KEY = /^~park-[0-9a-f]{16}$/;
const PLACEHOLDER_KEY = /^~new-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `key` has the exact shape of a parking or placeholder key. A page
 * imported from a file whose name only begins like one is not one.
 */
export function isParkingKey(key: string): boolean {
  return PARKED_KEY.test(key) || PLACEHOLDER_KEY.test(key);
}
