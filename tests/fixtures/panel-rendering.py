"""
Writes panel-rendering.json: layer panel sources and the HTML the framework
publishes for each.

`cases` are widgets and notes through the panel pipeline alone
(`telar.markdown.process_inline_content`); the widget preview's rendered DOM
is compared with them in panel-rendering.test.tsx. `panels` are whole layer
panels through the build's own layer path (`_process_content_columns`,
scripts/telar/processors/stories.py): front matter, widgets, images,
Markdown, then the glossary, with the glossary written here and the baseurl
the checkout's `_config.yml` gives; `renderPanel` (app/lib/card-markdown.ts)
is compared with them in card-markdown-parity.test.tsx.

The glossary's entries carry kinds, and the site has one kind of its own,
`SITE_KIND`, put in place of the checkout's config, so that a glossary
callout shows a core kind and a site kind. The kinds are recorded with
their labels in the checkout's language and their icons.

Run from the root of a Telar checkout, with that checkout's Python
environment, and pass this file's path:

    cd "$TELAR_FRAMEWORK_DIR"
    .venv/bin/python3 <compositor>/tests/fixtures/panel-rendering.py [--out DIR]

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
import pandas as pd

sys.path.insert(0, "scripts")
import telar.glossary_kinds as glossary_kinds  # noqa: E402
from telar.glossary import GlossaryTerms  # noqa: E402
from telar.markdown import process_inline_content  # noqa: E402
from telar.processors.stories import _process_content_columns  # noqa: E402
from telar.widgets import site_base_url  # noqa: E402

MATHS = (
    "Equation \\(x^2\\) and $$a*b*c$$ here.\n\n\\[y_1\\]\n\n"
    "\\begin{aligned} a &= b \\end{aligned}\n\n"
    "Inline $x_1$, a price of $5, and \\ce{H2O}."
)

CASES = {
    "maths in accordion sections": f":::accordion\n## One\n{MATHS}\n\n## Two\nPlain $$x \\\\ y$$ text.\n:::",
    "maths in tabs": f":::tabs\n## One\n{MATHS}\n\n## Two\nMore $\\{{x\\}}$.\n:::",
    "maths in bibliography entries":
        ":::bibliography\nAuthor. On $\\alpha$ and \\(\\beta\\).\n\nSecond $$a*b$$ entry.\n:::",
    "maths in a caption and credit":
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\n"
        "caption: Area \\(r^2\\) and $$a <b$$\ncredit: After $x_1$ and *this*\n:::",
    "maths in a note":
        "Text[^n].\n\n[^n]: Note \\(x^2\\) and $$a*b*c$$ with $x_1$.",
    "entities and angle brackets in formulas":
        ":::accordion\n## One\nSum $$a &lt; b$$ and \\(c < d\\) and $x &amp; y_1$.\n\n## Two\nMore.\n:::",
    "entities in a caption formula":
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\n"
        "caption: Cap $$a &lt; b$$ and $$c < d$$\n:::",
    "footnotes in one accordion section":
        ":::accordion\n## One\nFirst[^b] then[^a] again[^b].\n\n[^a]: Note A with \\(x^2\\)\n[^b]: Note *B*\n"
        "[^u]: Unreferenced\n\n## Two\nA literal [^b] here.\n:::",
    "footnotes in two tabs sharing a label":
        ":::tabs\n## One\nX[^s].\n\n[^s]: S one\n\n## Two\nY[^s] and[^missing].\n\n[^s]: S two\n:::",
    "footnotes in bibliography entries":
        ":::bibliography\nFirst[^a] entry.\n[^a]: Note\n\nSecond[^a] entry.\n[^a]: Other\n:::",
    "a duplicated label in a section":
        ":::accordion\n## One\nA[^d].\n\n[^d]: First\n[^d]: Second\n\n## Two\nMore.\n:::",
    "a reference inside a note in a section":
        ":::accordion\n## One\nA[^a].\n\n[^a]: See[^b]\n[^b]: B\n\n## Two\nMore.\n:::",
    "references in a note's code and maths":
        ":::accordion\n## One\nA[^a] and $x^{[^b]}$.\n\n"
        "[^a]: Code `[^b]`, $$y[^b]$$ but[^b]\n[^b]: B\n\n## Two\nMore.\n:::",
    "a note referenced from a later note":
        ":::accordion\n## One\nA[^a].\n\n[^a]: A\n[^b]: See[^a]\n\n## Two\nMore.\n:::",
    "Unicode spaces in and around formulas":
        ":::accordion\n## One\nA $\u00a0a*b*c^2$ b $a*b*c^2\u00a0$ c $\u2009a*b*y_1$ "
        "d $\ufeffa*b*z_1\ufeff$ e $\x85a*b*w_1$ f $\x1fa*b*t_1$ g \u00a0$a*b*v_1$\u2009 "
        "h $\u1680a*b*u_1$.\n\n## Two\nMore.\n:::",
    "a formula inside another formula":
        ":::accordion\n## One\nPrice $x $$y$$ z$ end.\n\n## Two\nMore.\n:::",
    "a reference in a note's continuation paragraph":
        ":::accordion\n## One\nA[^a].\n\n[^a]: First paragraph.\n\n    See[^b] here.\n[^b]: B\n\n## Two\nMore.\n:::",
    "code in a note's continuation paragraph":
        ":::accordion\n## One\nA[^a].\n\n[^a]: Text.\n\n        code [^b]\n\n    After[^b].\n[^b]: B\n\n## Two\nMore.\n:::",
    "an astral character in a formula":
        ":::accordion\n## One\nA $\U0001F600$$x*y*z_1$ b.\n\n## Two\nMore.\n:::",
    # A `[^` inside an HTML tag stays literal and the tag intact. With
    # no other reference, the note is unreferenced and is still listed, its
    # back link pointing at an anchor that does not exist. A `>` inside a
    # quoted attribute still ends the tag early in Python Markdown; that case
    # is left out, as a known framework limitation rather than a contract.
    "a reference inside an HTML tag":
        ":::accordion\n## One\nA <span title=\"[^b]\">tag</span> here.\n\n[^b]: B\n\n## Two\nMore.\n:::",
    "a reference inside an HTML tag and in its text":
        ":::accordion\n## One\nA <span title=\"[^b]\">see[^b]</span> here.\n\n[^b]: B\n\n## Two\nMore.\n:::",
    "a reference inside a link's title":
        ":::accordion\n## One\nA <a href=\"https://example.org\" title=\"[^b]\">link</a> and[^b].\n\n[^b]: B\n\n## Two\nMore.\n:::",
    "a caption takes no footnotes":
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\ncaption: Caption[^a] text\n:::",
    "maths inside maths in sections":
        ":::accordion\n## One\nPrice $x $$y$$ z$ end, $\\ce{H2O}$, Sum $$a $b^2$ c$$ end, "
        "Then \\( a $$b^2$$ \\) end.\n\n## Two\nMore.\n:::",
    "maths inside maths in a caption and credit":
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\n"
        "caption: Cap $x $$a<b$$ z$ end\ncredit: By $\\ce{H2O}$\n:::",
}

GLOSSARY = GlossaryTerms({
    "IIIF": "International Image Interoperability Framework",
    "loom": "Loom",
    "demo-weft": "Weft",
    "jacquard": "Jacquard & <loom>",
})
GLOSSARY.kinds.update({"IIIF": "source", "loom": "term", "demo-weft": "place", "jacquard": "machine"})

SITE_KIND = {"id": "machine", "label": "Machine", "heading": "Machines", "values": []}
glossary_kinds.site_kinds = lambda: (SITE_KIND,)

PANELS = {
    "front matter with a title": "---\ntitle: \"A \\\"quoted\\\" title\"\n---\n\nBody text.",
    "front matter without a title is content": "---\nauthor: Someone\n---\n\nBody text.",
    "a rule at the top is not front matter": "---\n\nBody under a rule.\n\n---\n\nMore.",
    "soft breaks become line breaks": "First line\nsecond line\n\nNew paragraph.",
    "lists without a blank line": "Intro line\n- one\n- two\n\nAfter.\n\n1. first\n2. second",
    "emphasis, links, code and a table":
        "*a* **b** `c` [d](https://example.org/d)\n\n| x | y |\n|:--|--:|\n| 1 | 2 |",
    "glossary references in any case and with aliases":
        "The [[iiif]] standard, [[IIIF|the framework]], [[demo-weft]] and [[missing]].",
    "glossary aliases holding Markdown": "[[IIIF|*emphasised* alias]] and [[loom|a `code` alias]].",
    "a glossary reference inside code": "Write `[[iiif]]` to link, or\n\n    [[loom]] in a block",
    "glossary references in code elements and a fenced block":
        "Press <kbd>[[iiif]]</kbd> or <samp>[[loom]]</samp>.\n\n```\n[[iiif]]\n```\n\nBut [[loom]] links.",
    "a glossary reference in a widget section":
        ":::accordion\n## One\nSee [[iiif]] here.\n\n## Two\nAnd [[Loom|looms]].\n:::",
    "glossary references in a caption, a credit and a bibliography entry":
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\n"
        "caption: A [[iiif]] image\ncredit: By [[Loom|the loom]]\n:::\n\n"
        ":::bibliography\nAuthor. On [[IIIF]].\n\nOther. On [[nothing]].\n:::",
    "glossary references in section titles":
        ":::accordion\n## The [[iiif]] standard\nBody.\n\n##   [[Loom|looms]] & <b>kin</b> \nMore.\n:::\n\n"
        ":::tabs\n## [[missing]] \"tab\"\nOne.\n\n## [[DEMO-WEFT]]\nTwo.\n:::",
    "glossary references inside formulas":
        "Sum $$x + [[iiif]]$$ and \\([[Loom]]_1\\) and $[[missing]]^2$.\n\n"
        ":::accordion\n## One\nIn $$a [[IIIF|b]] c$$ here.\n\n## Two\nMore.\n:::\n\n"
        ":::carousel\nimage: https://example.org/a.jpg\nalt: A\nwidth: 1000\nheight: 500\n"
        "caption: Cap $$[[loom]] < 1$$ end\n:::",
    "relative and absolute images with captions":
        "![A map](maps/map.jpg){md}\nA *map* of $x_1$ places\n\n![B](https://example.org/b.png)\n"
        "caption: Credit [[iiif]]\n\n![C](c.jpg){full}\n\nAfter.",
    "an image after text on the next line": "Some text\n![D](d.jpg)\nIts caption",
    "root-relative and protocol-relative images": "![E](/assets/e.png)\n\n![F](//cdn.example.org/f.png){sm}",
    "maths in each delimiter":
        "Equation \\(x^2\\) and $$a*b*c$$ here.\n\n\\[y_1\\]\n\n"
        "\\begin{aligned} a &= b \\end{aligned}\n\nInline $x_1$, a price of $5, and \\ce{H2O}.",
    "footnotes at the top level and in widget sections":
        "Top[^a] text.\n\n:::tabs\n## One\nIn a tab[^a].\n\n[^a]: Tab note\n\n## Two\nPlain.\n:::\n\n"
        "After[^b].\n\n[^a]: Top note\n[^b]: Second top note",
    # The forms the Compositor writes for brackets in an author's
    # text. An entity in alt text is decoded before it is escaped.
    "an entity in alt text":
        "![Loom &#91;Telar&#93;](a.jpg)\n\n![Loom [Telar]](b.jpg)\n\n![x &amp; y & z < \" q](c.jpg)",
    "an entity in link text":
        "[Loom &#91;Telar&#93;](https://example.org/a) and [Loom [Telar]](https://example.org/b).",
    "a lone bracket":
        "![Loom &#91;Telar](a.jpg)\n\n[Loom &#93; x](https://example.org/a) and [&#91;](https://example.org/b).",
    "brackets two levels deep":
        "![A &#91;b &#91;c&#93;&#93; d](a.jpg)\n\n[A &#91;b &#91;c&#93;&#93; d](https://example.org/a)",
    "escaped glossary syntax":
        "Text &#91;&#91;loom&#93;&#93; and [&#91;&#91;loom&#93;&#93;](https://example.org/a) "
        "and [&#91;loom&#93;](https://example.org/b).",
    # The glossary pass runs over the figure's markup, and
    # leaves a reference inside the alt attribute as written.
    "escaped glossary syntax in alt text": "![&#91;&#91;loom&#93;&#93;](a.jpg)",
    # A reference that starts inside a tag is left as written; a
    # `<` in prose is not a tag.
    "a glossary reference inside a tag and after a prose angle bracket":
        '<span title="[[loom]]">t</span> and x < [[loom]] > y.',
    # Past process_images, Python Markdown makes the image and the glossary
    # pass leaves the reference in its alt attribute.
    "an image whose alt text nests brackets two deep": "![a [[IIIF]] b](b.jpg)",
    "escaped brackets in a caption":
        "![A](a.jpg)\nCap &#91;&#91;loom&#93;&#93; and `&#91;x&#93;` and [[loom|b &#93; c]]",
    "glossary display text holding a bracket or a pipe":
        "[[loom|a [b c]], [[loom|a &#93; b]], [[loom|a &#124; b]] and [[loom|x & y]].",
    # An entity held out of Markdown must not make markup of what follows
    # `<`, and equal entities must stay equal, so a reference label matches.
    "a bracket entity after an angle bracket": "Text <&#91;> and </&#93;> and a <&#124; end.",
    "a reference label holding a bracket entity":
        "[x][&#91;] and [y][&#X5B;]\n\n[&#91;]: https://example.org/a\n[&#x5b;]: https://example.org/b",
    # An image inside a line of text stays there, a relative path
    # resolved under the objects folder, and any other as written.
    "images inside a line of text":
        "Text ![Loom &#91;Telar&#93;](maps/a%20b.jpg) inline, ![B](/assets/b.png) and "
        "![C](https://example.org/c.jpg \"T\") end.",
    "addresses with parentheses and spaces":
        "[t](https://example.org/a_%28b%29%20c)\n\n![i](a%20b%29.jpg)\n\n![j](https://example.org/c%28d%29.jpg)",
    # Not from the framework's tests: a glossary reference inside
    # the text of a link and of a raw anchor, beside one outside it, a display
    # text holding Markdown characters, and references inside text-only
    # content.
    "a glossary reference in a link's text":
        "[see [[iiif]]](https://example.org/a), [[[loom]]](https://example.org/b) and [[IIIF|this]].",
    "a glossary reference in a raw anchor":
        '<a href="https://example.org/a">see [[Loom|*a* `b`]]</a> and [[loom]]',
    "a glossary reference in text-only content":
        '<textarea>[[iiif]]</textarea> and [[loom]]\n\n<div><textarea><a>[[iiif]]</textarea> [[loom]]</div>',
    "glossary callouts on the right and on the left":
        "Before.\n\n:::glossary\nentry: iiif\n:::\n\nBetween [[loom]].\n\n:::glossary\nentry: loom\nalign: left\n:::\n\nAfter.",
    "a glossary callout for a site kind and for a demo entry":
        ":::glossary\nentry: jacquard\n:::\n\n:::glossary\nentry: DEMO-WEFT\nalign: right\n:::",
    "a glossary callout for an unknown entry": "Text.\n\n:::glossary\nentry: missing\nalign: left\n:::",
    "a glossary callout with no entry": ":::glossary\nalign: left\n:::\n\nText.",
    "a glossary callout with a side that is neither": ":::glossary\nentry: loom\nalign: centre\n:::",
    "a glossary callout naming an entity":
        ":::glossary\nentry: a &amp;amp; b\n:::",
    "glossary callouts with Spanish sides":
        ":::glossary\nentry: IIIF\nalign: Derecha\n:::\n\n:::glossary\nentry: loom\nalign: IZQUIERDÁ\n:::",
}


def framework_panels():
    """Each panel through `_process_content_columns`: (title, HTML) in order."""
    names = list(PANELS)
    df = pd.DataFrame({"step": [str(i + 1) for i in range(len(names))],
                       "layer1_content": [PANELS[n] for n in names]})
    df = _process_content_columns(df, GLOSSARY, [], [])
    return list(zip(df["layer1_title"], df["layer1_text"]))


def main():
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(__file__).parent
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    cases = [{"name": name, "source": source, "html": process_inline_content(source)["content"]}
             for name, source in CASES.items()]
    panels = [{"name": name, "source": source, "title": title, "html": html}
              for (name, source), (title, html) in zip(PANELS.items(), framework_panels())]
    (out_dir / "panel-rendering.json").write_text(json.dumps({
        "framework_commit": commit,
        "markdown_version": markdown.__version__,
        "pandas_version": pd.__version__,
        "base_url": site_base_url(),
        "glossary": GLOSSARY,
        "glossary_kinds": GLOSSARY.kinds,
        "default_kind": glossary_kinds.default_kind(),
        "kinds": [{"id": kind["id"], "label": glossary_kinds.kind_text(kind["id"], "label"),
                   "icon": kind.get("icon")} for kind in glossary_kinds.all_kinds()],
        "cases": cases,
        "panels": panels,
    }, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
