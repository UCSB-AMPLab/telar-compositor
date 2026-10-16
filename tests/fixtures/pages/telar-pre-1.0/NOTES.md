# Pre-1.0 template About pages

The template's `about.md` as three releases before v1.0.0 shipped it, copied byte for byte with `git show <tag>:<path>` from https://github.com/UCSB-AMPLab/telar.git on 16 October 2026. Sites created from these releases that never rewrote their About page still hold this text.

- `about-v0.6.0-beta.md`: tag `v0.6.0-beta`, commit `8d2a2d9098a53694e697c46180569f276e2c3a0b`.
- `about-v0.9.0-beta.md`: tag `v0.9.0-beta`, commit `ec7580b7a357ff9043c4eafcfa635812dc2e9d35`.
- `about-v0.9.1-beta.md`: tag `v0.9.1-beta`, commit `10c72e0d725e6dcfec42265e4e42081524220248`.

In v0.6.0-beta the file lived at `components/texts/pages/about.md`, in the two later tags at `telar-content/texts/pages/about.md`. The bodies, less their front matter, hash to the entries labelled "v0.6.0", "v0.9.0" and "v0.9.1" in `TEMPLATE_PAGE_BODY_HASHES`.
