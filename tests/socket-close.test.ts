/**
 * The code the Durable Object answers a peer's Close with. workerd refuses to
 * send a code the WebSocket protocol reserves for reporting, so answering with
 * the peer's own code throws for those, and the handshake is never completed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { replyCloseCode } from "../workers/socket-close";

describe("replyCloseCode", () => {
  it("answers a code that may not be sent with a normal closure", () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 5000, 65535]) {
      expect(replyCloseCode(code)).toBe(1000);
    }
  });

  it("answers any code that may be sent with the same code", () => {
    for (const code of [1000, 1001, 1003, 1007, 1009, 1011, 1012, 1013, 1014, 1016, 2999, 3000, 4000, 4999]) {
      expect(replyCloseCode(code)).toBe(code);
    }
  });
});
