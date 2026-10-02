import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { predictionExecutionMetricsSchema, predictionQualityReportSchema } from '@/contracts/api/prediction'
import { PredictionModelReports } from './PredictionModelReports'
import { executionMetricsFixture, qualityReportFixture } from './qualityReport.fixture'

it('parses stored reports and rejects nonfinite error metrics at the API boundary', () => {
  expect(predictionQualityReportSchema.parse(qualityReportFixture)).toEqual(qualityReportFixture)
  expect(predictionExecutionMetricsSchema.parse(executionMetricsFixture)).toEqual(executionMetricsFixture)
  expect(
    predictionQualityReportSchema.safeParse({
      ...qualityReportFixture,
      records: [
        {
          ...qualityReportFixture.records[0],
          components: [{ component: 'scalar', mae: Infinity, rmse: 0, maxAbsoluteError: 0 }],
        },
      ],
    }).success,
  ).toBe(false)
})

it('distinguishes saved execution certification from held-out error and measured resources', () => {
  render(
    <PredictionModelReports
      artifact={{
        quality_report: qualityReportFixture,
        manifest_sha256: 'a'.repeat(64),
        validation: { version: 1, manifestChecksum: 'a'.repeat(64), loadPassed: true, predictPassed: true },
        training_metrics: executionMetricsFixture,
        execution_metrics: {
          ...executionMetricsFixture,
          peakRssBytes: null,
          rssStatus: 'unavailable',
          gpuStatus: 'unavailable',
        },
      }}
    />,
  )
  expect(screen.getByText('저장 모델의 다시 불러오기·예측 검증을 통과했습니다.')).toBeInTheDocument()
  expect(screen.getByText(/학습 4개 설계점 \/ 4개 Measurement/)).toHaveTextContent(
    '평가용 1개 설계점 / 1개 Measurement',
  )
  expect(screen.getByRole('columnheader', { name: 'MAE' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: '0.5' })).toBeInTheDocument()
  expect(screen.getByLabelText('학습·품질 평가 측정')).toHaveTextContent('8 MiB')
  expect(screen.getByLabelText('전체 학습 실행 측정')).toHaveTextContent('측정 불가')
  expect(screen.getByText(/자동 채택 기준으로 사용하지 않습니다/)).toBeInTheDocument()
})

it('shows partial outputs and reasons without inventing accuracy for unavailable records', () => {
  render(
    <PredictionModelReports
      artifact={{
        quality_report: {
          ...qualityReportFixture,
          status: 'partial',
          records: [
            {
              ...qualityReportFixture.records[0],
              status: 'unavailable',
              components: [],
              evaluatedMeasurementIds: [],
              evaluatedGroupCount: 0,
              excluded: [{ measurementId: 5, reason: 'incompatible-layout' }],
            },
          ],
        },
      }}
    />,
  )
  expect(screen.getByText('비교 가능한 평가 출력이 없습니다.')).toBeInTheDocument()
  expect(screen.getByText(/incompatible-layout/)).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

it('does not claim old artifacts have accuracy or execution certification', () => {
  render(<PredictionModelReports artifact={{ manifest_sha256: 'legacy' }} />)
  expect(screen.getByText('저장된 실행 검증 보고서가 없습니다.')).toBeInTheDocument()
  expect(screen.getByText(/품질 평가 보고서가 없습니다/)).toBeInTheDocument()
})
