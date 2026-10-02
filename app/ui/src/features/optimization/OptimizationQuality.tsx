import type { OptimizationQualityAssessment } from '@/contracts/api/optimization'

const statuses = { passed: '통과', failed: '실패', unassessed: '미평가' }
const reasons: Record<string, string> = {
  'requirements-not-configured': '품질 미확인 · 품질 조건을 지정하지 않았습니다.',
  'report-unavailable': '품질 보고서가 없습니다.',
  'record-unavailable': '평가된 Record가 없습니다.',
  'component-unavailable': '평가된 성분이 없습니다.',
  'invalid-rmse': '유효한 RMSE가 없습니다.',
  'rmse-exceeded': 'RMSE 상한을 초과했습니다.',
  'within-limit': 'RMSE 상한을 충족했습니다.',
  'requirements-unassessed': '필요한 출력을 평가하지 못했습니다.',
  'requirements-failed': '품질 조건을 충족하지 못했습니다.',
  'requirements-passed': '모든 품질 조건을 충족했습니다.',
}

export function OptimizationQuality({
  assessment,
  label,
}: {
  assessment?: OptimizationQualityAssessment
  label: string
}) {
  return (
    <div aria-label={label} className="mt-2 space-y-1 text-xs">
      <p className="font-medium">품질 판정: {assessment ? statuses[assessment.status] : '미평가'}</p>
      <p className="text-muted-foreground">
        {assessment
          ? (reasons[assessment.reasonCode] ?? assessment.reasonCode)
          : '품질 미확인 · 이 실행에는 저장된 품질 판정이 없습니다.'}
      </p>
      {assessment?.items.map((item) => (
        <p key={`${item.recordId}:${item.component}`}>
          Record {item.recordId} · {item.component}: {statuses[item.status]} · RMSE {item.rmse ?? '미평가'} / 상한{' '}
          {item.rmseMaximum}
          {item.unit ? ` ${item.unit}` : ''} · {reasons[item.reasonCode] ?? item.reasonCode}
        </p>
      ))}
    </div>
  )
}
