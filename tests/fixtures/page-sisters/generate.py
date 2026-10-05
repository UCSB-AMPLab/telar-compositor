"""The framework's page output for sets of page files.

Runs the framework's own `generate_pages` (scripts/telar/pages.py) in a
scratch directory, once per case, and writes which file each generated page
came from, or the exception the build stopped on. The expected values in
cases.json are this script's output, never edited by hand.

Every case is the template's `about.md` and `acerca.md`, read verbatim from
a framework checkout, or built from them by replacing one front matter
line of `acerca.md`.

Run from a framework checkout, with its own interpreter:

    cd "$TELAR_FRAMEWORK_DIR"
    PYTHONPATH=scripts .venv/bin/python3 \
        ../telar-compositor/tests/fixtures/page-sisters/generate.py \
        > ../telar-compositor/tests/fixtures/page-sisters/cases.json

@version v1.5.0-beta
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

from telar.frontmatter import FRONTMATTER_PATTERN
from telar.pages import generate_pages

PAGES = Path("telar-content/texts/pages")
ABOUT = (PAGES / "about.md").read_text(encoding="utf-8")
ACERCA = (PAGES / "acerca.md").read_text(encoding="utf-8")


def acerca_with(old, new):
    """acerca.md with one front matter line replaced (or removed, for new=None)."""
    assert old in ACERCA.split("---")[1], old
    replacement = "" if new is None else new + "\n"
    return ACERCA.replace(old + "\n", replacement, 1)


def acerca_titled(title):
    return ACERCA.replace("title: Acerca de Telar\n", f"title: {title}\n", 1)


ACERCA_BLOCK = "title: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n"


def acerca_block(block):
    """acerca.md with its whole front matter block replaced."""
    assert ACERCA.split("---")[1] == "\n" + ACERCA_BLOCK
    return ACERCA.replace(ACERCA_BLOCK, block + "\n", 1)


CASES = [
    ("template, English site", "en", {"about.md": ABOUT, "acerca.md": ACERCA}),
    ("template, Spanish site", "es", {"about.md": ABOUT, "acerca.md": ACERCA}),
    ("template, empty site language", "", {"about.md": ABOUT, "acerca.md": ACERCA}),
    ("language: yes", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: yes")}),
    ("language: yes, English site", "en", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: yes")}),
    ("localized_for: false", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: false")}),
    ("localized_for: 0", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: 0")}),
    ("localized_for: []", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: []")}),
    ("localized_for: ABOUT.md", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: ABOUT.md")}),
    ("localized_for with a trailing space", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", 'localized_for: "about.md "')}),
    ("localized_for: about", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: about")}),
    ("localized_for: 1", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: 1")}),
    ("orphan", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: missing.md")}),
    ("no language", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", None)}),
    ("language: 0", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: 0")}),
    ('language: ""', "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", 'language: ""')}),
    ("language: [es]", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: [es]")}),
    ("language: {es: 1}", "en", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: {es: 1}")}),
    ("language: []", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: []")}),
    ("localized_for: [about.md]", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: [about.md]")}),
    ("localized_for: [about.md], no language", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", None).replace("localized_for: about.md", "localized_for: [about.md]")}),
    ("a sister in another language", "en", {"about.md": ABOUT, "acerca.md": ACERCA}),
    ("unparseable block", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: [es")}),
    ("unknown tag", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for: !custom about.md")}),
    ("block that is a list", "es", {"about.md": ABOUT, "acerca.md": ACERCA.replace("title: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n", "- title\n- es\n", 1)}),
    ("duplicates in the site language", "es", {"about.md": ABOUT, "acerca.md": ACERCA, "acerca-2.md": acerca_titled("Acerca de Telar 2")}),
    ("duplicates in another language", "en", {"about.md": ABOUT, "acerca.md": ACERCA, "acerca-2.md": acerca_titled("Acerca de Telar 2")}),
    ("block tagged !!set", "es", {"about.md": ABOUT, "acerca.md": ACERCA.replace("---\ntitle:", "---\n!!set\ntitle:", 1)}),
    ("a sister of a sister", "es", {"about.md": ABOUT, "acerca.md": ACERCA, "acerca-2.md": acerca_titled("Acerca 2").replace("localized_for: about.md", "localized_for: acerca.md")}),
    ("flow sister", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{title: Acerca, localized_for: about.md, language: es}")}),
    ("flow canonical", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{title: Acerca}")}),
    ("block that is []", "es", {"about.md": ABOUT, "acerca.md": acerca_block("[]")}),
    ("block that is [a]", "es", {"about.md": ABOUT, "acerca.md": acerca_block("[a]")}),
    ("block that is {}", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{}")}),
    ("flow sister with a list language", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{title: Acerca, localized_for: about.md, language: [es]}")}),
    ("block that is a literal scalar", "es", {"about.md": ABOUT, "acerca.md": acerca_block("|\n  Acerca de Telar")}),
    ("localized_for: false on the next line", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for:\n  false")}),
    ("language: [] on the next line", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language:\n  []")}),
    ("flow key with no value before language", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{title: Acerca, localized_for, language: es}")}),
    ("flow key with no value before localized_for", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{title: Acerca, draft, localized_for: about.md, language: es}")}),
    ("flow language with no value", "es", {"about.md": ABOUT, "acerca.md": acerca_block("{language, localized_for: about.md}")}),
    ("explicit key with no value", "es", {"about.md": ABOUT, "acerca.md": acerca_block("title: Acerca\n? draft\nlocalized_for: about.md\nlanguage: es")}),
    ("block that is [a: 1]", "es", {"about.md": ABOUT, "acerca.md": acerca_block("[a: 1]")}),
    ("language with an empty entry", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language:\n  -")}),
    ("localized_for with an empty entry", "es", {"about.md": ABOUT, "acerca.md": acerca_with("localized_for: about.md", "localized_for:\n  -")}),
    ("block that is an empty entry", "es", {"about.md": ABOUT, "acerca.md": acerca_block("-")}),
    ("language: !!str", "es", {"about.md": ABOUT, "acerca.md": acerca_with("language: es", "language: !!str")}),
    ("title: !!str", "es", {"about.md": ABOUT, "acerca.md": acerca_with("title: Acerca de Telar", "title: !!str")}),
    ("anchor named twice", "es", {"about.md": ABOUT, "acerca.md": acerca_block("title: Acerca de Telar\nlocalized_for: &a about.md\nlanguage: &a es")}),
    ("anchor before an alias on the next line", "es", {"about.md": ABOUT, "acerca.md": acerca_block("title: &t Acerca de Telar\nlocalized_for: about.md\nlanguage: es\nsubtitle: &s\n  *t")}),
    ("anchored first key", "es", {"about.md": ABOUT, "acerca.md": acerca_with("title: Acerca de Telar", "&t title: Acerca de Telar")}),
    ("tagged merge as the first key", "es", {"about.md": ABOUT, "acerca.md": acerca_block("!!merge <<: {localized_for: about.md, language: es}\ntitle: Acerca de Telar")}),
    ("localized_for naming its own block", "es", {"about.md": ABOUT, "acerca.md": acerca_block("&page\ntitle: Acerca de Telar\nlocalized_for: *page\nlanguage: es")}),
    ("block merging itself", "es", {"about.md": ABOUT, "acerca.md": acerca_block("&page\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n<<: *page")}),
]


def block_of(content):
    match = FRONTMATTER_PATTERN.match(content)
    return match.group(1) if match else None


def run(lang, files):
    """The generated pages, each named with the source it came from, or the build's exception."""
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as root:
        os.chdir(root)
        try:
            pages = Path("telar-content/texts/pages")
            pages.mkdir(parents=True)
            for name, content in files.items():
                (pages / name).write_text(content, encoding="utf-8")
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    # generate_collections.py passes `config.get('telar_language', 'en') or 'en'`.
                    generate_pages(telar_language=lang or "en")
            except Exception as error:  # noqa: BLE001 - the build stops on any of them
                return {"error": type(error).__name__}
            generated = {}
            for out in sorted(Path("_jekyll-files/_pages").glob("*.md")):
                written = block_of(out.read_text(encoding="utf-8"))
                sources = [n for n, c in files.items() if block_of(c) == written]
                generated[out.name] = sources[0] if len(sources) == 1 else sources
            return {"generated": generated}
        finally:
            os.chdir(cwd)


def main():
    out = []
    for name, lang, files in CASES:
        out.append({"name": name, "lang": lang, "files": files, **run(lang, files)})
    source = {
        "repository": subprocess.run(
            ["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=True
        ).stdout.strip(),
        "commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip(),
    }
    json.dump(
        {"source": source, "pyyaml": yaml.__version__, "cases": out},
        sys.stdout,
        ensure_ascii=False,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
