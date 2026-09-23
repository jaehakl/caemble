import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { WorkbenchViewer } from '../src/features/cae-workbench/viewer/WorkbenchViewer'
import { viewerDisplayFixture, stressViewerFixture } from '../src/features/cae-workbench/viewer/viewerDisplay.fixture'
import '../src/index.css'

const fixture = viewerDisplayFixture()
function Fixture() {
  const [missing, setMissing] = useState(false)
  const [stress, setStress] = useState(false)
  const [amount, setAmount] = useState(0.1)
  return (
    <div className="flex h-screen flex-col">
      <header className="flex gap-3 border-b p-2">
        <strong>Viewer display fixture</strong>
        <button onClick={() => setMissing(!missing)}>mesh-field 데이터 교체</button>
        <button onClick={() => setStress(!stress)}>응력·변위 검증</button>
        {stress ? (
          <button onClick={() => setAmount(amount === 0.1 ? 0.4 : 0.1)}>변위 데이터 갱신 · {amount}</button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">
        {stress ? (
          <WorkbenchViewer key="stress" {...stressViewerFixture(amount)} />
        ) : (
          <WorkbenchViewer
            {...fixture}
            visualizations={
              missing ? { sample: { rays: fixture.visualizations!.sample.rays } } : fixture.visualizations
            }
          />
        )}
      </div>
    </div>
  )
}
const root = createRoot(document.getElementById('fixture')!)
root.render(<Fixture />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
