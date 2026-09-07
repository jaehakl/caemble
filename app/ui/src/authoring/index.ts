import { buildCadAuthoringReference } from '../lib/cad/authoringReference'
import { cadAuthoringContract, cadElementCatalog } from '../lib/cad/elements/generated'
import { starterExperimentSourceBundle } from '../lib/localExperimentCode'
import { calculationAuthoringReference } from './calculationReference'
import { calculationExamples, calculationInvalidExamples, geometrySyntaxExamples } from './examples'
import { authoringGuides, type AuthoringScenario } from './guides'

export type { AuthoringGuide, AuthoringScenario } from './guides'
export {
  calculationExamples,
  calculationExampleInput,
  calculationInvalidExamples,
  geometrySyntaxExamples,
} from './examples'
export { calculationAuthoringReference } from './calculationReference'

export type AuthoringReference = Readonly<{
  id: string
  title: string
  summary: string
  kind: 'contract' | 'declaration' | 'element' | 'example' | 'diagnostic'
  content: string
  sourcePaths: readonly string[]
  example?: Pick<(typeof calculationExamples)[number], 'source' | 'input' | 'expected'>
}>

const cad = buildCadAuthoringReference({
  authoringContract: cadAuthoringContract,
  elements: cadElementCatalog,
  experimentSkeleton: starterExperimentSourceBundle.files['experiment.tsx'],
  geometrySkeleton: starterExperimentSourceBundle.files['geometry.tsx'],
})

const references: readonly AuthoringReference[] = [
  {
    id: 'experiment.contract',
    title: 'Experiment bundle authoring contract',
    kind: 'contract',
    summary: 'Generated element contract and complete individual starter files; the starter Task remains a draft.',
    content: `The following starter files demonstrate authoring syntax. The full starter bundle contains a placeholder Task and is not a complete runnable simulation. Select a tested live Catalog Example for simulation work.\n\n${cad.core}`,
    sourcePaths: [
      'app/ui/src/lib/cad/authoringReference.ts',
      'app/ui/src/lib/cad/elements/manifest.json',
      'app/ui/src/lib/cad/api/caemble-core.d.ts',
      'app/ui/src/lib/cad/api/cad-jsx.d.ts',
    ],
  },
  {
    id: 'experiment.modules',
    title: 'Experiment files and imports',
    kind: 'contract',
    summary: 'Use complete source bundles and the existing local-module resolver and AST policy.',
    content:
      'Core files are experiment.tsx, geometry.tsx, material.tsx and simulate.py; task files are tasks/<name>.tsx. Additional local .ts/.tsx modules use the shared bundle path and module-resolution policy. Preserve every imported file when downloading/uploading. Import Caemble public APIs from @caemble/core and local code by relative paths. Absolute paths, traversal outside the bundle and unavailable package imports are not a way to add dependencies. Read moduleResolution.ts and sourceAnalysis.ts for the current accepted path/import/export rules, then run the actual compiler. simulate.py is handled by the CAE Python validator, not the TS module resolver.',
    sourcePaths: [
      'app/ui/src/lib/cad/source/document.ts',
      'app/ui/src/lib/cad/source/moduleResolution.ts',
      'app/ui/src/lib/cad/source/sourceAnalysis.ts',
      'app/ui/src/lib/cad/source/sourcePolicy.ts',
    ],
  },
  {
    id: 'experiment.geometry',
    title: 'Named Geometry component syntax',
    kind: 'example',
    summary: 'A complete geometry.tsx syntax fixture; this does not define Tasks or a simulation.',
    content: `Custom Geometry props use direct destructuring and defaults. The accepted fixture below is checked with the real Geometry AST analyzer. Props access through an undestructured object is a negative fixture. Type-check and evaluate the full bundle after integration.\n\nAccepted geometry.tsx:\n\n\`\`\`tsx\n${geometrySyntaxExamples.valid}\`\`\`\n\nRejected geometry.tsx:\n\n\`\`\`tsx\n${geometrySyntaxExamples.invalid}\`\`\``,
    sourcePaths: [
      'app/ui/src/lib/cad/source/sourceAnalysis.ts',
      'app/ui/src/authoring/examples.ts',
      'app/ui/src/authoring/authoring.test.ts',
    ],
  },
  {
    id: 'experiment.simulate',
    title: 'simulate.py validation and runtime boundary',
    kind: 'contract',
    summary: 'Read and use the actual local CAE Python validator; no separately generated Python language subset.',
    content:
      'The program defines one undecorated async def simulate(*, sim, tasks, vars). The existing CAE validator parses Python and enforces its AST/builtin/member allowlists and fixed Task/RecordedData names. Run validate_and_load_simulate in the configured CAE Python environment with the actual task_names and recorded_names. Do not import the module as unrestricted Python to check it. A validated program has not yet run its body. sim.run invokes a registered Task; state connects the calculation lineage, typed inputs carry artifact values, sim.record persists declared records, and sim.release releases runtime handles. Inspect program.py and simulation.py for accepted calls and tests for valid/invalid syntax. The Node compiler does not validate Python syntax. Full orchestration, artifact contracts, output schemas and numerical results need CAE execution.',
    sourcePaths: [
      'app/slaves/cae/app/kernel/coordinator/program.py',
      'app/slaves/cae/app/kernel/coordinator/simulation.py',
      'docs/development/solver-development.md',
      'app/slaves/cae/tests',
    ],
  },
  {
    id: 'calculation.contract',
    title: 'Calculation language and output contract',
    kind: 'contract',
    summary: 'Shared compiler/runtime contract, generated Math.js names and limits.',
    content:
      Object.entries(calculationAuthoringReference.contract)
        .map(([name, value]) => `- ${name}: ${value}`)
        .join('\n') +
      `\n\nRuntime limits:\n\n\`\`\`json\n${JSON.stringify(calculationAuthoringReference.limits, null, 2)}\n\`\`\`\n\nMath.js APIs:\n` +
      calculationAuthoringReference.mathjs.map(({ group, names }) => `- ${group}: ${names.join(', ')}`).join('\n') +
      '\n\nThese lists are generated from the same source as the compiler. The AST policy, dependency analysis and runtime output validation impose additional semantic rules; declarations alone do not prove validity.',
    sourcePaths: [
      'app/ui/src/lib/calculation/declarations.ts',
      'app/ui/src/lib/calculation/mathjsManifest.ts',
      'app/ui/src/lib/calculation/sourcePolicy.ts',
      'app/ui/src/lib/calculation/validation.ts',
    ],
  },
  {
    id: 'calculation.declarations',
    title: 'Calculation compiler declarations',
    kind: 'declaration',
    summary: 'Exact declaration text used by browser and Node type-checking.',
    content: `Some Math.js overloads intentionally use any. Validate numerical arguments and output by execution.\n\n\`\`\`typescript\n${calculationAuthoringReference.declaration}\n\`\`\``,
    sourcePaths: ['app/ui/src/lib/calculation/declarations.ts'],
  },
  {
    id: 'calculation.policy',
    title: 'Calculation policy names',
    kind: 'contract',
    summary: 'Generated allow/block names shared with the AST source policy.',
    content: `This name table is part of the policy, not a list of unrestricted APIs. Native aliases, dynamic members and context-specific operations have additional AST checks.\n\n\`\`\`json\n${JSON.stringify(calculationAuthoringReference.policy, null, 2)}\n\`\`\``,
    sourcePaths: ['app/ui/src/lib/calculation/policyContract.ts', 'app/ui/src/lib/calculation/sourcePolicy.ts'],
  },
  {
    id: 'calculation.dependencies',
    title: 'Fixed Calculation record dependencies',
    kind: 'contract',
    summary: 'A fixed record path and a numeric array index are separate policies.',
    content: `${calculationAuthoringReference.contract.dependencies}\n\nAccepted full-function pattern: export default function calculate(record) { const signal = record['signal']; return { dtype: 'float64', data: Number(signal.data) } }. The name must exist in the actual ExperimentRecord catalog. This pattern assumes a scalar numeric leaf; use the complete examples for arrays. Dynamic record[key] is rejected even if key currently contains a string literal. Numeric data[index] accesses are runtime-guarded to non-negative safe integers. Run analyzeCalculationDependencies(source, availableNames) separately from compile/run. Missing data in a selected Measurement remains an input availability error even if its name is declared.`,
    sourcePaths: [
      'app/ui/src/lib/calculation/dependencies.ts',
      'app/ui/src/lib/calculation/indexGuard.ts',
      'app/ui/src/lib/calculation/transform.ts',
    ],
  },
  {
    id: 'calculation.snapshot',
    title: 'Offline Calculation input and provenance',
    kind: 'contract',
    summary: 'Keep complete normalized leaf values separate from their provenance envelope.',
    content:
      'CalculationInput is a read-only dotted-path map. Each leaf contains dtype, shape, scalar-or-flat data, complete axes (name/ticks/optional unit), required tensorOrder and optional quantityKind/unit. Use the shared RecordedData normalization to resolve metadata; never infer tensorOrder solely from array rank. Execute only the input map. Keep schema version, Experiment/Measurement/RecordedData identities, source hash, Catalog revision, input content hash and capture time outside that map. Verify the envelope and hashes before replay. Samples and truncated rows cannot be marked complete. Normalized offline input needs no live Catalog lookup; fetching/normalizing a new remote snapshot does. An offline fixture cannot stand in for a server save preflight. Render the normalized output with the same source/input hashes; do not attach a newer source or Catalog silently to an older result.',
    sourcePaths: [
      'app/ui/src/lib/calculation/types.ts',
      'app/ui/src/lib/calculation/validation.ts',
      'app/ui/src/features/calculation/calculationRecordedData.ts',
    ],
  },
  {
    id: 'solver.workflow',
    title: 'Solver development source of truth',
    kind: 'contract',
    summary: 'Read the live development guide, CAE instructions, Catalog library and ABI 2 types.',
    content: authoringGuides.find(({ id }) => id === 'solver')!.content,
    sourcePaths: authoringGuides.find(({ id }) => id === 'solver')!.sourcePaths,
  },
  {
    id: 'diagnostic.cli',
    title: 'CLI request and isolated process failures',
    kind: 'diagnostic',
    summary: 'Preserve process/request failures without inventing a source location.',
    content:
      'Read the original error message/code and stage first. A worker-request failure occurred before a valid authoring operation was identified; inspect the caller request and rebuild the CLI if its checkout inputs changed. An input failure can occur before Calculation compilation when reading or parsing a fixture; check its path and complete JSON map. A build failure can occur during evaluation or output writing after TypeScript checks. Keep the operation sourceHash when supplied, but location remains null unless a compiler or validator supplied a real position. Use doctor to verify the checkout/build and Python environment. Do not treat child interruption, timeout or a partial output file as successful execution.',
    sourcePaths: [
      'app/ui/src/cli/worker.ts',
      'app/ui/src/contracts/authoring.ts',
      'app/ui/src/platform/node/environment.ts',
    ],
  },
  {
    id: 'diagnostic.experiment',
    title: 'Act on Experiment diagnostics by validation stage',
    kind: 'diagnostic',
    summary: 'Separate source policy, TypeScript, evaluation, Python, build, upload and solver failures.',
    content:
      'Path/import or AST policy: inspect the exact file and source rule; use experiment.modules or the referenced element. TypeScript: use the supplied TS diagnostic and actual declarations. Evaluation: inspect variable shapes, geometry IDs, material/solver lookups and the captured Catalog revision. Python: read program.py and use the actual CAE validator; the TypeScript compiler alone does not validate Python. CLI check/build additionally invoke that local Python validator, but do not execute the simulate body. Build: verify Task descriptors and frozen input. Upload: compare source/base identity and Catalog revision, then refresh/rebuild if required. Solver/job: retain job and Measurement IDs and inspect logs, requested outputs, recording schemas and units. Retry deliberately. Preserve exact diagnostic fields that exist; a message-only error must not be presented with invented precision. Rerun the failed stage and its dependent stages after fixing the cause.',
    sourcePaths: [
      'app/ui/src/lib/cad/source/sourceAnalysis.ts',
      'app/ui/src/lib/cad/compiler',
      'app/slaves/cae/app/kernel/coordinator/program.py',
    ],
  },
  {
    id: 'diagnostic.calculation',
    title: 'Act on Calculation diagnostics',
    kind: 'diagnostic',
    summary: 'Policy/compile/input/runtime/timeout/output failures require different evidence.',
    content:
      'policy: inspect the supplied range/sourceLine, calculation.policy and fixed dependency rules. compile: fix JavaScript or JSDoc type errors against calculation.declarations; keep supplied TS positions. input-too-large: acquire a deliberately reduced complete dataset with clear provenance, not a silently truncated original. runtime: check actual leaf data, numeric indexes, finite/rank/shape/axis rules and logs; output validation can report runtime unless it exceeds the dedicated output size limit. timeout: inspect algorithm complexity or loops in a disposable child, then reduce work explicitly. output-too-large: reduce output dimensions. cancelled: no successful result exists. Always retain the original message and source hash; reference IDs supplement rather than replace them. The examples include expected failures at their real rejection stage.',
    sourcePaths: [
      'app/ui/src/lib/calculation/types.ts',
      'app/ui/src/lib/calculation/sourcePolicy.ts',
      'app/ui/src/lib/calculation/validation.ts',
      'app/ui/src/platform/node/calculation.ts',
    ],
  },
  ...cad.elements.map((element): AuthoringReference => ({
    id: `element.${element.authoringName}`,
    title: element.authoringName,
    kind: 'element',
    summary: element.summary,
    content: [
      `Canonical syntax: ${element.syntax}`,
      `Children: ${JSON.stringify(element.children)}`,
      ...element.properties.map(
        (property) =>
          `- ${property.name}: ${property.type}; ${property.required ? 'required' : 'optional'}. ${property.description}`,
      ),
      'Surface slots:',
      ...element.surfaces.map((surface) => `- ${surface.index}: ${surface.label}; ${surface.description}`),
      'Element expression snippet (not a complete Experiment; import and insert into a valid geometry context):',
      '```tsx',
      element.example,
      '```',
    ].join('\n'),
    sourcePaths: ['app/ui/src/lib/cad/elements/manifest.json', 'app/ui/src/lib/cad/api/cad-jsx.d.ts'],
  })),
  ...calculationExamples.map((example): AuthoringReference => ({
    id: example.id,
    title: example.title,
    kind: 'example',
    summary: 'Executable synthetic fixture with full source, input and expected normalized output.',
    content: `This is a local test fixture, not server data or save preflight.\n\ncalculation.js:\n\n\`\`\`javascript\n${example.source}\`\`\`\n\nInput:\n\n\`\`\`json\n${JSON.stringify(example.input, null, 2)}\n\`\`\`\n\nExpected normalized output:\n\n\`\`\`json\n${JSON.stringify(example.expected, null, 2)}\n\`\`\``,
    sourcePaths: ['app/ui/src/authoring/examples.ts', 'app/ui/src/authoring/authoring.test.ts'],
    example: { source: example.source, input: example.input, expected: example.expected },
  })),
  {
    id: 'calculation.examples.invalid',
    title: 'Rejected Calculation fixtures',
    kind: 'example',
    summary: 'Negative examples validated at source-policy, dependency, compile or output stage.',
    content: calculationInvalidExamples
      .map(({ id, stage, source }) => `${id}: expected rejection by ${stage}\n\n\`\`\`javascript\n${source}\n\`\`\``)
      .join('\n\n'),
    sourcePaths: ['app/ui/src/authoring/examples.ts', 'app/ui/src/authoring/authoring.test.ts'],
  },
]

export function listAuthoringGuides() {
  return authoringGuides
}

export function getAuthoringGuide(id: AuthoringScenario) {
  const guide = authoringGuides.find((guide) => guide.id === id)
  if (!guide) throw new Error(`Unknown authoring scenario: ${id}. Use experiment, calculation or solver.`)
  return guide
}

export function listAuthoringReferences() {
  return references
}

export function getAuthoringReference(id: string) {
  return references.find((reference) => reference.id === id)
}

export function searchAuthoringReference(query: string, limit = 20): readonly AuthoringReference[] {
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return references
    .map((reference) => {
      const title = `${reference.id} ${reference.title}`.toLowerCase()
      const text = `${title} ${reference.summary} ${reference.content}`.normalize('NFKC').toLowerCase()
      return {
        reference,
        score: terms.reduce((score, term) => score + (title.includes(term) ? 4 : text.includes(term) ? 1 : 0), 0),
      }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.reference.id.localeCompare(right.reference.id))
    .slice(0, Math.max(0, Math.min(100, Math.floor(limit))))
    .map(({ reference }) => reference)
}
