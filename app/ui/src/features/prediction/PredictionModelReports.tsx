import type { PredictionExecutionMetrics, PredictionModelRecord } from '@/contracts/api/prediction'

const numberFormat = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 5 })

export function PredictionModelReports({
  artifact,
}: Readonly<{ artifact: PredictionModelRecord['revisions'][number]['artifact'] }>) {
  const quality = artifact?.quality_report
  const validation = artifact?.validation
  return (
    <div className="space-y-3 text-xs">
      <section className="space-y-1 rounded border p-2" aria-label="모델 실행 검증">
        <h4 className="font-medium">실행 검증</h4>
        <p>
          {validation?.version === 1 &&
          validation?.manifestChecksum === artifact?.manifest_sha256 &&
          validation?.loadPassed === true &&
          validation?.predictPassed === true
            ? '저장 모델의 다시 불러오기·예측 검증을 통과했습니다.'
            : '저장된 실행 검증 보고서가 없습니다.'}
        </p>
      </section>
      <section className="space-y-2 rounded border p-2" aria-label="모델 품질 보고서">
        <h4 className="font-medium">미학습 설계점 품질 평가</h4>
        {quality ? (
          <>
            <p>
              학습 {quality.split.trainingGroupCount}개 설계점 / {quality.split.trainingMeasurementIds.length}개
              Measurement · 평가용 {quality.split.validationGroupCount}개 설계점 /{' '}
              {quality.split.validationMeasurementIds.length}개 Measurement
            </p>
            <p className="text-muted-foreground">
              저장 직전 모델로 평가했습니다. 평가용 설계점은 학습에서 제외했으며, 이 보고서는 모델의 자동 채택 기준으로
              사용하지 않습니다.
            </p>
            {quality.status === 'partial' && <p>일부 출력 또는 평가 표본을 비교할 수 없습니다.</p>}
            {quality.split.excluded.length > 0 && (
              <p>
                분리에서 제외된 Measurement:{' '}
                {quality.split.excluded.map((item) => `#${item.measurementId} (${item.reason})`).join(', ')}
              </p>
            )}
            {quality.records.map((record) => (
              <div className="space-y-1 border-t pt-2" key={`${record.recordId}:${record.key}`}>
                <p className="font-medium">
                  {record.key} · Record {record.recordId}
                  {record.unit ? ` · ${record.unit}` : ''}
                </p>
                {record.status === 'evaluated' ? (
                  <>
                    <p>
                      학습 {record.trainingMeasurementIds.length}개 Measurement · 평가 {record.evaluatedGroupCount}개
                      설계점 / {record.evaluatedMeasurementIds.length}개 Measurement
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-right">
                        <thead>
                          <tr>
                            <th className="py-1 text-left">성분</th>
                            <th className="px-2">MAE</th>
                            <th className="px-2">RMSE</th>
                            <th className="pl-2">최대 절대 오차</th>
                          </tr>
                        </thead>
                        <tbody>
                          {record.components.map((component) => (
                            <tr key={component.component}>
                              <td className="py-1 text-left">{component.component}</td>
                              <td className="px-2">{numberFormat.format(component.mae)}</td>
                              <td className="px-2">{numberFormat.format(component.rmse)}</td>
                              <td className="pl-2">{numberFormat.format(component.maxAbsoluteError)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p>비교 가능한 평가 출력이 없습니다.</p>
                )}
                {record.excluded.length > 0 && (
                  <p className="text-muted-foreground">
                    제외된 Measurement:{' '}
                    {record.excluded.map((item) => `#${item.measurementId} (${item.reason})`).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </>
        ) : (
          <p className="text-muted-foreground">
            품질 평가 보고서가 없습니다. 새 모델을 만들 때 평가를 선택할 수 있습니다.
          </p>
        )}
      </section>
      {artifact?.training_metrics && (
        <ExecutionMetrics title="학습·품질 평가 측정" metrics={artifact.training_metrics} />
      )}
      {artifact?.execution_metrics && (
        <ExecutionMetrics title="전체 학습 실행 측정" metrics={artifact.execution_metrics} />
      )}
    </div>
  )
}

function ExecutionMetrics({ title, metrics }: Readonly<{ title: string; metrics: PredictionExecutionMetrics }>) {
  return (
    <section className="space-y-1 rounded border p-2" aria-label={title}>
      <h4 className="font-medium">{title}</h4>
      <p>
        경과 {numberFormat.format(metrics.elapsedSeconds)}초 · 프로세스 트리 최대 메모리{' '}
        {metrics.rssStatus === 'measured' && metrics.peakRssBytes !== null
          ? `${numberFormat.format(metrics.peakRssBytes / 1024 ** 2)} MiB`
          : '측정 불가'}
      </p>
      <p>
        GPU 메모리:{' '}
        {metrics.gpuStatus === 'not-requested'
          ? 'GPU 미요청'
          : metrics.gpuStatus === 'unavailable'
            ? '측정 불가'
            : Object.entries(metrics.peakVramBytes)
                .map(
                  ([device, bytes]) =>
                    `${device}: ${bytes === null ? '측정 불가' : `${numberFormat.format(bytes / 1024 ** 2)} MiB`}`,
                )
                .join(' · ')}
      </p>
      {metrics.phases && Object.entries(metrics.phases).length > 0 && (
        <details>
          <summary className="cursor-pointer">단계별 시간</summary>
          <ul className="mt-1 space-y-1">
            {Object.entries(metrics.phases).map(([phase, seconds]) => (
              <li key={phase}>
                {phase}: {numberFormat.format(seconds)}초
              </li>
            ))}
          </ul>
        </details>
      )}
      {metrics.warnings.map((warning, index) => (
        <p className="text-muted-foreground" key={index}>
          {warning}
        </p>
      ))}
    </section>
  )
}
