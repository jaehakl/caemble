import { CALCULATION_MONACO_DECLARATION, CALCULATION_SOURCE_SKELETON } from '../lib/calculation/declarations'
import { CALCULATION_MATHJS_REFERENCE } from '../lib/calculation/mathjsManifest'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CALCULATION_TIMEOUT_MS,
} from '../lib/calculation/types'

import {
  CALCULATION_ALLOWED_RUNTIME_GLOBALS,
  CALCULATION_BLOCKED_MEMBER_NAMES,
  CALCULATION_BLOCKED_GLOBAL_NAMES,
} from '../lib/calculation/policyContract'
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n')
export const calculationAuthoringReference = {
  language: 'javascript',
  contract: {
    export: 'One synchronous default-export function with one identifier parameter.',
    import: "Only named imports from 'mathjs' are allowed.",
    input:
      'A read-only dotted-path map of float32/float64 Box Grid Outputs with seven axes: x, y, z, time, frequency, amplitudePhase, component. Each leaf has Box pose, size and cell-center grid metadata. Complex fields use amplitude/phase channels in radians; convert these explicitly for complex arithmetic. Automatic visualizations are excluded.',
    dependencies:
      "Use only fixed record.member, record['dotted.path'], static object destructuring, or traceable const aliases. Dynamic keys, enumeration, spread, reassignment, and passing or returning the whole record are rejected when saving.",
    projection:
      'The frozen global boxGrid.project(leaf, { axes, representation?, component?, reduce?, frame? }) projects channels/components before canonical x/y/z/time/frequency reductions. axes preserve their order; omitted axes default to mean. Reduction methods: sum, mean, min, max, median, std (population), index (zero-based). representation: amplitude or phase; phase requires a component index. component: numeric index or magnitude. frame.timeSeconds synthesizes A*cos(phase+2*pi*f*t) with frequency converted to Hz; frequency sum/mean runs component-wise before magnitude and remaining axis reductions. mean divides by the frequency sample count. DC stays constant. No extra spectral weighting or FFT normalization is applied. frame.phase is the legacy common phase in radians and cannot be combined with timeSeconds; frame.axis/time-or-frequency and frame.index freeze a sweep. Returns { dtype: float64, data, axes }. Five-axis Histogram projections are intermediate values; reduce to rank 0/1/2/3 before returning.',
    output: 'Return { dtype, data, axes? }; shape is inferred from rank-0/1/2/3 finite real data.',
    axes: 'Axes are optional. When supplied, every axis and tick must match the inferred shape and units use UCUM.',
    validation: 'Complex final values, NaN, Infinity, ragged arrays, rank above 3, and explicit shape are rejected.',
    persistence:
      'Saving a new or source-changed Calculation requires a successful preflight; its source hash, ExperimentRecord dependencies, and exact dtype/shape/axes output layout become the stored contract.',
    indexing:
      'Dynamic bracket indexes are allowed only when they resolve to non-negative safe integers. Dynamic string properties are rejected.',
    console:
      'The frozen console exposes only log; direct, fixed-string bracket, and aliased console.log calls are allowed.',
    security:
      'Prototype and constructor access, dynamic Math members, random functions, native Object/Array aliases, globals, and dynamic imports remain blocked.',
  },
  limits: {
    inputBytes: CALCULATION_INPUT_MAX_BYTES,
    outputElements: CALCULATION_OUTPUT_MAX_ELEMENTS,
    executionMilliseconds: CALCULATION_TIMEOUT_MS,
  },
  policy: {
    globals: CALCULATION_ALLOWED_RUNTIME_GLOBALS,
    blockedGlobals: CALCULATION_BLOCKED_GLOBAL_NAMES,
    blockedMembers: CALCULATION_BLOCKED_MEMBER_NAMES,
  },
  mathjs: CALCULATION_MATHJS_REFERENCE,
  declaration: normalizeNewlines(CALCULATION_MONACO_DECLARATION),
  skeleton: normalizeNewlines(CALCULATION_SOURCE_SKELETON),
}
