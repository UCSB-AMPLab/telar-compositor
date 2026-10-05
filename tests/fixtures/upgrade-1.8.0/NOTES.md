# upgrade to 1.8.0 fixtures

Made on 28 September 2026 from two repositories:

- the framework template, https://github.com/UCSB-AMPLab/telar.git, tag `v1.7.0` at commit `af6990f8ab607975f1f1ecd472874bdda277c260`;
- the framework's development instance, https://github.com/juancobo/telar.git, at commit `0dd90d52bc90e66a39091d8241aeab2ce0c23819`, the commit the 1.8.0 release is being cut from.

`migration.json` is the test manifest the framework's generator writes at that commit. It is not a release asset: its release date is supplied and its prose carries placeholders.

```
cd "$TELAR_FRAMEWORK_DIR"
.venv/bin/python3 audit/migration_manifest.py --ref 0dd90d52 --out <this directory>/migration.json --release-date 2026-09-29 --allow-placeholders
```

Byte for byte with `git show <ref>:<path>`:

| File | Ref | Path |
|---|---|---|
| `config-v1.7.0.yml` | `v1.7.0` | `_config.yml` |
| `index-v1.7.0.md` | `v1.7.0` | `index.md` |
| `glossary-v1.7.0.md` | `v1.7.0` | `pages/glossary.md` |
| `config-0dd90d52.yml` | `0dd90d52` | `_config.yml` |
| `index-0dd90d52.md` | `0dd90d52` | `index.md` |
| `glossary-0dd90d52.md` | `0dd90d52` | `pages/glossary.md` |
| `dev-only-files.txt` | `0dd90d52` | `scripts/dev-only-files.txt` |

`config-demo-content.yml` is `_config.yml` of https://github.com/UCSB-AMPLab/demo-content.git at commit `92c731cdf8bdb4e2b56df62f97524b26de48efaa`, copied byte for byte: a Jekyll configuration with its own `exclude:` list, not a Telar site's.

`config-v1.7.0-es.yml` is `config-v1.7.0.yml` with its `telar_language` line set to `"es"`, as a site made in Spanish from that template has it. No Telar configuration in Spanish is published in the template or the demo content.

`tree-v1.7.0.txt` is `git ls-tree -r v1.7.0` of the template. `tree-0dd90d52-framework.txt` is `git ls-tree -r 0dd90d52` of the development instance, filtered to the lines whose path is a framework path as the Compositor defines one (`FRAMEWORK_PREFIXES` and `FRAMEWORK_FILES`); the instance's own workflows (`centering-sweep.yml`, `debt-gate.yml`) are among them.

Each `*.cli.yml` is the file of the same name after the command-line route's `add_exclude_entries` (`scripts/migrations/v180_sources.py` at `0dd90d52`, run from a `git archive` of that commit with the development instance's `.venv/bin/python3`), with `en` as the language for every file but `config-v1.7.0-es.yml`. `config-0dd90d52.yml` already carries every entry, and the route leaves it unchanged.

All are UTF-8 with the line endings of their source.

`calib-square.png` is `assets/images/calib-square.png` of the development instance, https://github.com/juancobo/telar.git, at commit `833056504dc2374733d12f9d32684e3b0560b0d6` (`main`, 29 September 2026), copied byte for byte with `git show`. Its blob is `211d4337793aca24ba092c8424fc98af034e5f81`; it is the one fixture here that is not UTF-8 text.

`exclude-differential.json` holds the framework's own test configurations for `add_exclude_entries` and what that route writes for each, as `{"entries": [...], "cases": [{"name", "text", "written"}]}`: the 400 from `random_configs(400)` (seed 603) and the `READER_CASES` and `READER_FAILURES` inputs, all from `tests/unit/test_migration_v180_sources.py` at https://github.com/juancobo/telar.git commit `aa57aecda806ea6013bef5528249770394695bc5`. It was written by a script that imports that test module and `scripts/migrations/v180_sources.py` at that commit, runs with the development instance's `.venv/bin/python3`, and replaces each entry of `EXCLUDE_GROUPS` with the same entry with an empty `comment`, since the manifest's operation carries values without the comment blocks. `written` is the file after the route when its records are all applied (unchanged when every entry was already present), and null when it failed, in which case the route left the file unchanged. `entries` is the route's `EXCLUDE_ENTRIES`, in its order.
