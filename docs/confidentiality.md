# Client data

Sample carrier quotes and finished proposals contain real business names,
addresses and FEINs. They are **not** in this repo and must never enter it.

- Samples live at `~/safeside-samples`, outside the repo tree.
- `.gitignore` blocks `samples/`, `fixtures/real/` and `out/` as a second line of
  defence, but the first line is not putting them there.
- Test fixtures are anonymised. Never commit a real quote as a fixture.
- `scripts/try-extract.ts` prints structure and confidence only — never customer
  values — so a terminal log or a screenshot of a run is safe to share. Its full
  JSON output goes to `out/`, which is gitignored.
