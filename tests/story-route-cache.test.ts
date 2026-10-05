/**
 * The story editor's responses carry the active project's layer text and its
 * site's preview settings, so none is kept by the browser: a switch of
 * project can never be answered from another project's response.
 *
 * @version v1.5.0-beta
 */
import { it, expect } from "vitest";
import { headers } from "../app/routes/_app.stories.$storyId";

it("marks every story editor response private and not to be stored", () => {
  expect(new Headers(headers()).get("Cache-Control")).toBe("private, no-store");
});
