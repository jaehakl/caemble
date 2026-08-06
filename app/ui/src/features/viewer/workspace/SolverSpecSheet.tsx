import { kernelModules, type KernelDescriptor, type SimulationProgramManifest } from '@/lib/simulation'
import type { SimulationCompatibility } from './simulationUiTypes'

type SolverSpecSheetProps = Readonly<{
  compatibility: SimulationCompatibility
  simulationProgram?: SimulationProgramManifest | null
}>

export default function SolverSpecSheet({ compatibility, simulationProgram }: SolverSpecSheetProps) {
  const issueGroups = (
    [
      { documentType: 'structure', label: 'Structure' },
      { documentType: 'experiment', label: 'Experiment' },
    ] as const
  ).map((group) => ({
    ...group,
    issues: compatibility.issues.filter((issue) => issue.documentType === group.documentType),
  }))
  const generalIssues = compatibility.issues.filter((issue) => issue.documentType === undefined)
  const taskEntries = Object.entries(simulationProgram?.tasks ?? {})
  const descriptors: KernelDescriptor[] = [
    ...new Map(
      taskEntries.flatMap(([, task]) => {
        const kernel = kernelModules.find(
          (candidate) =>
            candidate.descriptor.name === task.kernel.name && candidate.descriptor.version === task.kernel.version,
        )
        return kernel ? [[`${kernel.descriptor.name}@${kernel.descriptor.version}`, kernel.descriptor] as const] : []
      }),
    ).values(),
  ]

  return (
    <div className="h-full overflow-auto bg-slate-50 px-4 py-4">
      <section
        aria-label="Simulation compatibility details"
        className={`rounded-lg border p-4 ${
          compatibility.status === 'compatible'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
            : compatibility.status === 'incompatible'
              ? 'border-amber-300 bg-amber-50 text-amber-950'
              : 'border-slate-200 bg-white text-slate-700'
        }`}
        role="status"
      >
        <h3 className="text-sm font-semibold">
          {compatibility.status === 'compatible'
            ? 'Simulation compatible'
            : compatibility.status === 'incompatible'
              ? `Simulation incompatible · ${compatibility.issues.length} issue${
                  compatibility.issues.length === 1 ? '' : 's'
                }`
              : compatibility.status === 'checking'
                ? 'Checking simulation compatibility'
                : 'Simulation unavailable'}
        </h3>
        {compatibility.status === 'incompatible' ? (
          <div className="mt-3 space-y-3">
            {issueGroups.map((group) =>
              group.issues.length === 0 ? null : (
                <div key={group.documentType}>
                  <h4 className="text-xs font-semibold tracking-wide uppercase">{group.label}</h4>
                  <ul className="mt-1 space-y-1 text-xs leading-5">
                    {group.issues.map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <code className="rounded bg-white/70 px-1 py-0.5">{issue.path}</code>: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
            {generalIssues.length > 0 ? (
              <ul className="space-y-1 text-xs leading-5">
                {generalIssues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`}>
                    <code className="rounded bg-white/70 px-1 py-0.5">{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-xs leading-5">
            {compatibility.status === 'compatible'
              ? 'The latest Structure, Experiment, tasks, targets, Materials, ports, and RecordedData schema passed preflight.'
              : compatibility.status === 'checking'
                ? 'Validating the latest compiled Experiment against the production kernel catalog.'
                : 'Evaluate a Structure and Experiment to start simulation preflight.'}
          </p>
        )}
      </section>

      {!simulationProgram ? (
        <div className="grid min-h-48 place-items-center px-6 text-center text-sm text-slate-500">
          Waiting for an Experiment simulation program.
        </div>
      ) : (
        <>
          <header className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-base font-semibold text-slate-900">Experiment Program</h3>
            <p className="mt-2 text-sm text-slate-600">
              Tasks are prepared independently, then <code>simulate()</code> controls their sequential execution and
              typed artifact handoffs.
            </p>
            <p className="mt-2 font-mono text-[11px] break-all text-slate-500">
              programHash · {simulationProgram.programHash}
            </p>
          </header>

          <section className="mt-5">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Kernel Tasks</h4>
            <dl className="mt-2 space-y-2">
              {taskEntries.map(([taskName, task]) => (
                <div className="rounded border border-slate-200 bg-white p-3" key={taskName}>
                  <dt className="font-mono text-xs font-semibold text-slate-900">{taskName}</dt>
                  <dd className="mt-1 font-mono text-xs text-slate-600">
                    {task.kernel.name}@{task.kernel.version}
                  </dd>
                  <dd className="mt-1 font-mono text-[11px] text-slate-500">config {task.configHash}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-5">
            <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Global RecordedData</h4>
            <dl className="mt-2 space-y-2">
              {Object.entries(simulationProgram.recordedData).map(([name, spec]) => (
                <div className="rounded border border-slate-200 bg-white p-3" key={name}>
                  <dt className="font-mono text-xs font-semibold text-slate-900">{name}</dt>
                  <dd className="mt-2 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-600">
                    {JSON.stringify(spec, null, 2)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {descriptors.map((descriptor) => (
            <section
              className="mt-5 rounded-lg border border-slate-200 bg-white p-4"
              key={`${descriptor.name}@${descriptor.version}`}
            >
              <h4 className="font-mono text-sm font-semibold text-slate-900">
                {descriptor.name}@{descriptor.version}
              </h4>
              <p className="mt-1 text-xs leading-5 text-slate-600">{descriptor.description}</p>
              <p className="mt-2 text-[11px] text-slate-500">
                Reference length <code>{descriptor.referenceLengthUnit}</code>
              </p>

              <h5 className="mt-4 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                Parameters · inputs · observations
              </h5>
              <pre className="mt-2 overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                {JSON.stringify(
                  {
                    parameters: descriptor.parameters,
                    inputPorts: descriptor.inputPorts,
                    observations: descriptor.observations,
                  },
                  null,
                  2,
                )}
              </pre>

              <h5 className="mt-4 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                Methods and output artifacts
              </h5>
              {Object.entries(descriptor.methods).map(([category, methods]) => (
                <div className="mt-3" key={category}>
                  <div className="text-xs font-semibold text-slate-700">{category}</div>
                  <div className="mt-1 space-y-2">
                    {methods.map((method) => (
                      <article className="rounded border border-slate-200 p-2" key={method.methodId}>
                        <code className="text-xs font-semibold text-orange-700">{method.methodId}</code>
                        <p className="mt-1 text-xs text-slate-600">{method.description}</p>
                        {'artifactType' in method ? (
                          <p className="mt-1 font-mono text-[11px] break-all text-sky-700">{method.artifactType}</p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}
