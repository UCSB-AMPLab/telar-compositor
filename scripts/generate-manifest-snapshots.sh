#!/usr/bin/env bash
# Regenerate snapshot fixtures for manifest runner tests.
#
# Copies _config.yml + project.csv from real user sites into the `before/`
# directories, then runs the Python user-content migration methods on a temp
# copy to produce the `expected/` goldens. Run this when:
#   - A bundled manifest changes (migrations/*.json)
#   - A Python migration script changes in telar/
#   - A new fixture is added
#
# Per D-18: snapshot tests run in CI only when manifest or runner code changes,
# so regeneration is rare.
#
# Why we do not invoke scripts/upgrade.py directly: upgrade.py runs the full
# migration chain (framework-file fetches from GitHub, data regeneration, IIIF
# tile generation, interactive confirmation). We only need the user-content
# transforms — the pieces that bundled manifests reimplement in JS. We call
# the three relevant Python methods directly via a small inline program:
#   - Migration094to100._update_configuration  (max_viewer_cards 10 -> 8)
#   - Migration100to110._update_configuration  (insert collection_mode)
#   - Migration110to120._update_project_csv    (add show_sections column)
#
# Framework-file-only migrations (v092->v093, v093->v094) have no user-content
# ops and contribute nothing to the expected/ goldens.

set -euo pipefail

FIXTURES_ROOT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/manifest-snapshots"
USER_SITES_ROOT="/Users/juancobo/Databases/storytelling/user-sites"
TELAR_ROOT="/Users/juancobo/Databases/storytelling/telar"

declare -a FIXTURES=(
  "mirl-story-v092-to-v120:mirl-story"
  "group_9_project-v092-to-v120:group_9_project"
)

run_python_user_content_migrations() {
  local workdir="$1"
  PYTHONPATH="$TELAR_ROOT/scripts" python3 - "$workdir" <<'PYEOF'
import sys
import os

# Silence the network-fetching framework-file phase of each migration by
# never calling _update_framework_files / _update_language_files.
from migrations.v094_to_v100 import Migration094to100
from migrations.v100_to_v110 import Migration100to110
from migrations.v110_to_v120 import Migration110to120

workdir = sys.argv[1]

# v0.9.4-beta -> v1.0.0-beta: max_viewer_cards 10 -> 8
m094 = Migration094to100(workdir)
m094._update_configuration()

# v1.0.0-beta -> v1.1.0: add collection_mode after telar_language
m100 = Migration100to110(workdir)
m100._update_configuration()

# v1.1.0 -> v1.2.0: add show_sections column to project.csv
m110 = Migration110to120(workdir)
m110._update_project_csv()
PYEOF
}

for pair in "${FIXTURES[@]}"; do
  fixture_dir="${pair%%:*}"
  source_site="${pair##*:}"
  src="$USER_SITES_ROOT/$source_site"
  if [[ ! -d "$src" ]]; then
    echo "SKIP: $src not found" >&2
    continue
  fi

  before_dir="$FIXTURES_ROOT/$fixture_dir/before"
  expected_dir="$FIXTURES_ROOT/$fixture_dir/expected"
  mkdir -p "$before_dir" "$expected_dir"

  # 1. Copy current state into before/
  cp "$src/_config.yml" "$before_dir/_config.yml"
  csv_basename=""
  if [[ -f "$src/telar-content/spreadsheets/project.csv" ]]; then
    cp "$src/telar-content/spreadsheets/project.csv" "$before_dir/project.csv"
    csv_basename="project.csv"
  elif [[ -f "$src/telar-content/spreadsheets/proyecto.csv" ]]; then
    cp "$src/telar-content/spreadsheets/proyecto.csv" "$before_dir/proyecto.csv"
    csv_basename="proyecto.csv"
  fi

  # 2. Make a temp working copy with the repo layout Python expects
  tmp=$(mktemp -d)
  mkdir -p "$tmp/telar-content/spreadsheets"
  cp "$before_dir/_config.yml" "$tmp/_config.yml"
  if [[ -n "$csv_basename" ]]; then
    cp "$before_dir/$csv_basename" "$tmp/telar-content/spreadsheets/$csv_basename"
  fi

  # 3. Run the user-content migrations in order
  run_python_user_content_migrations "$tmp" \
    || { echo "ERROR: Python migrations failed for $fixture_dir"; rm -rf "$tmp"; exit 1; }

  # 4. Capture expected outputs
  cp "$tmp/_config.yml" "$expected_dir/_config.yml"
  if [[ -n "$csv_basename" ]]; then
    cp "$tmp/telar-content/spreadsheets/$csv_basename" "$expected_dir/$csv_basename"
  fi

  rm -rf "$tmp"
  echo "Regenerated $fixture_dir"
done

echo "Done. Commit tests/fixtures/manifest-snapshots/ if outputs changed."
