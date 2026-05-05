# Manifest Runner Snapshot Fixtures

Real-world fixtures used by `tests/manifest-snapshot.test.ts` to verify that
`applyManifestChain` produces output equivalent to the canonical Python
migration scripts on real user sites.

## Regenerate

When a bundled manifest or Python migration changes:

```bash
./scripts/generate-manifest-snapshots.sh
```

Requires: `python3`, `PyYAML`, local clones of `telar/` and `user-sites/` at
`/Users/juancobo/Databases/storytelling/`.

## Structure

```
mirl-story-v092-to-v120/
  before/
    _config.yml
    project.csv
  expected/
    _config.yml
    project.csv
```

- `before/` is the input state (user site at v0.9.2-beta).
- `expected/` is the Python migration output after running every user-content
  transform in the v0.9.2-beta → v1.2.0 chain.

The test reads `before/`, runs `applyManifestChain` with the bundled chain,
and asserts the result equals `expected/` (modulo the documented
normalisations — see below).

## Canonical source

`generate-manifest-snapshots.sh` does not invoke `scripts/upgrade.py` — that
orchestrator also fetches framework files from GitHub, regenerates data files,
and regenerates IIIF tiles. Instead the script calls the three user-content
methods directly:

- `Migration094to100._update_configuration` (max_viewer_cards 10 → 8)
- `Migration100to110._update_configuration` (insert collection_mode)
- `Migration110to120._update_project_csv` (add show_sections column)

Framework-file-only releases (v0.9.2 → v0.9.3, v0.9.3 → v0.9.4) have no
user-content ops and contribute nothing to the goldens.

## Source sites

- `mirl-story` — English-language story, v0.9.2-beta. Exercises
  max_viewer_cards update, collection_mode add, show_sections add.
- `group_9_project` — Same version, alternate site. Covers variability in
  project.csv row counts and config comment styles.

## Known normalisations in the test

Python's `csv.writer` writes CRLF line endings by default; Papa.unparse with
`newline: "\n"` writes LF. Python's `config_update_value` on
`max_viewer_cards` also rewrites the trailing comment, whereas the manifest
DSL drops it. The test documents these expected differences and compares on a
normalised form (line endings unified to LF, trailing-whitespace trimmed,
`max_viewer_cards` comment stripped on both sides) so that byte-level
regressions in the runner still fail, while known structural divergences do
not cause false positives.

These tests run in CI only when manifest files or the runner code change.
