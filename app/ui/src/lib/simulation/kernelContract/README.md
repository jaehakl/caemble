# Kernel template

Every production kernel uses one directory:

```text
kernels/<kernel>/
├─ descriptor.ts
├─ prepare.ts
├─ execute.ts
├─ index.ts
└─ contract.test.ts
```

The descriptor is the only source of runtime preflight rules and generated
`@caemble/kernels` declarations. Start with this complete descriptor shape and
replace the example identity, method, artifact, and schema.

```ts
// descriptor.ts
import type { KernelDescriptor } from '../../kernelContract'

export const exampleDescriptor = Object.freeze({
  name: 'example',
  version: '1.0.0',
  description: 'Produces one example scalar.',
  referenceLengthUnit: 'm',
  minimumOutputs: 1,
  parameters: Object.freeze({}),
  materials: Object.freeze([]),
  inputPorts: Object.freeze({}),
  observations: Object.freeze({
    iterations: Object.freeze({
      description: 'Completed solver iterations.',
      type: 'number',
    }),
  }),
  methods: Object.freeze({
    initializations: Object.freeze([]),
    boundaryConditions: Object.freeze([]),
    outputs: Object.freeze([
      Object.freeze({
        methodId: 'example.value',
        description: 'Produces the requested example value.',
        minimumOccurrences: 0,
        maximumOccurrences: Number.MAX_SAFE_INTEGER,
        target: Object.freeze({
          source: 'structure',
          kind: 'geometry',
          minimumTargets: 1,
          maximumTargets: 1,
          minimumResolved: 1,
          maximumResolved: 1,
        }),
        parameters: Object.freeze({}),
        artifactType: 'caemble.example/value@1',
        data: Object.freeze({
          dtype: 'float64',
          unit: '{fraction}',
          quantityKind: 'DimensionlessRatio',
        }),
      }),
    ]),
  }),
} as const satisfies KernelDescriptor
```

`prepare()` owns semantic resolution and conversion. Kernel numerics should not
re-resolve target strings, Materials, units, or bases.

```ts
// prepare.ts
import { normalizeKernelTaskConfig, type KernelPrepareContext } from '../../kernelContract'
import { exampleDescriptor } from './descriptor'

export type PreparedExampleInput = Readonly<{
  outputKeys: readonly string[]
}>

export function prepareExample(context: KernelPrepareContext) {
  const config = normalizeKernelTaskConfig(exampleDescriptor, context.config, context.world)
  return Object.freeze({
    prepared: Object.freeze({
      outputKeys: Object.freeze(config.outputs.map(({ key }) => key)),
    }),
  })
}
```

`execute()` returns exactly the requested keys, opaque state only when it
changes, and scalar observations.

```ts
// execute.ts
import { SimulationKernelError } from '../../errors'
import type { KernelExecutionContext, KernelExecutionInput } from '../../kernelContract'
import { exampleDescriptor } from './descriptor'
import type { PreparedExampleInput } from './prepare'

export async function executeExample(
  input: KernelExecutionInput<PreparedExampleInput>,
  context: KernelExecutionContext,
) {
  if (context.signal.aborted) {
    throw new SimulationKernelError('resource', exampleDescriptor, 'Execution was cancelled.')
  }
  context.reportProgress({ stage: 'output', completed: 0, total: input.prepared.outputKeys.length })
  const artifacts = Object.fromEntries(
    input.prepared.outputKeys.map((key, index) => {
      context.reportProgress({
        stage: 'output',
        completed: index + 1,
        total: input.prepared.outputKeys.length,
      })
      return [key, Object.freeze({ value: 1 })]
    }),
  )
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    observations: Object.freeze({ iterations: 1 }),
  })
}
```

The index wires the three responsibilities together. Add only this definition
to the production catalog.

```ts
// index.ts
import { defineKernelTask } from '../../authoring'
import type { KernelDefinition, KernelTaskConfig } from '../../kernelContract'
import type { DefinedKernelTask } from '../../types'
import { exampleDescriptor } from './descriptor'
import { executeExample } from './execute'
import { prepareExample, type PreparedExampleInput } from './prepare'

export function example<const Config extends KernelTaskConfig>(config: Config): DefinedKernelTask<Config> {
  return defineKernelTask(Object.freeze({ name: exampleDescriptor.name, version: exampleDescriptor.version }), config)
}

export const exampleKernel = Object.freeze({
  descriptor: exampleDescriptor,
  prepare: prepareExample,
  execute: executeExample,
}) satisfies KernelDefinition<PreparedExampleInput>
```

Register the builder and definition together so runtime availability and
generated authoring declarations cannot drift:

```ts
Object.freeze({
  authoringName: 'example',
  builder: example,
  definition: exampleKernel,
})
```

Contract tests should invoke the shared conformance helpers with a real task
configuration and a smallest-valid world fixture:

```ts
expect(validateKernelDescriptor(exampleDescriptor)).toEqual([])
const run = await runKernelConformance(exampleKernel, { taskName: 'example', config, world })
expect(Object.keys(run.result.artifacts)).toEqual(config.outputs.map(({ key }) => key))
await expect(assertKernelCancellationConformance(exampleKernel, run.prepared)).resolves.toBeUndefined()
```

Checklist:

- Keep every `methodId` unique across all three method categories.
- Give every output a stable versioned `artifactType` and canonical data schema.
- Declare every input artifact type, schema constraint, and cardinality.
- Resolve target groups, Materials, units, and bases in `prepare()`.
- Compute and return exactly the requested output keys; do not add hidden output.
- Return only scalar observations. Returning `state` is the explicit state-change
  signal; omit it for stateless kernels and unchanged state.
- Check cancellation at startup and periodically inside long loops.
- Report monotonic progress for preparation, solve, and output stages.
- Let the simulation runtime validate the complete result before committing state
  or artifacts; never mutate an input state object in place.
- Cover malformed ports/results, partial output rollback, cancellation, progress,
  and a numerical golden case in the contract test.
- Run `npm run generate:cad-api` after changing a descriptor; never hand-edit the
  generated kernel declaration.
