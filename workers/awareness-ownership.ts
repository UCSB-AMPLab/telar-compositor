/**
 * Which entries of an awareness update a socket may set.
 *
 * An awareness update is a list of `(clientID, clock, state)` entries, and
 * y-protocols applies each one to whichever client it names: a sender that
 * writes another client's id with a higher clock replaces that client's name,
 * presence and every other field it broadcasts, or removes it. So the Durable
 * Object keeps only the entry that names the sending socket's own client id,
 * and relays what it kept rather than the bytes it was sent.
 *
 * Foreign entries are dropped, never treated as an attack. y-websocket sends
 * them in the ordinary course: it answers an awareness query with every state
 * it holds, and re-broadcasts each change it observes, a peer it timed out
 * included.
 *
 * @version v1.5.0-beta
 */

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: string;
}

/**
 * The awareness client id a connection declares, or null for none or for
 * anything that is not a canonical unsigned 32-bit integer — the range Yjs
 * draws client ids from.
 */
export function parseAwarenessClientId(raw: string | null): number | null {
  if (raw === null || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 0xffffffff ? id : null;
}

/** The entries of an encoded awareness update, or null when it will not decode. */
function readEntries(update: Uint8Array): AwarenessEntry[] | null {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const state = decoding.readVarString(decoder);
      entries.push({ clientId, clock, state });
    }
    return entries;
  } catch {
    return null;
  }
}

/** The client id an update's first entry names, or null for none. */
export function firstAwarenessClientId(update: Uint8Array): number | null {
  const entries = readEntries(update);
  return entries && entries.length > 0 ? entries[0].clientId : null;
}

/**
 * `update` re-encoded with only the entries that name `clientId`, or null
 * when none do or the update will not decode — in which case nothing is to be
 * applied or relayed.
 */
export function ownAwarenessEntries(update: Uint8Array, clientId: number): Uint8Array | null {
  const own = readEntries(update)?.filter((entry) => entry.clientId === clientId) ?? [];
  if (own.length === 0) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, own.length);
  for (const entry of own) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.state);
  }
  return encoding.toUint8Array(encoder);
}
