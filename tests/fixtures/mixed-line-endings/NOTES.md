# Mixed line endings fixture

`glossary-compositor-test-d0e300a1.csv` is `telar-content/spreadsheets/glossary.csv` of https://github.com/juancobo/compositor-test, at commit `d0e300a127136b522720abf33108d88e4f6dfc9c` (the repository's first commit, 17 March 2026), copied byte for byte from the GitHub contents API at that ref. It is Juan's own test site, made from the framework template.

Its header, bilingual header and instruction rows end in CRLF; its last record, the `telar` entry with a quoted two-paragraph definition, ends in LF. The template's `glossary.csv` was written this way from v0.9.1 to at least v1.4.0. The file has to keep these bytes: a checkout that converts line endings removes the case it exists for.
