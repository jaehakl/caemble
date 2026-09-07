# Documentation maintenance

The [documentation map](../README.md) is the human entry point. Keep authored
prose in `docs/authoring`, `docs/manual`, `docs/development`, or `docs/operations`.
Archived plans live in `docs/archive` and do not enter default search.
Package READMEs contain only introductions, minimal commands, and links; independently
distributed SDK documentation and third-party notices stay with their packages.

## One body, multiple consumers

Each Markdown page starts with its title. Shared document metadata under
`app/ui/src/documentation` connects stable IDs, titles, keywords, source paths,
sections and anchors to Markdown imports. The authoring guide metadata remains
under `app/ui/src/authoring/guides.ts` to preserve its existing public contract.
The web manual and CLI use the same resolved body. Keep IDs and web anchors stable
when moving or renaming pages.

`public.ts` registers authoring and manual pages for the web. `development.ts`
registers development and operations pages for CLI access. Do not import that
second registry into the browser. CLI `docs show` accepts a document ID, while
the existing scenario aliases return their original authoring-guide shape.

Markdown is imported as text during both Vite and esbuild builds. There is no
browser filesystem access or runtime documentation server. Markdown inputs are
included in CLI build fingerprints, so `doctor` reports stale documentation until
the CLI is rebuilt. Do not edit generated bundles or create a second prose copy.

## Implementation-derived content

The manual uses `{{calculation.source}}` and `{{calculation.mathjs}}` slots for
the current Calculation skeleton and Math.js manifest. These slots are resolved
from the same implementation used by the editor and compiler. They are not
independent documentation declarations. Keep Catalog data in SQLite and use
reference IDs or live Catalog links for executable examples. Do not paste a
second Catalog or fixture into Markdown.

## Validation

Run `npm run check:docs` in `app/ui` to check the registry, links, anchors,
required instruction targets, Markdown extraction, and CLI/web parity. Existing
authoring tests verify the executable syntax fixtures. Run `npm run check` and
`npm run build` before publishing documentation changes; these include the
documentation check and the independent browser/CLI build boundaries.
