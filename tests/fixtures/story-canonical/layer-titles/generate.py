"""The framework's layer titles for a list of front matter blocks.

Runs the framework's own `_split_frontmatter` (scripts/telar/markdown.py) on
each block wrapped as a layer file, and writes what it returns. The expected
values in titles.json are this script's output, never edited by hand.

Run from a framework checkout, with its own interpreter:

    cd "$TELAR_FRAMEWORK_DIR"
    PYTHONPATH=scripts .venv/bin/python3 \
        ../telar-compositor/tests/fixtures/story-canonical/layer-titles/generate.py \
        > ../telar-compositor/tests/fixtures/story-canonical/layer-titles/titles.json
"""

import contextlib
import io
import json
import sys

import yaml

from telar.markdown import _split_frontmatter

BLOCKS = [
    # Four cases
    "title: yes # note",
    "title: &label yes",
    "title: on # one",
    "title: 1:20 # time",
    "title: yes # one",
    "title: yes # two",
    # bool, every spelling class
    "title: yes", "title: No", "title: TRUE", "title: false", "title: On", "title: OFF",
    "title: y", "title: Yes!", "title: yess",
    # int
    "title: 42", "title: -7", "title: 0b101", "title: 0o17", "title: 017", "title: 0x1F",
    "title: 1_000", "title: 190:20:30",
    # float
    "title: 3.14", "title: 1.5e+3", "title: 1e3", "title: .5", "title: 190:20:30.15",
    "title: .inf", "title: -.Inf", "title: .NaN",
    # null
    "title: ~", "title: null", "title: NULL", "title: nul",
    # timestamp
    "title: 2024-05-01", "title: 2024-5-1 10:20:30", "title: 2024-05-01T10:20:30.5Z",
    # merge and value
    "title: <<", "title: =", "title: ==",
    # quoted and tagged
    "title: \"yes\"", "title: 'on'", "title: !!str yes", "title: ! yes", "title: ! \"yes\"",
    "title: !!int 12", "title: !custom text", "title: ! \"1\\n\"", "title: ! \"yes\\n\"",
    # ordinary strings
    "title: A panel", "title: Chapter 1: Opening", "title: \"a \\\"q\\\" b\"",
    "title: |\n  Alpha\n  Beta", "title: >-\n  Alpha\n  Beta", "title: plain\n  continued",
    # collections
    "title: [one]", "title: {a: 1}", "title:\n  - a\n  - b", "title:\nsummary: next", "title:",
    # anchors, aliases and merges
    "base: &b yes\ntitle: *b", "base: &b Hello\ntitle: *b",
    "defaults: &d {title: yes}\n<<: *d", "defaults: &d {title: Hello}\n<<: *d",
    "defaults: &d {title: Hello}\n<<: *d\ntitle: on",
    # another key the constructor cannot build
    "title: \"a \\\"q\\\" b\"\nother: =",
    "title: Plain\nother: <<",
    "title: \"a \\\"q\\\" b\"\nother: <<",
    "title: \"a \\\"q\\\" b\"\n<<: 5",
    "title: \"a \\\"q\\\" b\"\nlist: [x, =]",
    "title: \"a \\\"q\\\" b\"\n=: x",
    "title: 2024-13-45",
    "title: \"a \\\"q\\\" b\"\nwhen: 2024-13-45",
    # no title key
    "summary: yes",
]


def main():
    out = []
    for block in BLOCKS:
        text = f"---\n{block}\n---\n\nBody.\n"
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                title, body = _split_frontmatter(text, source="fixture")
                result = {"title": title, "body": body}
            except Exception as e:  # the framework lets some errors escape
                result = {"error": type(e).__name__}
        out.append({"block": block, **result})
    json.dump({"pyyaml": yaml.__version__, "python": sys.version.split()[0], "cases": out},
              sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


main()
