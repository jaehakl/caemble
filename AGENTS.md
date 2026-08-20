# Repository agent instructions

- Open frontend source files explicitly as UTF-8 so Korean text is not corrupted.
- Use helper functions sparingly. Do not introduce a helper for three lines or fewer unless it is used more than twice.
- Before adding or changing a CAE Solver, read `docs/solver-development.md` and `app/slaves/cae/AGENTS.md` completely.
- QuantityKind, Material, and Solver catalog data belongs only in `app/catalog/caemble_catalog/catalog.sqlite3`. Do not add catalog data as TS, JSON, generated JS, or Markdown.
- `app/slaves/cae/manifest.json` and `app/slaves/ai/manifest.json` are launcher executable manifests, not Solver contracts; keep them.
- Treat the in-app `/docs` route as the user manual. Keep repository Markdown focused on development, architecture, and operations.
- Validate changes in this order: run the smallest relevant test first, then the package's fast suite, and run contract/full suites before handoff when the change can affect those boundaries. Do not replace focused checks with repeated whole-repository runs.
