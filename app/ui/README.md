# Caemble web UI and Node CLI

React/Vite serves the web Workbench; the same project builds the monorepo CLI.
See [UI development](../../docs/development/ui.md) for initial SDK/dependency setup.

From this directory, `npm run dev` starts web development, `npm run build` builds
web and CLI, and `npm run check` runs the fast maintainability checks. User-facing guides and the
[documentation map](../../docs/README.md) are maintained centrally.

Use `npm test` for unit, component, and documentation tests; use
`npm run check:full` before merging for integration, standalone, CLI/build, and
mesh/Box Grid browser checks as well. Integration tests use the `.integration.test`
suffix and run separately with `npm run test:integration`; browser checks run with
`npm run test:browser`. See the development guide for Python and Chromium setup.
