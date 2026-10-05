/**
 * Ties PROJECT_CSV_COLUMNS to the project.csv columns upgrade manifests
 * produce.
 *
 * serializeProjectCsv writes project.csv from the fixed column list, so a
 * column that a manifest's csv_add_column or csv_rename_column leaves in
 * project.csv and the list lacks is dropped by the next publish. Every
 * bundled manifest, every recorded release manifest and the recorded 1.8.0
 * manifest are read here.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { BUNDLED_MANIFESTS } from "~/../migrations";
import { PROJECT_CSV_COLUMNS } from "~/lib/publish.server";
import { resolveBilingual, type Manifest } from "~/lib/manifest-schema.server";
import { matchGlob } from "~/lib/manifest-runner.server";
import { PROJECT_SHEETS } from "~/lib/framework-sheet.server";

// Columns an upgrade produces in project.csv that publish drops on purpose.
// Each entry carries its reason.
const DROPPED_ON_PURPOSE: Record<string, string> = {};

function readManifests(): { source: string; manifest: Manifest }[] {
  const out = BUNDLED_MANIFESTS.map((manifest) => ({
    source: `migrations ${manifest.from_version} -> ${manifest.to_version}`,
    manifest,
  }));
  const releaseDir = join(__dirname, "fixtures", "release-manifests");
  for (const name of readdirSync(releaseDir).filter((n) => n.endsWith(".json"))) {
    out.push({
      source: `release-manifests/${name}`,
      manifest: JSON.parse(readFileSync(join(releaseDir, name), "utf8")),
    });
  }
  out.push({
    source: "upgrade-1.8.0/migration.json",
    manifest: JSON.parse(
      readFileSync(join(__dirname, "fixtures", "upgrade-1.8.0", "migration.json"), "utf8"),
    ),
  });
  return out;
}

// A glob targets project.csv when the runner's own matcher would apply it to
// the sheet under either language's file name.
const PROJECT_CSV_PATHS = PROJECT_SHEETS.map((name) => `telar-content/spreadsheets/${name}`);

function targetsProjectCsv(fileGlob: string): boolean {
  return PROJECT_CSV_PATHS.some((path) => matchGlob(fileGlob, path));
}

function producedColumns(manifest: Manifest): string[] {
  const cols: string[] = [];
  for (const op of manifest.operations) {
    if (op.type === "csv_add_column" && targetsProjectCsv(op.file_glob)) {
      cols.push(resolveBilingual(op.column, "en"));
    } else if (op.type === "csv_rename_column" && targetsProjectCsv(op.file_glob)) {
      cols.push(resolveBilingual(op.new_name, "en"));
    }
  }
  return cols;
}

describe("PROJECT_CSV_COLUMNS against upgrade manifests", () => {
  const manifests = readManifests();

  it("reads the bundled, release and 1.8.0 manifests", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(5 + 12 + 1);
    const produced = manifests.flatMap(({ manifest }) => producedColumns(manifest));
    expect(produced).toContain("show_sections");
  });

  it("lists every project.csv column a manifest adds or renames to", () => {
    const missing: string[] = [];
    for (const { source, manifest } of manifests) {
      for (const col of producedColumns(manifest)) {
        if (
          !(PROJECT_CSV_COLUMNS as readonly string[]).includes(col) &&
          !(col in DROPPED_ON_PURPOSE)
        ) {
          missing.push(`${source}: ${col}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
