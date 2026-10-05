// @vitest-environment jsdom
/**
 * useTextEnd: the end of a block's last line, from the last piece it draws,
 * in the unscaled pixels of the mark's offset parent.
 *
 * jsdom lays nothing out, so each piece's line boxes are given here: a text
 * node's through Range#getClientRects, an element's through its own.
 */

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { movers, useTextEnd } from "~/hooks/use-text-end";

const rect = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);
const lines = new WeakMap<Node, DOMRect[]>();
const originalRange = Range.prototype.getClientRects;

function withLines(node: Node, ...rects: DOMRect[]) {
  lines.set(node, rects);
  if (node instanceof Element) node.getClientRects = () => rects as unknown as DOMRectList;
}

function setup(html: string, scale = 1) {
  Range.prototype.getClientRects = function (this: Range) {
    return (lines.get(this.startContainer) ?? []) as unknown as DOMRectList;
  };
  const origin = document.createElement("div");
  const block = document.createElement("div");
  const box = document.createElement("span");
  block.innerHTML = html;
  origin.appendChild(block);
  origin.appendChild(box);
  document.body.appendChild(origin);
  // The origin is 400 unscaled pixels wide, drawn at 400 × scale from (100, 50).
  Object.defineProperty(origin, "offsetWidth", { value: 400 });
  origin.getBoundingClientRect = () => rect(100, 50, 400 * scale, 300 * scale);
  Object.defineProperty(box, "offsetParent", { value: origin });
  return { origin, block, box };
}

function endOf(block: HTMLElement, box: HTMLElement) {
  const { result } = renderHook(() => useTextEnd({ current: block }, { current: box }, []));
  return result.current.at;
}

afterEach(() => {
  Range.prototype.getClientRects = originalRange;
  document.body.innerHTML = "";
});

describe("useTextEnd", () => {
  it("stands at the right of the last text's last line, centred on it, in the parent's unscaled pixels", () => {
    const { block, box } = setup("<p>First paragraph</p><p>Second, on two lines</p>", 0.5);
    const [first, second] = [...block.querySelectorAll("p")].map((p) => p.firstChild!);
    withLines(first, rect(110, 60, 150, 10));
    withLines(second, rect(110, 80, 190, 10), rect(110, 90, 40, 10));
    // (150 - 100) / 0.5 and (95 - 50) / 0.5.
    expect(endOf(block, box)).toEqual({ left: 100, top: 90 });
  });

  it("counts the parent's scroll, so the point moves with the text in a card that scrolls", () => {
    const { origin, block, box } = setup("<p>Answer</p>");
    Object.defineProperty(origin, "scrollTop", { value: 40 });
    withLines(block.querySelector("p")!.firstChild!, rect(100, 30, 80, 20));
    // The line's centre is drawn 10 px above the parent's top; 40 px are scrolled away.
    expect(endOf(block, box)).toEqual({ left: 80, top: 30 });
  });

  it("passes over trailing white space and the waiting marker, and takes a formula whole", () => {
    const { block, box } = setup(
      '<p>Before <span class="katex"><span class="katex-html">x<sup>2</sup></span></span> </p>\n<span data-in-place-marker="">Draft waiting</span>',
    );
    const math = block.querySelector(".katex")!;
    withLines(block.querySelector("p")!.firstChild!, rect(100, 50, 60, 20));
    withLines(math, rect(160, 48, 30, 24));
    withLines(math.querySelector("sup")!.firstChild!, rect(185, 44, 5, 10));
    withLines(block.querySelector("[data-in-place-marker]")!.firstChild!, rect(100, 300, 200, 12));
    expect(endOf(block, box)).toEqual({ left: 90, top: 10 });
  });

  it("gives no point where the DOM draws no line boxes", () => {
    const { block, box } = setup("<p>Text</p>");
    expect(endOf(block, box)).toBeNull();
  });

  it("watches the block, the parent, and everything beside the block at each level between them", () => {
    document.body.innerHTML =
      '<div id="card"><div id="content"><h2 id="question"><div id="qblock">Q</div></h2><div id="answer"><p id="label">A</p><div id="ablock">A</div><span id="pencil"></span></div><div id="actions"></div></div></div>';
    const by = (id: string) => document.getElementById(id)!;
    expect(movers(by("ablock"), by("card")).map((el) => el.id).sort()).toEqual(
      ["ablock", "actions", "answer", "card", "content", "label", "pencil", "question"].sort(),
    );
  });

  it("ends a displayed formula where its last drawn part ends, not at its line's edge", () => {
    const { block, box } = setup(
      '<p>Then</p><span class="katex-display"><span class="katex"><span class="katex-html"><span class="base">a</span><span class="base">b</span></span></span></span>',
    );
    withLines(block.querySelector("p")!.firstChild!, rect(100, 50, 40, 20));
    withLines(block.querySelector(".katex")!, rect(100, 80, 400, 30));
    withLines(block.querySelectorAll(".base")[1], rect(290, 84, 30, 22));
    expect(endOf(block, box)).toEqual({ left: 220, top: 45 });
  });

  it("ends a numbered formula after its number", () => {
    const { block, box } = setup(
      '<span class="katex-display"><span class="katex"><span class="katex-html"><span class="base">a</span><span class="tag">(1)</span></span></span></span>',
    );
    withLines(block.querySelector(".base")!, rect(250, 84, 30, 22));
    withLines(block.querySelector(".tag")!, rect(460, 86, 20, 18));
    expect(endOf(block, box)).toEqual({ left: 380, top: 45 });
  });
});
