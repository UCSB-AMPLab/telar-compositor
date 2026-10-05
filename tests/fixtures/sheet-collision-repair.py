"""
Writes sheet-collision-repair.json: what the framework's 1.8.0 upgrade does to
a site's sheets before its first build (`repair_colliding_columns` in
scripts/migrations/v180_sheets.py), case by case, and how it reads sheets on
the way.

Each case is a site: its sheets are written into a temporary site as UTF-8,
and each sheet `sheets_to_check` finds is repaired with `_repair_sheet`, as
`repair_colliding_columns` repairs it on a site that does not read Google
Sheets. The fixture records the sheets checked and the role each is read in,
every record the repair made (its message key, its arguments as strings, and
its status), each sheet's text afterwards, and whether the byte splitter could
split it. The `readings` record how `Sheet` reads a text, and the data rows and
claimed names under each role's scoping.

The cases are the repair inputs of tests/unit/test_migration_v180_sheets.py,
the cases the Compositor's design names, seeded random sheets drawn from each
role's vocabulary, and the sheets of this checkout and of the Compositor's
fixtures with collisions added to them (empty columns only, so no value is
invented).

Run from the root of a Telar checkout, with that checkout's Python
environment, and pass this file's path:

    cd "$TELAR_FRAMEWORK_DIR"
    .venv/bin/python3 <compositor>/tests/fixtures/sheet-collision-repair.py [--out DIR]

`npm run parity:regenerate` runs this with every other generator.

Version: v1.5.0-beta
"""

import json
import os
import platform
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas

sys.path.insert(0, "scripts")
from migrations import v180_sheets  # noqa: E402
from telar import csv_utils  # noqa: E402

HERE = Path(__file__).parent

OBJECTS_EMPTY_OBJECT_TYPE = (
    "object_id,title,medium,object_type\n"
    "map-1,A map,Ink on paper,\n"
    "map-2,Another map,,\n"
    "map-3,A third map,Watercolour,\n"
)
COMPOSITOR_CASE = "note,Note,step,answer\n,#kept,1,Here.\n"
LONG_CELL = "x" * 200_000

# The repair inputs of the framework's tests, by class and test.
FRAMEWORK_CASES = [
    ("TestOneColumnHoldsValues: object_type goes", {"objects.csv": OBJECTS_EMPTY_OBJECT_TYPE}),
    ("TestOneColumnHoldsValues: the reverse", {"objects.csv": (
        "object_id,title,medium,object_type\nmap-1,A map,,Ink on paper\nmap-2,Another map,,\n")}),
    ("TestNoColumnHoldsValues: canonical spelling", {"objects.csv": "object_id,object_type,title,medium\nmap-1,,A map,\n"}),
    ("TestNoColumnHoldsValues: first wins", {"objects.csv": "object_id,title,tipo_objeto,object_type\nmap-1,A map,,\n"}),
    ("TestMoreThanOneColumnHoldsValues", {"objects.csv": "object_id,title,medium,object_type\nmap-1,A map,Ink,Paper\n"}),
    ("TestRowsThatAreNotData: comment row", {"objects.csv": (
        "object_id,title,medium,object_type\n# instructions,,,write the medium here\nmap-1,A map,Ink,\n")}),
    ("TestRowsThatAreNotData: Spanish header row", {"objects.csv": (
        "object_id,title,medium,object_type\nid_objeto,titulo,medio,tipo_objeto\nmap-1,A map,Ink,\n")}),
    ("TestRowsThatAreNotData: hash column", {"objects.csv": "object_id,title,medium,object_type,#medium\nmap-1,A map,Ink,,\n"}),
    ("TestTheScopingOfEachSheet: project privado", {"project.csv": (
        "order,story_id,title,protected,privado\n1,my-story,My story,yes,\n")}),
    ("TestTheScopingOfEachSheet: glossary tipo", {"glossary.csv": "term_id,title,definition,kind,tipo\ncord,Cord,A cord,term,\n"}),
    ("TestTheScopingOfEachSheet: objects privado", {"objects.csv": "object_id,title,protected,privado\nmap-1,A map,,\n"}),
    ("TestTheScopingOfEachSheet: note beside Note", {"my-story.csv": (
        "step,object,question,answer,note,Note\n1,map-1,Where?,Here.,A note,\n")}),
    ("TestTheScopingOfEachSheet: identical headers", {"my-story.csv": (
        "step,object,question,answer,note,note\n1,map-1,Where?,Here.,,\n")}),
    ("TestTheScopingOfEachSheet: pandas suffixes", {"my-story.csv": "step,answer,note,note,note.1\n1,Here.,,,\n"}),
    ("TestTheScopingOfEachSheet: suffixed label collides", {"my-story.csv": "step,answer,note,Note,note\n1,Here.,x,,\n"}),
    ("TestTheScopingOfEachSheet: relabelled twin", {"my-story.csv": "step,answer,note,note,note,Note\n1,Here.,,,,y\n"}),
    ("TestTheScopingOfEachSheet: records name the kept column", {"my-story.csv": "step,answer,Note,note,note\n1,Here.,,,value\n"}),
    ("TestTheScopingOfEachSheet: all empty", {"my-story.csv": "step,answer,note,Note\n1,Here.,,\n"}),
    ("TestTheScopingOfEachSheet: a collision a removal creates", {"my-story.csv": "step,answer,note,note,Note\n1,Here.,,x,y\n"}),
    ("TestTheRowsTheBuildReads: marked", {"story1.csv": COMPOSITOR_CASE}),
    ("TestTheRowsTheBuildReads: quoted first header", {"story1.csv": (
        '﻿"note",Note,step,answer\r\n,#kept,1,"Here, now."\r\n')}),
    ("TestTheRowsTheBuildReads: first column the header row needs", {"story1.csv": (
        "note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n,x,1,Here.,map-1,e\n")}),
    ("TestTheRowsTheBuildReads: later column the header row needs", {"story1.csv": (
        "step,answer,object,note,Note,extra\npaso,respuesta,objeto,pregunta,,libre\n1,Here.,map-1,,x,e\n")}),
    ("TestTheRowsTheBuildReads: later column removed", {"story1.csv": "step,answer,note,Note\n1,Here.,,#kept\n"}),
    ("TestTheFileKeepsItsForm: CRLF with BOM", {"objects.csv": (
        '﻿object_id,title,medium,object_type\r\nmap-1,"A map, folded",Ink,\r\n')}),
    ("TestTheFileKeepsItsForm: newline in a cell", {"my-story.csv": (
        'step,object,question,answer,note,Note\n1,map-1,Where?,"Two\nlines",,\n')}),
    ("TestTheFileKeepsItsForm: CR", {"objects.csv": "object_id,title,medium,object_type\rm,M,Ink,\r"}),
    ("TestTheFileKeepsItsForm: CRLF", {"objects.csv": "object_id,title,medium,object_type\r\nm,M,Ink,\r\n"}),
    ("TestTheFileKeepsItsForm: LF", {"objects.csv": "object_id,title,medium,object_type\nm,M,Ink,\n"}),
    ("TestTheFileKeepsItsForm: mixed terminators", {"objects.csv": (
        "object_id,title,medium,object_type\r\nm,M,Ink,\nn,N,Oil,\rp,P,,")}),
    ("TestTheFileKeepsItsForm: surviving fields", {"objects.csv": (
        'object_id,"title",object_type,medium\n"m",  spaced  ,,"Ink ""wet"", on\npaper"\nn,"N",  ,\n')}),
    ("TestTheFileKeepsItsForm: first column can go", {"my-story.csv": "Note,step,answer,note\n,1,Here.,x\n"}),
    ("TestTheFileKeepsItsForm: short row and blank line", {"objects.csv": (
        "object_id,title,medium,object_type\nm,M\n\nn,N,Ink,\n")}),
    ("TestTheFileKeepsItsForm: text after closing quote", {"objects.csv": 'object_id,title,medium,object_type\nm,"M"x,Ink,\n'}),
    ("TestTheFileKeepsItsForm: unclosed quote", {"objects.csv": 'object_id,title,medium,object_type\nm,"M,Ink,\n'}),
    ("TestTheFileKeepsItsForm: a field over the default limit", {"objects.csv": (
        f'object_id,title,medium,object_type\nm,"{LONG_CELL}",Ink,\n')}),
    ("TestTheFileKeepsItsForm: second run", {"objects.csv": (
        "object_id,title,medium\nmap-1,A map,Ink on paper\nmap-2,Another map,\nmap-3,A third map,Watercolour\n")}),
    ("TestTheLinesPandasSkips: blank lead", {"story1.csv": "\nnote,Note,step\n,v,1\n"}),
    ("TestTheLinesPandasSkips: whitespace lead", {"story1.csv": "  \t\nnote,Note,step\n,v,1\n"}),
    ("TestTheLinesPandasSkips: BOM and blank line", {"objects.csv": "﻿\nobject_id,title,medium,object_type\nm,M,Ink,\n"}),
    ("TestTheLinesPandasSkips: CRLF with skipped lines", {"story1.csv": (
        "\r\n\r\nnote,Note,step\r\n,v,1\r\n \t\r\n,w,2\r\n")}),
    ("TestTheLinesPandasSkips: removal empties a row", {"story1.csv": "step,paso\n1,\n,\n"}),
    ("TestTheLinesPandasSkips: first column marked", {"story1.csv": "paso,step\n,1\n,\n"}),
    ("TestTheLinesPandasSkips: wider row", {"story1.csv": "\nstep,answer,note,Note\n1,Here.,,x,extra\n"}),
    ("TestTheLinesPandasSkips: wider first row", {"story1.csv": "step,answer,note,Note\n1,Here.,,x,extra\n"}),
    ("TestTheLinesPandasSkips: quoted empty row", {"story1.csv": 'step,paso\n1,\n"",\n'}),
    ("TestTheLinesPandasSkips: blank header", {"story1.csv": " ,\t\n"}),
    ("TestReportsWithoutRepair: reserved column", {"my-story.csv": (
        "step,object,question,answer,_metadata\n1,map-1,Where?,Here.,x\n")}),
    ("TestReportsWithoutRepair: no sheets", {}),
]

# The cases the design names that the framework's tests do not already hold.
DESIGN_CASES = [
    ("design: note,note,Note with values in the last two", {"s.csv": "note,note,Note\nx,,y\n"}),
    ("design: note,note,Note in two passes", {"s.csv": "step,note,note,Note\n1,,x,\n"}),
    ("design: bilingual header row survives", {"s.csv": "step,answer,note,Note\npaso,respuesta,,\n1,Here.,,x\n"}),
    ("design: BOM with CRLF on a story", {"s.csv": "﻿step,note,Note\r\n1,,x\r\n"}),
    ("design: quoted fields", {"s.csv": '"step","note","Note"\n"1","","x, y"\n'}),
    ("design: both glossary files", {
        "glossary.csv": "term_id,title,kind,tipo\nx,X,term,\n",
        "glosario.csv": "id_termino,titulo,kind,tipo\nx,X,term,\n"}),
    ("design: every role at once", {
        "project.csv": "order,story_id,title,private,protected\n1,s,S,,yes\n",
        "proyecto.csv": "orden,id_historia,titulo,privada,protegida\n1,s,S,,\n",
        "objetos.csv": "id_objeto,titulo,medio,tipo_objeto\nm,M,,Ink\n",
        "glossary.csv": "term_id,title,Tipo,kind\nx,X,,term\n",
        "s.csv": "step,paso,Step\n1,,\n"}),
    ("design: headers only Unicode 17 folds together", {"s.csv": "step,answer,\ua7ce,\ua7cf\n1,Here.,x,\n"}),
    ("design: objects preferred in English", {
        "objects.csv": "object_id,title\nm,M\n",
        "objetos.csv": "id_objeto,medio,tipo_objeto\nm,,\n"}),
]

# Each role's column vocabulary, and the file each role is written under.
VOCABULARY = {
    "story": ["note", "Note", " note", "note.1", "paso", "step", "#x", "", "_metadata", "answer", "respuesta"],
    "objects": ["medium", "object_type", "tipo_objeto", "privado", "protected", "crédito", "credit", "object_id", "title"],
    "glossary": ["kind", "tipo", "Tipo", "términos_relacionados", "related_terms", "term_id", "title"],
    "project": ["protected", "privada", "titulo", "title", "order", "story_id"],
}
FILE_OF = {"story": "story1.csv", "objects": "objects.csv", "glossary": "glossary.csv", "project": "project.csv"}
SPANISH = {"step": "paso", "answer": "respuesta", "medium": "medio", "credit": "crédito", "title": "titulo",
           "kind": "tipo", "protected": "privado", "term_id": "id_termino", "order": "orden",
           "object_id": "id_objeto", "related_terms": "términos_relacionados", "story_id": "id_historia"}
CELLS = ["", "", "", "x", "y", " ", "#c", "1", '"q ""r"""', '"a,b"', "\t", '""']


def _random_sheet(rng):
    role = rng.choice(list(VOCABULARY))
    words = VOCABULARY[role]
    width = rng.randint(1, 6)
    header = [rng.choice(words) for _ in range(width)]
    if rng.random() < 0.05:
        header[rng.randrange(width)] += "\x00z"
    terminator = rng.choice(["\n", "\r\n", "\r", "mixed"])
    lines = [",".join(header)]
    if rng.random() < 0.3:
        lines.append(",".join(SPANISH.get(h.strip().lower(), h) for h in header))
    for _ in range(rng.randint(0, 6)):
        kind = rng.random()
        if kind < 0.1:
            lines.append(rng.choice(["", " ", " \t", '""', ","]))
        elif kind < 0.2:
            lines.append("# comment," + ",".join(rng.choice(CELLS) for _ in range(width - 1)))
        else:
            row_width = max(1, width + rng.choice([-1, 0, 0, 0, 1]))
            lines.append(",".join(rng.choice(CELLS) for _ in range(row_width)))
    if rng.random() < 0.05:
        lines.append('m,"M"x,y')
    if rng.random() < 0.3:
        lines.insert(0, rng.choice(["", " ", "\t"]))
    ends = [rng.choice(["\n", "\r\n", "\r"]) if terminator == "mixed" else terminator for _ in lines]
    text = "".join(line + end for line, end in zip(lines, ends))
    if rng.random() < 0.3:
        text = text[:-len(ends[-1])]
    mark = rng.random()
    if mark < 0.15:
        text = "﻿" + text
    elif mark < 0.2:
        text = "﻿﻿" + text
    return FILE_OF[role], text


def _fuzz_cases():
    rng = random.Random(0x514B)
    cases = []
    for index in range(600):
        name, text = _random_sheet(rng)
        cases.append((f"fuzz {index}", {name: text}))
    return cases


def _insert_column(text, position, name):
    """*text* with an empty column headed *name* at *position*, or None when
    the framework's splitter cannot split it."""
    sheet = v180_sheets.Sheet("x.csv", text)
    if sheet.records is None or not sheet.header:
        return None
    out = []
    for index, (fields, ending) in enumerate(sheet.records):
        fields = list(fields)
        if not sheet.skipped[index] and index >= sheet.header_at:
            at = min(position, len(fields)) if position >= 0 else len(fields)
            fields.insert(at, name if index == sheet.header_at else "")
        out.append(",".join(fields) + ending)
    return ("﻿" if sheet.bom else "") + "".join(out)


def _role_file(name):
    return name if name in ("objects.csv", "glossary.csv", "project.csv") else "story1.csv"


def _recorded_cases():
    sources = sorted(Path("telar-content/spreadsheets").glob("*.csv"))
    sources += [HERE / n for n in ("objects.csv", "story.csv", "glossary.csv", "project.csv")]
    sources += sorted((HERE / "story-canonical" / "demo-v0.9.0-en").glob("*.csv"))
    cases = []
    for path in sources:
        text = path.read_bytes().decode("utf-8")
        label = f"recorded {path.parent.name}/{path.name}"
        target = _role_file(path.name)
        cases.append((label, {target: text}))
        try:
            header = v180_sheets.Sheet("x.csv", text).header
        except ValueError:
            continue
        named = [h for h in header if h and not h.startswith("#") and h.capitalize() != h]
        variants = []
        if named:
            variants.append(("an empty capitalised twin", _insert_column(text, -1, named[0].capitalize())))
        if header:
            variants.append(("an empty duplicate at position 0", _insert_column(text, 0, header[0].upper())))
        if target == "objects.csv":
            claims = [csv_utils.COLUMN_NAME_MAPPING.get(h.strip().lower(), h.strip().lower()) for h in header]
            if "medium" in claims:
                at = claims.index("medium")
                twin = "medium" if header[at].strip().lower() == "object_type" else "object_type"
                variants.append((f"an empty {twin} beside {header[at]}", _insert_column(text, at + 1, twin)))
        if target == "glossary.csv":
            folded = [h.strip().lower() for h in header]
            if "kind" in folded:
                variants.append(("a tipo beside kind", _insert_column(text, folded.index("kind") + 1, "tipo")))
            else:
                with_kind = _insert_column(text, -1, "kind")
                variants.append(("an empty kind and tipo", with_kind and _insert_column(with_kind, -1, "tipo")))
        for what, variant in variants:
            if variant is not None:
                cases.append((f"{label}: {what}", {target: variant}))
    return cases


def _role(name, scope):
    if "canonical_fields" in scope:
        return "objects"
    if "sheet_aliases" in scope:
        return "glossary"
    return "project" if name in v180_sheets.PROJECT_SHEETS else "story"


def _run_case(name, sheets, captured):
    with tempfile.TemporaryDirectory() as site:
        Path(site, "_config.yml").write_text('telar_language: "en"\n', encoding="utf-8")
        directory = Path(site, v180_sheets.SPREADSHEETS_DIR)
        directory.mkdir(parents=True)
        for file, text in sheets.items():
            (directory / file).write_bytes(text.encode("utf-8"))
        checked = []
        for file, scope in v180_sheets.sheets_to_check(site, csv_utils):
            captured.clear()
            v180_sheets._repair_sheet(site, "en", file, scope, csv_utils, False)
            after = (directory / file).read_bytes().decode("utf-8")
            try:
                split = v180_sheets.Sheet("x.csv", after).records is not None
            except ValueError:
                split = None
            checked.append({"name": file, "role": _role(file, scope), "records": list(captured),
                            "after": after, "split": split})
        return {"name": name, "sheets": sheets, "checked": checked}


SCOPES = {
    "project": {},
    "story": {},
    "objects": {"canonical_fields": csv_utils.OBJECT_FIELDS},
    "glossary": {"sheet_aliases": csv_utils.GLOSSARY_COLUMN_ALIASES},
}


def _reading(name, text):
    try:
        sheet = v180_sheets.Sheet("x.csv", text)
    except ValueError as error:
        return {"name": name, "text": text, "error": type(error).__name__}
    return {
        "name": name, "text": text, "bom": sheet.bom, "rows": sheet.rows, "records": sheet.records,
        "skipped": sheet.skipped, "header_at": sheet.header_at, "labels": sheet.labels,
        "data_rows": {role: v180_sheets.data_rows(sheet, csv_utils, scope.get("sheet_aliases"))
                      for role, scope in SCOPES.items()},
        "claimed_names": {role: list(v180_sheets.claimed_names(sheet.labels, csv_utils, **scope).items())
                          for role, scope in SCOPES.items()},
    }


def _readings(fuzz):
    rng = random.Random(0x514C)
    alphabet = ["a", ",", '"', "\r", "\n", " ", "\t", "#", "\x00", "﻿", "a.1", "Unnamed: 0", "B", "b"]
    texts = ["".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40))) for _ in range(300)]
    readings = [_reading(f"random {i}", text) for i, text in enumerate(texts)]
    readings += [_reading(f"reading of {name}", text) for name, sheets in fuzz for text in sheets.values()]
    return readings


def main():
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else HERE
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    captured = []

    def record(lang, key, *args, status=v180_sheets.ChangeStatus.APPLIED):
        captured.append([key, [str(a) for a in args], status.name.lower()])
        return original(lang, key, *args, status=status)

    original = v180_sheets._record
    v180_sheets._record = record
    try:
        fuzz = _fuzz_cases()
        cases = [_run_case(name, sheets, captured)
                 for name, sheets in FRAMEWORK_CASES + DESIGN_CASES + fuzz + _recorded_cases()]
    finally:
        v180_sheets._record = original
    (out_dir / "sheet-collision-repair.json").write_text(json.dumps({
        "framework_commit": commit,
        "pandas_version": pandas.__version__,
        "python_version": platform.python_version(),
        "cases": cases,
        "readings": _readings(fuzz),
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
