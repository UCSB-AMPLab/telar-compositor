// @vitest-environment jsdom
/**
 * Choosing a step or opening a layer panel writes `?step` and `?layer`. No
 * loader on the story page reads either, so the write must not read the story
 * again (the loading overlay follows every read); `?lng` is read by the root
 * loader, a submission always reads, and another page is always read.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, useNavigate, useNavigation, useFetcher, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";
import { readAnotherPage } from "~/lib/unreachable-write";

afterEach(cleanup);

function setup() {
  const reads = { root: 0, shell: 0, story: 0 };
  const states: string[] = [];
  const guard = { shouldRevalidate: (args: ShouldRevalidateFunctionArgs) => readAnotherPage(args) };
  const Pass = () => <Outlet />;
  function Story() {
    const [, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const fetcher = useFetcher();
    const navigation = useNavigation();
    states.push(navigation.state);
    const put = (key: string, value: string) =>
      setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set(key, value); return next; }, { replace: true });
    return (
      <>
        <button type="button" onClick={() => put("layer", "1")}>open layer</button>
        <button type="button" onClick={() => put("step", "2")}>choose step</button>
        <button type="button" onClick={() => put("lng", "es")}>language</button>
        <button type="button" onClick={() => navigate("/other")}>other page</button>
        <button type="button" onClick={() => fetcher.submit({ intent: "save" }, { method: "post" })}>save</button>
      </>
    );
  }
  const Stub = createRoutesStub([
    {
      id: "root", path: "/", Component: Pass, loader: () => ({ n: ++reads.root }), ...guard,
      children: [
        { id: "shell", Component: Pass, loader: () => ({ n: ++reads.shell }), ...guard,
          children: [
            { path: "story", Component: Story, loader: () => ({ n: ++reads.story }), action: () => ({ ok: true }), ...guard },
            { path: "other", Component: () => <p>the other page</p>, loader: () => ({}) },
          ] },
      ],
    },
  ]);
  return { reads, states, Stub };
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function mounted() {
  const s = setup();
  render(<s.Stub initialEntries={["/story?step=1"]} />);
  await screen.findByRole("button", { name: "open layer" });
  return s;
}

describe("a change of ?step or ?layer", () => {
  it("opening a layer panel reads nothing and is never a navigation in flight", async () => {
    const { reads, states } = await mounted();
    const before = { ...reads };
    states.length = 0;
    await press("open layer");
    expect(reads).toEqual(before);
    expect(states.filter((s) => s !== "idle")).toEqual([]);
  });

  it("choosing a step reads nothing", async () => {
    const { reads } = await mounted();
    const before = { ...reads };
    await press("choose step");
    expect(reads).toEqual(before);
  });

  it("a language in the address is read by the root, which reads it", async () => {
    const { reads } = await mounted();
    const before = { ...reads };
    await press("language");
    expect(reads.root).toBe(before.root + 1);
  });

  it("a submission reads the story again", async () => {
    const { reads } = await mounted();
    const before = reads.story;
    await press("save");
    expect(reads.story).toBe(before + 1);
  });

  it("another page reads the shell again", async () => {
    const { reads } = await mounted();
    const before = reads.shell;
    await press("other page");
    expect(reads.shell).toBe(before + 1);
  });
});
