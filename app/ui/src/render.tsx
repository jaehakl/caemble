import { createRoot } from 'react-dom/client'
import { CadViewer } from '@/features/viewer/viewer/CadViewer'
import { CalculationOutputChart } from '@/features/calculation/CalculationOutputChart'
import { renderCanonicalGeometryScene } from '@/lib/cad/execution/manifoldRender'
import { deserializeCadScene } from '@/lib/cad/execution/mesh'
import type { BuiltArtifactInput } from '@/lib/cae/artifact'
import type { NormalizedCalculationOutput } from '@/lib/calculation/types'
import './index.css'

declare global {
  interface Window {
    caembleRender: (
      payload:
        | { kind: 'geometry'; input: BuiltArtifactInput; task?: string }
        | { kind: 'calculation'; output: NormalizedCalculationOutput },
    ) => Promise<void>
    caembleRenderState: { ready: boolean; error?: string }
  }
}
const root = createRoot(document.getElementById('root')!)
document.documentElement.style.height = '100%'
document.body.style.cssText = 'margin:0;height:100vh;background:white'
document.getElementById('root')!.style.height = '100%'
window.caembleRenderState = { ready: false }
const finish = () => {
  void document.fonts.ready.then(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.caembleRenderState = { ready: true }
      }),
    ),
  )
}
window.caembleRender = async (payload) => {
  window.caembleRenderState = { ready: false }
  try {
    if (payload.kind === 'calculation') {
      root.render(
        <div className="h-full p-6">
          <CalculationOutputChart preview={{ status: 'success', output: payload.output }} />
        </div>,
      )
      finish()
      return
    }
    const snapshot = payload.input.measurement.experiment
    const scene = payload.task ? snapshot.taskScenes[payload.task] : snapshot.scene
    const presentation = payload.task
      ? payload.input.presentation?.tasks[payload.task]
      : payload.input.presentation?.experiment
    if (!scene || !presentation)
      throw new Error('Saved canonical geometry and presentation are required for PNG export.')
    const serialized = await renderCanonicalGeometryScene(scene, {
      tree: presentation.tree,
      parts: presentation.materials,
    })
    if (!serialized.parts.length) throw new Error('The selected geometry has no visible parts.')
    root.render(
      <CadViewer
        experiment={{ scene: deserializeCadScene(serialized), sceneHash: serialized.sceneHash }}
        onRenderStart={() => {
          window.caembleRenderState = { ready: false }
        }}
        onRenderEnd={finish}
        onRenderError={(error) => {
          window.caembleRenderState = { ready: false, error }
        }}
      />,
    )
  } catch (error) {
    window.caembleRenderState = { ready: false, error: error instanceof Error ? error.message : String(error) }
  }
}
