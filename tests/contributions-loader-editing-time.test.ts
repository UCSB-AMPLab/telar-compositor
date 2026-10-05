/**
 * The /contributions loader and the Durable Object's clock.
 *
 * The record's two time measures are read from the instance that is holding
 * them, not from the table they will land in, so the panel and the page show
 * the seconds a person has just worked rather than the seconds the last
 * snapshot happened to catch. The figure travels into the read model as its
 * third argument and stands in place of the D1 read.
 *
 * The claim these hold to is the degradation. A record is worth showing with a
 * clock that is a snapshot behind; it is not worth a 500, and nothing about an
 * unreachable Durable Object should stop a student seeing what they wrote. So
 * every failure — a refusal, a 503, a binding that is not there, a throw — ends
 * in the same place: the loader asks for the record without a figure, and the
 * read model reads D1.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must precede the loader import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getContributionRecordMock: vi.fn(),
  resolveActiveProjectMock: vi.fn(),
}));

vi.mock("~/lib/contributions.server", () => ({
  getContributionRecord: mocks.getContributionRecordMock,
}));

vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: mocks.resolveActiveProjectMock,
}));

vi.mock("~/lib/membership.server", () => ({
  requireProjectMember: vi.fn(),
}));

vi.mock("~/lib/db.server", () => ({
  // The loader's only direct query is the project title.
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ title: "Mujeres y trabajo" }]),
      })),
    })),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

import { loader } from "~/routes/_app.contributions";
import { userContext } from "~/middleware/auth.server";
import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import { verifyInternalMarker } from "../workers/auth";

const SESSION_SECRET = "test-session-secret";
const PROJECT_ID = 42;
const ANA = 7;

const RECORD = {
  members: [
    {
      userId: ANA,
      displayName: "Ana",
      color: "#E47A6F",
      role: "convenor",
      kinds: Object.fromEntries(
        CONTRIBUTION_KINDS.map((kind) => [kind, { added: 1, edited: 1, words: 40 }]),
      ),
      editingSeconds: 0,
      writingSeconds: 0,
    },
  ],
  hasWordsAndTime: true,
};

/** The DO stub, answering however the test says. */
function makeEnv(answer: (request: Request) => Promise<Response>) {
  const seen: Request[] = [];
  return {
    DB: {},
    SESSION_SECRET,
    COLLABORATION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (request: Request) => {
          seen.push(request);
          return answer(request);
        },
      }),
    },
    seen,
  };
}

function makeArgs(env: ReturnType<typeof makeEnv>) {
  return {
    request: new Request("https://compositor.telar.org/contributions"),
    context: {
      get: (key: unknown) => (key === userContext ? { id: ANA } : undefined),
      cloudflare: { env },
    },
  } as unknown as Parameters<typeof loader>[0];
}

/** What the read model was handed as its figure on the last call. */
function passedTimes(): unknown {
  return mocks.getContributionRecordMock.mock.calls.at(-1)?.[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContributionRecordMock.mockResolvedValue(RECORD);
  mocks.resolveActiveProjectMock.mockResolvedValue({
    project: { id: PROJECT_ID, github_repo_full_name: "neogranadina/mujeres-y-trabajo" },
  });
});

describe("/contributions loader — the clock's figure", () => {
  it("hands the Durable Object's figure to the read model", async () => {
    const times = [{ userId: ANA, editingSeconds: 12240, writingSeconds: 5820 }];
    const env = makeEnv(async () => Response.json({ times }));

    await loader(makeArgs(env));

    expect(passedTimes()).toEqual(times);
  });

  it("signs the call for this project and this operation", async () => {
    const env = makeEnv(async () => Response.json({ times: [] }));

    await loader(makeArgs(env));

    const [sent] = env.seen;
    expect(new URL(sent.url).pathname).toBe("/editing-time");
    expect(sent.headers.get("X-Internal-Project")).toBe(String(PROJECT_ID));
    // The op is bound into the signature, so a marker minted for anything else
    // would not verify here.
    expect(await verifyInternalMarker(sent, SESSION_SECRET, "editing-time")).toBeNull();
    expect(await verifyInternalMarker(sent, SESSION_SECRET, "active-ws-count")).not.toBeNull();
  });

  it("reads D1 instead when the instance refuses", async () => {
    const env = makeEnv(async () => new Response("editing_time_unavailable", { status: 503 }));

    const data = await loader(makeArgs(env));

    expect(passedTimes()).toBeUndefined();
    expect(data).toMatchObject({ hasWordsAndTime: true });
  });

  it("reads D1 instead when the instance cannot be reached", async () => {
    const env = makeEnv(async () => {
      throw new Error("no instance");
    });

    const data = await loader(makeArgs(env));

    expect(passedTimes()).toBeUndefined();
    expect(data).toMatchObject({ projectTitle: "Mujeres y trabajo" });
  });

  it("reads D1 instead when the answer is not the shape it claims", async () => {
    const env = makeEnv(async () => Response.json({ times: "soon" }));

    await loader(makeArgs(env));

    expect(passedTimes()).toBeUndefined();
  });

  it("still serves the CSV from the same figure", async () => {
    const times = [{ userId: ANA, editingSeconds: 12240, writingSeconds: 5820 }];
    const env = makeEnv(async () => Response.json({ times }));
    const args = makeArgs(env);
    (args as { request: Request }).request = new Request(
      "https://compositor.telar.org/contributions?format=csv",
    );

    const res = (await loader(args)) as Response;

    expect(passedTimes()).toEqual(times);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
  });
});
