/** Shared browser/CLI canonical sampling; preview geometry keeps its authored resolution. */
export type GeometryEvaluationProfile = Readonly<{
  kind: 'analysis'
  version: 1
  angularSegments: number
  pathSegments: number
}>

export const analysisGeometryProfile: GeometryEvaluationProfile = Object.freeze({
  kind: 'analysis',
  version: 1,
  angularSegments: 128,
  pathSegments: 512,
})
