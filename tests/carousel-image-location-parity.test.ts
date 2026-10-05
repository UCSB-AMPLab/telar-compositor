/**
 * The carousel preview loads an image from the first address that answers,
 * trying them in the order `carouselImageSources` gives. The framework
 * decides the same thing at build time by looking at files on disk
 * (`locate_image`, scripts/telar/images.py). This test lays out a site's
 * files in a temporary directory, asks the framework's own function where
 * each `image:` value lives, and checks that the first candidate present in
 * that directory is the address the framework publishes. When the framework
 * finds nothing, no candidate may be a file, and the fallback the preview
 * shows once every candidate fails must be exactly the address the site
 * publishes.
 *
 * The directory sits on the machine's own filesystem, so on macOS both sides
 * see it case-insensitively and the letter-case variants are not told apart
 * here; the unit cases in panel-preservation.test.tsx pin their order.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { carouselImageSources } from "../app/components/ui/markdown-editor/WidgetPreview";
import { FRAMEWORK_SCRIPTS_DIR, FRAMEWORK_TIMEOUT_MS, describeWithRequiredFramework } from "./helpers/framework-checkout";

const SITE = "https://owner.github.io/site";
const BASEURL = "/site";

/** Files the temporary site holds, from its root. */
const FILES = [
  "assets/images/only-in-assets.jpg",
  "telar-content/objects/only-in-objects.jpg",
  "assets/images/in-both.jpg",
  "telar-content/objects/in-both.jpg",
  "maps/at-root.png",
  "assets/images/historia/under-assets.jpg",
  "telar-content/objects/sub/under-objects.jpg",
  "assets/images/site/doubled.png",
  "assets/images/beside-base.png",
];

/** `image:` values, found and not found, with and without folders and slashes. */
const IMAGES = [
  "only-in-assets.jpg",
  "only-in-objects.jpg",
  "in-both.jpg",
  "missing.jpg",
  "maps/at-root.png",
  "/maps/at-root.png",
  "historia/under-assets.jpg",
  "sub/under-objects.jpg",
  "maps/missing.png",
  "/site/maps/at-root.png",
  "/site/assets/images/beside-base.png",
  "/assets/images/site/doubled.png",
  "/site/assets/images/site/doubled.png",
  "assets/images",
  "",
  "maps/at-root.png/",
  "maps//at-root.png",
  "./maps/at-root.png",
  "historia/./under-assets.jpg",
  "/site//maps/at-root.png",
  "maps//missing.png/",
  "./maps/missing.png",
];

const PYTHON = join(FRAMEWORK_SCRIPTS_DIR, "..", ".venv", "bin", "python3");

/** Each image's `locate_image` answer: its path from the site root, and whether a file is there. */
function frameworkLocations(root: string): Array<[string, boolean]> {
  const body = [
    "import json, os, sys",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.images import locate_image",
    `os.chdir(${JSON.stringify(root)})`,
    `print(json.dumps([list(locate_image(i, ${JSON.stringify(BASEURL)})) for i in json.loads(sys.argv[1])]))`,
  ].join("\n");
  const out = execFileSync(existsSync(PYTHON) ? PYTHON : "python3", ["-c", body, JSON.stringify(IMAGES)], {
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string);
}

describeWithRequiredFramework("carousel image candidates against the framework's locate_image", () => {
  let root = "";
  let located: Array<[string, boolean]> = [];
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "carousel-images-"));
    for (const file of FILES) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    located = frameworkLocations(root);
  }, FRAMEWORK_TIMEOUT_MS);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds some images and misses others", () => {
    expect(located.some(([, found]) => found)).toBe(true);
    expect(located.some(([, found]) => !found)).toBe(true);
  });

  it.each(IMAGES.map((image, i) => [JSON.stringify(image), image, i] as const))(
    "the preview's first loadable address is the one the site publishes: %s",
    (_name, image, i) => {
      const [sitePath, found] = located[i];
      const { candidates, fallback } = carouselImageSources(image, SITE)!;
      const isFile = (url: string) => {
        const path = join(root, url.slice(SITE.length + 1));
        return existsSync(path) && statSync(path).isFile();
      };
      if (found) {
        expect(candidates.find(isFile)).toBe(`${SITE}/${sitePath}`);
      } else {
        expect(candidates.some(isFile)).toBe(false);
        expect(fallback).toBe(`${SITE}/${sitePath}`);
      }
    },
  );
});
