# demo content fixture, v0.9.0 English bundle

Source: https://github.com/UCSB-AMPLab/demo-content.git at commit `3fd3c5fa4813b41e62ea5e1ea8e6ce39100bdeb3`, path `demos/v0.9.0/en/`, copied byte for byte with `git show` on 26 September 2026.

Files: the two story sheets, `allegorical-woman.csv` and `colonial-landscapes.csv`, and the six layer files `colonial-landscapes.csv` names under `texts/stories/colonial-landscapes/`.

`allegorical-woman.csv` ends its rows with CRLF and breaks lines inside its multiline cells with LF. The tests derive the CRLF-inside-a-cell case from it by rewriting every line break as CRLF.
