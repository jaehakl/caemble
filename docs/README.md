# Caemble documentation

This directory contains the maintained prose sources. Workbench Help and CLI
`docs search/show` use the same user-manual and authoring text. The CLI also
provides development and operations documents. Catalog entries, syntax declarations,
and executable examples come from their implementations and fixtures.

## Choose a task

- [Experiment authoring](authoring/experiment.md): inspect syntax, build, test locally, and explicitly submit remotely.
- [Calculation authoring](authoring/calculation.md): inspect Records, calculate, preflight, and save.
- [Solver authoring](authoring/solver.md): Draft Catalog, ABI implementation, and numerical verification.
- Workbench manual: [quick start](manual/workbench/workbench-quickstart.md), [Calculation](manual/workbench/workbench-calculation.md), [program structure](manual/program/program-overview.md), and [troubleshooting](manual/troubleshooting/troubleshooting-ready.md).

Use `caemble.cmd docs search <query>` or `sh ./caemble docs search <query>` to find
other manual pages by title, keywords, or body. `docs show experiment`,
`docs show calculation`, and `docs show solver` retain their existing aliases.

## Development

- [Architecture](development/architecture.md)
- [Web UI and CLI](development/ui.md)
- [API](development/api.md)
- [CAE kernel](development/cae.md)
- [Solver development contract](development/solver-development.md)
- [CAD elements](development/cad-elements.md)
- [Documentation maintenance](development/documentation.md)
- [SDKs](../app/sdk/README.md): independently distributed SDK documentation stays with the packages.

## Operations

- [Workers and Launcher](operations/workers.md)
- [Deployment](operations/deployment.md)
- [Object storage](operations/object-storage.md)

## Giving Codex a task

Open the Caemble repository as the working project. Codex loads applicable
`AGENTS.md` instructions automatically at startup; an attachment is not required
for each request. Discovery follows the project-root-to-working-directory path,
not every descendant directory or linked document. Explicit task requests and
higher-priority instructions still govern the task. See the
[official instructions guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

The [root AGENTS.md](../AGENTS.md) names the required scenario documents and
[CAE instructions](../app/slaves/cae/AGENTS.md). Start a new session after changing
startup instructions. Tell the agent the outcome and scope, for example:

> Develop an Experiment in this checkout. Read the Experiment guide and relevant
> syntax references, then validate it through local execution. Do not submit remotely.

## Historical material

[Archived Calculation proposal](archive/calculation-plan.md) records earlier
planning, not current behavior. Archive pages are excluded from default CLI and
web search. Third-party notices and license texts remain at their original locations.
