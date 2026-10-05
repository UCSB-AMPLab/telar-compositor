/**
 * The code the collaboration Durable Object answers a peer's Close with.
 *
 * On the compatibility date this worker runs (before 2026-04-07) the runtime
 * does not answer a Close frame itself: `webSocketClose` must call `close()`,
 * or the handshake is never completed. The code the handler is given is a
 * reported status, not always one the peer sent: 1005 means the Close frame
 * carried no code, 1006 that the connection dropped without one, 1015 a TLS
 * failure. Those three are never sent on the wire, 1004 is unassigned, and
 * workerd refuses to send any of them or anything outside 1000–4999.
 * y-websocket closes with no code, which is reported as 1005, so answering with
 * the reported status throws on the commonest close there is.
 *
 * @version v1.5.0-beta
 */

const NORMAL_CLOSURE = 1000;

/** Codes in 1000–4999 that workerd will not send. */
const NOT_SENDABLE = new Set([1004, 1005, 1006, 1015]);

/** `code` if it may be sent back to the peer, otherwise a normal closure. */
export function replyCloseCode(code: number): number {
  if (!Number.isInteger(code) || code < 1000 || code > 4999 || NOT_SENDABLE.has(code)) {
    return NORMAL_CLOSURE;
  }
  return code;
}
