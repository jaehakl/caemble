import type { MeasurementSession } from './useMeasurementSession'

const stateLabels = { candidate: '대기', running: '실행 중', failed: '실패', cancelled: '취소' }

export function MeasurementCandidateList({ session }: { session: MeasurementSession }) {
  if (!session.candidates.length) return null
  return (
    <section aria-label="저장 전 후보" className="max-h-[45%] shrink-0 overflow-auto border-b p-2 text-xs">
      <h3 className="mb-1 font-semibold">저장 전 후보 · {session.candidates.length}개</h3>
      <ul>
        {session.candidates.map((candidate, index) => (
          <li key={candidate.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded p-2 text-left hover:bg-muted aria-current:bg-accent"
              aria-label={`후보 ${index + 1} ${stateLabels[candidate.state]}`}
              disabled={session.selectionDisabled}
              aria-current={session.currentId === candidate.id ? 'true' : undefined}
              onClick={() => void session.selectPoint(candidate.id, false)}
              title={candidate.error}
            >
              <span>후보 {index + 1}</span>
              <span>{stateLabels[candidate.state]}</span>
            </button>
            {candidate.error ? <p className="px-2 text-destructive">{candidate.error}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
