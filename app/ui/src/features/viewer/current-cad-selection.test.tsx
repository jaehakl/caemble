// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CurrentCadSelectionProvider, useCurrentCadSelection } from './current-cad-selection'

function SelectionProbe() {
  const { currentExperimentId, setCurrentExperimentId } = useCurrentCadSelection()
  return (
    <>
      <output aria-label="현재 Experiment">{currentExperimentId ?? '없음'}</output>
      <button onClick={() => setCurrentExperimentId(22)}>Experiment 선택</button>
      <button onClick={() => setCurrentExperimentId(null)}>Experiment 해제</button>
    </>
  )
}

describe('CurrentCadSelectionProvider', () => {
  it('shares and clears the current Experiment selection', () => {
    render(
      <CurrentCadSelectionProvider>
        <SelectionProbe />
      </CurrentCadSelectionProvider>,
    )

    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('없음')

    fireEvent.click(screen.getByRole('button', { name: 'Experiment 선택' }))
    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('22')

    fireEvent.click(screen.getByRole('button', { name: 'Experiment 해제' }))
    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('없음')
  })
})
