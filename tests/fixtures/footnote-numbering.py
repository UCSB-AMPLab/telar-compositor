"""
Writes footnote-numbering.json: layer panel sources and the HTML the
framework publishes for each, through its own panel pipeline
(`telar.markdown.process_inline_content`, which runs process_widgets and
then convert_markdown with `extra` and `nl2br`, renumbering footnotes by
reference).

Run from the root of a Telar checkout, with that checkout's Python
environment, and pass this file's path:

    cd "$TELAR_FRAMEWORK_DIR"
    .venv/bin/python3 <compositor>/tests/fixtures/footnote-numbering.py [--out DIR]

It must run from the checkout root: the widgets find their templates in
`_includes/widgets/` relative to the working directory, and run from
anywhere else every widget renders as `errors.widgets.rendering_error`.

The output records the framework commit and the Markdown version it ran
under. `npm run parity:regenerate` runs this with every other generator. The
sources are written for this fixture; none comes from a site.

Version: v1.5.0-beta
"""

import json
import subprocess
import sys
from pathlib import Path

import markdown

sys.path.insert(0, "scripts")
from telar.markdown import process_inline_content  # noqa: E402

CASES = {
    "definitions in another order than references":
        "Second[^z] then first[^old].\n\n[^old]: Earlier definition\n[^z]: Later",
    "a note referenced twice":
        "A[^a] b[^b] c[^a].\n\n[^b]: B\n[^a]: A",
    "an undefined reference":
        "A[^missing] b[^b].\n\n[^b]: B",
    "an unreferenced definition":
        "A[^b].\n\n[^u]: Unreferenced\n[^b]: B",
    "only unreferenced definitions":
        "Text.\n\n[^u]: U\n[^v]: V",
    "a duplicate definition":
        "A[^d] b[^e].\n\n[^e]: E\n[^d]: First\n[^d]: Second",
    "a reference inside a note":
        "A[^a].\n\n[^a]: See[^b]\n[^b]: B",
    "references in code":
        "Text `[^a]` and[^a].\n\n```\n[^a]: in code\n```\n\n[^a]: Real",
    "accordion sections and the top level":
        ":::accordion\n## One\nX[^s] y[^r].\n\n[^r]: R\n[^s]: S\n\n## Two\nZ[^s].\n\n[^s]: Other S\n:::\n\n"
        "Top[^t] and[^u].\n\n[^u]: U\n[^t]: T",
    "bibliography entries":
        ":::bibliography\nFirst[^b][^a] entry.\n[^a]: A\n[^b]: B\n\nSecond[^a].\n[^a]: Other A\n:::",
}


def main():
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(__file__).parent
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    cases = [{"name": name, "source": source, "html": process_inline_content(source)["content"]}
             for name, source in CASES.items()]
    (out_dir / "footnote-numbering.json").write_text(json.dumps({
        "framework_commit": commit,
        "markdown_version": markdown.__version__,
        "cases": cases,
    }, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
