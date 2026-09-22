import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { Save } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkbenchRibbon, WorkbenchRibbonAction, WorkbenchRibbonActions, WorkbenchRibbonGroup } from './WorkbenchRibbon'
import { WorkbenchMenubar } from './WorkbenchMenubar'

it('keeps large commands and compact stacks accessible and preserves disabled actions', () => {
  const save = vi.fn()
  const blocked = vi.fn()
  render(
    <TooltipProvider>
      <WorkbenchRibbon
        activeSectionId="experiment"
        panels={[
          {
            sectionId: 'experiment',
            label: 'Experiment',
            content: (
              <WorkbenchRibbonGroup label="File">
                <WorkbenchRibbonAction
                  size="large"
                  action={{ id: 'save', label: 'Save', icon: <Save />, onSelect: save }}
                />
                <WorkbenchRibbonActions
                  actions={[
                    { id: 'blocked', label: 'Save As', disabled: true, disabledReason: '읽기 전용', onSelect: blocked },
                  ]}
                />
              </WorkbenchRibbonGroup>
            ),
          },
        ]}
      />
    </TooltipProvider>,
  )
  expect(screen.getByRole('region', { name: 'Experiment 리본' })).toHaveClass('h-24', 'overflow-x-auto')
  const button = screen.getByRole('button', { name: 'Save' })
  expect(button).toHaveClass('h-[72px]')
  fireEvent.click(button)
  expect(save).toHaveBeenCalledOnce()
  const disabled = screen.getByRole('button', { name: 'Save As: 읽기 전용' })
  expect(disabled).toHaveClass('h-6')
  fireEvent.click(disabled)
  expect(blocked).not.toHaveBeenCalled()
})

it('retains arrow-key tab navigation in the compact menubar', () => {
  const change = vi.fn()
  render(<WorkbenchMenubar activeSectionId="experiment" onActiveSectionChange={change} />)
  expect(screen.getByRole('menubar')).toHaveClass('h-8')
  expect(screen.getAllByRole('menuitemradio').map((tab) => tab.textContent)).toEqual([
    '구성',
    '실행',
    '가공',
    '통계',
    '예측',
  ])
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: '구성' }), { key: 'ArrowRight' })
  expect(change).toHaveBeenCalledWith('measurement')
  expect(screen.getByRole('menuitemradio', { name: '실행' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: '가공' }), { key: 'ArrowRight' })
  expect(change).toHaveBeenLastCalledWith('analysis')
  expect(screen.getByRole('menuitemradio', { name: '통계' })).toHaveFocus()
})
