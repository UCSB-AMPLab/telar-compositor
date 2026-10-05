/**
 * An index.md holding the stock welcome block followed by the author's own
 * text: import stores the text as the welcome body, the homepage
 * editor shows it, and a publish keeps the block above it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { isV130WelcomeLiquidBlock } from "~/lib/v130-ingest.server";
import { parseIndexMd } from "~/lib/import.server";
import { indexMdForPublish } from "~/lib/publish.server";

const BLOCK =
  "{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}\n\n" +
  "{{ lang.index_page.welcome | default: site.data.languages.en.index_page.welcome | markdownify }}";
const FRONT = "---\nlayout: index\ntitle: Home\n---\n\n";
const TEXT = "Our museum welcomes you.";

describe("the stock welcome block with the author's text after it", () => {
  it("is not the stock block", () => {
    expect(isV130WelcomeLiquidBlock(`${BLOCK}\n\n${TEXT}`)).toBe(false);
    expect(isV130WelcomeLiquidBlock(BLOCK)).toBe(true);
  });

  it("is read as the author's text, without the block", () => {
    expect(parseIndexMd(`${FRONT}${BLOCK}\n\n${TEXT}\n`).welcome_body).toBe(TEXT);
  });

  const landing = (welcome_body: string | null) => ({
    stories_heading: null,
    stories_intro: null,
    objects_heading: null,
    objects_intro: null,
    welcome_body,
  });

  it("publishes the edited text under the block", () => {
    const out = indexMdForPublish(`${FRONT}${BLOCK}\n\n${TEXT}\n`, landing("Changed words."));
    expect(out.endsWith(`${BLOCK}\n\nChanged words.`)).toBe(true);
  });

  it("publishes the block alone when the author clears the text", () => {
    const out = indexMdForPublish(`${FRONT}${BLOCK}\n\n${TEXT}\n`, landing(""));
    expect(out.endsWith(BLOCK)).toBe(true);
  });

  it("keeps the file's text when no welcome body is stored", () => {
    const out = indexMdForPublish(`${FRONT}${BLOCK}\n\n${TEXT}\n`, landing(null));
    expect(out.endsWith(`${BLOCK}\n\n${TEXT}`)).toBe(true);
  });
});
