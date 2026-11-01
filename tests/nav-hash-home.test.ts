/**
 * The menu hash and the Home item.
 *
 * The menu writer once left a visible Home out of `_data/navigation.yml`. A
 * menu published then hashes as its saved entries did, so with nothing else
 * changed the Publish page would call the site up to date and the Home item
 * would never be published. A visible Home marks the hash, so such a menu
 * lists as changed once; a hidden Home does not, since the file written for
 * it is the same as before.
 *
 * @version v1.5.6-beta
 */

import { describe, it, expect } from "vitest";
import { navigationHashInput } from "~/lib/publish.server";

const home = (visible: boolean) => ({ type: "builtin", key: "home", label: "Home", visible });
const glossary = { type: "builtin", key: "glossary", label: "Glossary", visible: true };

describe("navigationHashInput and the Home item", () => {
  it("marks a menu with a visible Home, so a menu published before it lists as changed", () => {
    const nav = JSON.stringify([home(true), glossary]);
    expect(navigationHashInput(nav)).not.toBe(JSON.stringify(JSON.parse(nav)));
    expect(navigationHashInput(nav)).toBe(navigationHashInput(nav));
  });

  it("leaves a menu with Home hidden as its saved entries", () => {
    const nav = JSON.stringify([home(false), glossary]);
    expect(navigationHashInput(nav)).toBe(JSON.stringify(JSON.parse(nav)));
  });

  it("leaves a menu with no Home as its saved entries", () => {
    const nav = JSON.stringify([glossary]);
    expect(navigationHashInput(nav)).toBe(JSON.stringify(JSON.parse(nav)));
  });

  it("keeps a page's served address in the hash alongside the mark", () => {
    const nav = JSON.stringify([home(true), { type: "page", slug: "Credits", label: "Credits", visible: true }]);
    expect(JSON.parse(navigationHashInput(nav))).toEqual({ menu: JSON.stringify(JSON.parse(nav)), addresses: ["credits"], home: true });
  });
});
