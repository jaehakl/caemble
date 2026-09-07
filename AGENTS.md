# Repository agent instructions

- Open frontend source files explicitly as UTF-8 so Korean text is not corrupted.
- Use helper functions sparingly. Do not introduce a helper for three lines or fewer unless it is used more than twice.
- Before adding or changing a CAE Solver, read `docs/development/solver-development.md` and `app/slaves/cae/AGENTS.md` completely.
- QuantityKind, Material, and Solver catalog data belongs only in `app/catalog/caemble_catalog/catalog.sqlite3`. Do not add catalog data as TS, JSON, generated JS, or Markdown.
- `app/slaves/cae/manifest.json` and `app/slaves/ai/manifest.json` are launcher executable manifests, not Solver contracts; keep them.
- User-manual Markdown under `docs/` is the shared source for web `/docs` and CLI documentation. Edit one source; keep implementation-derived syntax and executable examples connected to their declarations and fixtures.

## External authoring agents

- Use `caemble.cmd` on Windows or `sh ./caemble` on POSIX from this checkout. Run `doctor` first; if the CLI is missing or stale, run `npm run build:cli` in `app/ui`.
- Start with `agent guide solver|experiment|calculation`, then `agent context <scenario>` with the relevant `--source`, `--result`, or `--measurement`. Follow its reference IDs and explicit follow-up commands; context intentionally omits full tensors and credentials. See the [documentation map](docs/README.md).
- Query exact syntax with `reference search/show` and runnable examples with `catalog search/show`. Do not infer validity from broad Math.js typings or invent Catalog names.
- [Experiment guide](docs/authoring/experiment.md): `check/build` validates without running a Solver; `test` runs locally; `batch submit` runs remotely. Reuse the same artifact and perform only the requested execution scope.
- [Calculation guide](docs/authoring/calculation.md): inspect actual Record contracts, test locally, and use the target server Measurement for the fresh preflight required by `push`.
- [Solver guide](docs/authoring/solver.md): read the complete development contract and CAE instructions above. Pytest calls CLI `build` only; publish Draft Catalog changes explicitly.

Start a new Codex session after changing startup instructions in AGENTS.md.
