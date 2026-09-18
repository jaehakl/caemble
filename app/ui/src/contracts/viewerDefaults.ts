import { z } from 'zod'

const index = z.number().int().nonnegative()
const axis = z.enum(['x', 'y', 'z', 'time', 'frequency'])
const component = z.union([index, z.enum(['magnitude', 'arrows'])])
const reduction = z.object({
  method: z.enum(['index', 'mean', 'sum', 'min', 'max', 'median', 'std']),
  index: index.optional(),
})

/** Only durable display controls are serialized; runtime busy/picking state stays local. */
export const viewerSettingSchemas: Record<string, z.ZodType> = {
  experimentVisible: z.boolean(),
  taskVisible: z.boolean(),
  xrayEnabled: z.boolean(),
  overlay: z.array(z.string()),
  'box.wavelength': z.boolean(),
  'box.kind': z.enum(['histogram', 'line', 'heatmap', 'cloud']),
  'box.axes': z.array(axis).max(3),
  'box.representation': z.enum(['amplitude', 'phase']),
  'box.component': component,
  'box.reduce': z.partialRecord(axis, reduction),
  'box.overlay': z.boolean(),
  'box.geometryOpacity': z.number().min(0).max(1),
  'box.bins': z.number().int().positive(),
  'box.animation': z.enum(['off', 'oscillation', 'time', 'frequency']),
  'box.timeSeconds': z.number().nonnegative(),
  'box.frameIndex': index,
  'box.durationSeconds': z.number().positive().nullable(),
  'box.playing': z.boolean(),
  'box.repeat': z.boolean(),
  'box.speed': z.number().positive(),
  'box.fixed': z
    .tuple([z.number(), z.number()])
    .refine(([min, max]) => min < max)
    .nullable(),
  'mesh.view': z.object({
    component: z.union([index, z.enum(['magnitude', 'vonMises', 'material'])]),
    wireframe: z.boolean(),
    overlays: z.boolean(),
    clipAxis: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]),
    clipFraction: z.number().min(0).max(1),
    deformationScale: z.number().nonnegative(),
    compareOriginal: z.boolean().optional(),
    referenceClip: z.boolean().optional(),
  }),
  'mesh.selectedDisplacement': z.string().nullable(),
  'mesh.deformed': z.boolean(),
  'mesh.scaleMode': z.enum(['auto', 'manual']),
  'mesh.manualScale': z.number().nonnegative(),
  'mesh.frequencyHz': z.number().nonnegative(),
  'mesh.phaseDegrees': z.number(),
  'mesh.frameIndex': index,
  'meshPlayback.playing': z.boolean(),
  'meshPlayback.repeat': z.boolean(),
  'meshPlayback.speed': z.number().positive(),
  'meshTransform.time': z.number(),
  'particles.time': z.number(),
  'particles.attribute': z.string(),
  'particles.component': z.union([index, z.literal('magnitude')]),
  'particles.id': index,
  'particles.pointSize': z.number().positive(),
  'particles.geometry': z.boolean(),
  'tensor.representation': z.enum(['abs', 're', 'im', 'arg']),
  'tensor.member': z.string(),
  'tensor.indices': z.record(z.string().regex(/^\d+$/), index),
  'tensor.axes': z.array(index).max(2).nullable(),
}

export const cameraPoseSchema = z
  .object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    up: z.tuple([z.number(), z.number(), z.number()]),
    fov: z.number().positive().lt(Math.PI),
  })
  .refine(({ position, target, up }) => {
    const d = position.map((value, i) => value - target[i])
    return [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]].some(Boolean)
  })

export const viewerDefaultsSchema = z.object({
  version: z.literal(1),
  selectedResult: z.string().max(512),
  settings: z.record(z.string(), z.unknown()),
  camera: cameraPoseSchema.nullable(),
})
export type ViewerDefaults = z.infer<typeof viewerDefaultsSchema>
export type ExperimentInitialView = ViewerDefaults & { measurementId: number }
export type ExperimentPresentationUpdate = { initialView?: ExperimentInitialView | null; thumbnail?: string }
export const experimentPresentationSchema = z.object({
  id: z.number().int().positive(),
  initial_measurement_id: z.number().int().positive().nullable(),
  viewer_defaults: viewerDefaultsSchema.nullable(),
  thumbnail_url: z.string().nullable(),
})
export type ExperimentPresentation = z.infer<typeof experimentPresentationSchema>

export function durableViewerSettings(entries: Iterable<[string, unknown]>) {
  const settings: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const separator = key.lastIndexOf(':')
    if (separator < 0) continue
    const name = key.slice(separator + 1)
    const workspace = ['experimentVisible', 'taskVisible', 'xrayEnabled'].includes(name)
    if ((key.slice(0, separator) === '@workspace') !== workspace) continue
    const parsed = viewerSettingSchemas[name]?.safeParse(value)
    if (parsed?.success) settings[key] = parsed.data
  }
  return settings
}
