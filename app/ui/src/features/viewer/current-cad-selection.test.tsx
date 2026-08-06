// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CurrentCadSelectionProvider, useCurrentCadSelection } from './current-cad-selection'

function SelectionProbe() {
  const { currentExperimentId, currentStructureId, setCurrentExperimentId, setCurrentStructureId } =
    useCurrentCadSelection()
  return (
    <>
      <output aria-label="현재 Structure">{currentStructureId ?? '없음'}</output>
      <output aria-label="현재 Experiment">{currentExperimentId ?? '없음'}</output>
      <button onClick={() => setCurrentStructureId(11)}>Structure 선택</button>
      <button onClick={() => setCurrentExperimentId(22)}>Experiment 선택</button>
      <button onClick={() => setCurrentStructureId(null)}>Structure 해제</button>
    </>
  )
}

describe('CurrentCadSelectionProvider', () => {
  it('shares and clears Structure and Experiment selections independently', () => {
    render(
      <CurrentCadSelectionProvider>
        <SelectionProbe />
      </CurrentCadSelectionProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Structure 선택' }))
    expect(screen.getByLabelText('현재 Structure')).toHaveTextContent('11')
    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('없음')

    fireEvent.click(screen.getByRole('button', { name: 'Experiment 선택' }))
    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('22')

    fireEvent.click(screen.getByRole('button', { name: 'Structure 해제' }))
    expect(screen.getByLabelText('현재 Structure')).toHaveTextContent('없음')
    expect(screen.getByLabelText('현재 Experiment')).toHaveTextContent('22')
  })
})
