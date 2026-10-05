"""
Writes answer-preview.json: step answers and what the framework's own
`render_answer` (scripts/telar/processors/stories.py) makes of each: the
HTML the story publishes, the kinds that came out of it, its words,
paragraphs and lines before any cut, whether it was cut, and whether the
published answer is set in the smaller type. The step card's
preview (`renderAnswer`, app/lib/answer-preview.ts) is compared with it in
answer-preview-parity.test.ts.

The glossary is written here, and the baseurl is the checkout's own
`_config.yml`, as the build reads it.

Run from the root of a Telar checkout, with that checkout's Python
environment:

    cd "$TELAR_FRAMEWORK_DIR"
    .venv/bin/python3 <compositor>/tests/fixtures/answer-preview.py [--out DIR]

`npm run parity:regenerate` does this for every fixture. The sources are
written for this fixture; none comes from a site.

Version: v1.5.0-beta
"""

import json
import subprocess
import sys
from pathlib import Path

import markdown

sys.path.insert(0, "scripts")
from telar.answer_budget import (ANSWER_BUDGET, BREAK_LINES, LINE_CHARS,  # noqa: E402
                                 MAX_PARAGRAPHS, SMALL_TYPE_LINES)
from telar.processors.stories import render_answer  # noqa: E402
from telar.widgets import site_base_url  # noqa: E402

GLOSSARY = {
    "IIIF": "International Image Interoperability Framework",
    "loom": "Loom",
    "demo-weft": "Weft",
}

# Four-letter words, five characters to a word with its space: BUDGET_WORDS
# of them fill ANSWER_BUDGET lines exactly, and after WORDS a further word of
# three letters fits with the ellipsis and one of five more does not.
BUDGET_WORDS = (ANSWER_BUDGET * LINE_CHARS + 1) // 5
assert 5 * BUDGET_WORDS - 1 == ANSWER_BUDGET * LINE_CHARS
WORDS = " ".join(["word"] * (BUDGET_WORDS - 2))
SMALL_WORDS = (SMALL_TYPE_LINES * LINE_CHARS + 1) // 5 + 1

CASES = {
    "paragraphs and a soft break": "First line\nsecond line.\n\nSecond paragraph.",
    "a hard break": "One  \ntwo",
    "emphasis, code and links": '*a* and _b_, **c**, `d` and [e](https://example.org/e "Title").',
    "smart quotes, dashes and an ellipsis": "\"Quoted\" and 'single' -- en --- em ... it's",
    "inline HTML and entities": "x < y & z, <em>raw</em> &copy; &#169; &amp;",
    "a bare address stays text": "See https://example.org/page and <https://example.org/auto>.",
    "currency is not maths": "It cost $5 and $10.",
    "maths in each delimiter": "Inline $x_1$, display $$a+b$$, paren \\(x^2\\), bracket \\[y_1\\], chem \\ce{H2O}.",
    "maths holding Markdown characters": "$a*b*c^2$ and $$x_{1}*y_{2}$$",
    "maths holding HTML characters": "$$a<b$$ and $$c & d$$ and $$e &lt; f$$",
    "maths in a link's title": '[a](https://example.org/a "\\(x\\)") and \\(y\\)',
    "glossary references in any case": "The [[iiif]] standard and [[IIIF|the framework]].",
    "an unknown glossary term": "A [[Missing Term]] and [[missing|shown]] here.",
    "a demo glossary term": "The [[demo-weft]].",
    "glossary references inside formulas": "Sum $$x + [[iiif]]$$ and \\([[loom]]\\).",
    "a glossary reference inside code": "Write `[[iiif]]` to link.",
    "a glossary reference in a link's text": "[see [[iiif]]](https://example.org/a) and [[IIIF|this]].",
    "headings become paragraphs": "# Heading\n\nText\n\n## Second",
    "lists become paragraphs": "- one\n- two\n\n1. first\n2. second",
    "a nested list": "- one\n    - inner\n- two",
    "a quote becomes paragraphs": "> quoted\n>\n> again",
    "a rule is removed": "Above\n\n---\n\nBelow",
    "an image is removed": "Text ![img](a.png) after.",
    "an answer that is only an image": "![img](a.png)",
    "an embed is removed": 'Watch <iframe src="https://example.org/v"></iframe> this.',
    "a table is removed": "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter",
    "a fenced code block is removed": "Before\n\n```\ncode\n```\n\nAfter",
    "an indented code block is removed": "Text\n\n    code line\n\nAfter",
    "a footnote is removed": "A note[^1] here.\n\n[^1]: The note",
    "two footnotes and a reference without a definition": "A[^a] and b[^b] and c[^c].\n\n[^a]: One\n[^b]: Two",
    "a footnote reference inside code": "Write `[^1]` here[^1].\n\n[^1]: Note",
    "a glossary callout": "Before.\n\n:::glossary\nentry: carta\n:::\n\nAfter.",
    "a widget line with no closing line": "Before.\n\n:::glossary\nentry: carta\n\nAfter.",
    "an indented widget": "Before.\n  :::accordion\n  ## One\n  words\n  :::\nAfter.",
    "Unicode spaces": "a b c\u0085d",
    "the budget exactly": " ".join(["word"] * BUDGET_WORDS),
    "cut at a plain word": " ".join(["word"] * (BUDGET_WORDS + 5)),
    "past the normal type": " ".join(["word"] * SMALL_WORDS),
    "within the normal type": " ".join(["word"] * (SMALL_WORDS - 1)),
    "paragraph breaks count lines": "\n\n".join(" ".join(["word"] * 20) for _ in range(5)),
    "hard breaks start segments": "\n".join(" ".join(["word"] * 20) for _ in range(9)),
    "more paragraphs than the card holds": "\n\n".join(f"w{i}" for i in range(MAX_PARAGRAPHS + 2)),
    "cut back from a link": WORDS + " [two words](https://example.org/x) tail tail",
    "cut back from a glossary link": WORDS + " [[IIIF|two words]] tail tail",
    "a cut inside emphasis": WORDS + " *a b cccccc* tail",
    "maths is one word in the cut": WORDS + " $a + b_1$ tail tail",
    "a formula counts its placeholder's characters": "abcdefghij abcdefghij abcdefghi $$x$$",
    "a long list is cut": "\n".join(f"- w{i}" for i in range(10)),
}


def main():
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(__file__).parent
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    cases = []
    for name, source in CASES.items():
        rendered = render_answer(source, GLOSSARY, [])
        cases.append({"name": name, "source": source, "html": rendered.html, "kinds": rendered.kinds,
                      "measure": rendered.measure._asdict(), "cut": rendered.cut,
                      "long": rendered.long})
    (out_dir / "answer-preview.json").write_text(json.dumps({
        "framework_commit": commit,
        "markdown_version": markdown.__version__,
        "budget": ANSWER_BUDGET,
        "line_chars": LINE_CHARS,
        "break_lines": BREAK_LINES,
        "max_paragraphs": MAX_PARAGRAPHS,
        "small_type_lines": SMALL_TYPE_LINES,
        "base_url": site_base_url(),
        "glossary": GLOSSARY,
        "cases": cases,
    }, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
