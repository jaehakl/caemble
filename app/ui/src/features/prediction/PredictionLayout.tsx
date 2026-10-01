import { useState, type ReactNode } from 'react'
import { ResizableWorkbenchLayout } from '@/features/cae-workbench/chrome/ResizableWorkbenchLayout'
import { workbenchLayoutLimits } from '@/features/cae-workbench/types'

const limits = {
  ...workbenchLayoutLimits,
  appMinWidthPx: 900,
  leftMinWidthPx: 180,
  rightMinWidthPx: 180,
  viewerMinWidthPx: 520,
}

export function PredictionLayout({
  menubar,
  ribbon,
  execution,
  vars,
  viewer,
  calculations,
}: {
  menubar: ReactNode
  ribbon: ReactNode
  execution?: ReactNode
  vars: ReactNode
  viewer: ReactNode
  calculations: ReactNode
}) {
  const [left, setLeft] = useState(0.2)
  const [right, setRight] = useState(0.2)
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {menubar}
      {ribbon}
      {execution}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <ResizableWorkbenchLayout
          limits={limits}
          left={vars}
          leftLabel="예측 Vars"
          viewer={viewer}
          viewerLabel="예측과 실제 비교"
          right={calculations}
          rightLabel="Prediction 출력 및 선택적 분석"
          leftWidthRatio={left}
          rightWidthRatio={right}
          onLeftWidthRatioChange={setLeft}
          onRightWidthRatioChange={setRight}
        />
      </div>
    </div>
  )
}
