# page file fixtures

Every page file this project owns, copied byte for byte with `git show HEAD:<path>` on 28 September 2026.

`telar/`: the framework template. Source: https://github.com/UCSB-AMPLab/telar.git at commit `af6990f8ab607975f1f1ecd472874bdda277c260`, files `telar-content/texts/pages/about.md` and `telar-content/texts/pages/acerca.md`.

`framework/`: the test instance. Source: https://github.com/juancobo/telar.git at commit `40f8e5ca27c5ea12859d12fe317710dc4e0436c6`, files `telar-content/texts/pages/about.md`, `telar-content/texts/pages/acerca.md` and `telar-content/texts/pages/image-fixture.md`.

The test instance's `about.md` and `acerca.md` are byte-identical to the template's at these commits. All five files are UTF-8 with LF line endings, no byte-order mark, and one final newline.
