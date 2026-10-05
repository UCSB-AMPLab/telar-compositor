/**
 * The actions' call to the Durable Object's lease route.
 *
 * The object verifies the request against the control text and user it reads
 * back from the query, so the request the helper builds has to verify with
 * exactly those — checked here with the object's own verifier. The helper
 * tells a refusal from no answer, because only a refusal stops the publish or
 * upgrade that asked, and nothing it meets may reach them as an exception.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { verifyInternalMarker } from "../workers/auth";

const SECRET = "lease-secret";

function envAnswering(answer: (request: Request) => Promise<Response>) {
  const seen: Request[] = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: vi.fn((name: string) => `id-${name}`),
      get: vi.fn(() => ({
        fetch: async (request: Request) => {
          // Cloned so the signature headers can be verified after the call.
          seen.push(request.clone() as unknown as Request);
          return answer(request);
        },
      })),
    },
  } as unknown as Parameters<typeof controlFreezeLease>[0];
  return { env, seen };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("controlFreezeLease", () => {
  it("sends a request the object's verifier accepts for the same control and user", async () => {
    const { env, seen } = envAnswering(async () => new Response("OK"));
    const applied = await controlFreezeLease(env, 12, 34, { op: "end", operationId: "op-1", outcome: "failed" });

    expect(applied).toBe("applied");
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe("/freeze");
    expect(url.searchParams.get("control")).toBe("end:op-1:failed");
    expect(url.searchParams.get("userId")).toBe("34");
    const sent = seen[0] as unknown as Parameters<typeof verifyInternalMarker>[0];
    expect(await verifyInternalMarker(sent, SECRET, "freeze", 34, 30, "end:op-1:failed")).toBeNull();
    // Bound to the control: the same signature does not verify for another.
    expect(await verifyInternalMarker(sent, SECRET, "freeze", 34, 30, "end:op-1:succeeded")).not.toBeNull();
  });

  it("reaches the object named for the project", async () => {
    const { env } = envAnswering(async () => new Response("OK"));
    await controlFreezeLease(env, 12, 34, { op: "renew", operationId: "op-1" });
    expect(env.COLLABORATION.idFromName).toHaveBeenCalledWith("12");
  });

  it("answers refused for the object's refusal, which for a begin means another operation is running", async () => {
    const { env } = envAnswering(async () => new Response("freeze_refused", { status: 409 }));
    expect(await controlFreezeLease(env, 1, 2, { op: "begin", kind: "publish", operationId: "op" })).toBe("refused");
  });

  it("answers unavailable, not refused, when storage could not answer", async () => {
    // A lock nobody could be asked about is not a reason to refuse the operation.
    const { env } = envAnswering(async () => new Response("freeze_unavailable", { status: 503 }));
    expect(await controlFreezeLease(env, 1, 2, { op: "begin", kind: "publish", operationId: "op" })).toBe("unavailable");
  });

  it("answers unavailable, and does not throw, when the object cannot be reached", async () => {
    const { env } = envAnswering(async () => {
      throw new Error("unreachable");
    });
    await expect(controlFreezeLease(env, 1, 2, { op: "begin", kind: "publish", operationId: "op" })).resolves.toBe("unavailable");
  });
});
