// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Beaker } from 'lucide-react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BottomDockMode, WorkbenchSectionId } from '../types'
import { EditorDock, type EditorDockTab } from './EditorDock'
import { WorkbenchBottomDock } from './WorkbenchBottomDock'
import { WorkbenchMenubar } from './WorkbenchMenubar'
import { WorkbenchRibbon, WorkbenchRibbonActions, WorkbenchRibbonGroup } from './WorkbenchRibbon'
import { WorkbenchShell } from './WorkbenchShell'

afterEach(cleanup)

describe('workbench action chrome', () => {
  it('shows seven top-level categories without opening dropdown menus', async () => {
    const user = userEvent.setup()

    function MenubarHarness() {
      const [activeSection, setActiveSection] = useState<WorkbenchSectionId>('experiment')
      return <WorkbenchMenubar activeSectionId={activeSection} onActiveSectionChange={setActiveSection} />
    }

    render(<MenubarHarness />)

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitemradio', { name: 'Measurement' }))
    expect(screen.getByRole('menuitemradio', { name: 'Measurement' })).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('menuitemradio', { name: 'Material' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows large contextual actions only for the active section', async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    const blocked = vi.fn()
    const panels = [
      {
        sectionId: 'experiment' as const,
        label: 'Experiment',
        content: (
          <WorkbenchRibbonGroup label="실행">
            <WorkbenchRibbonActions
              actions={[
                { id: 'run', label: '실행', icon: <Beaker />, onSelect: run },
                {
                  id: 'blocked',
                  label: '측정',
                  icon: <Beaker />,
                  disabled: true,
                  disabledReason: 'Prepared Measurement가 필요합니다.',
                  onSelect: blocked,
                },
              ]}
            />
          </WorkbenchRibbonGroup>
        ),
      },
      {
        sectionId: 'measurement' as const,
        label: 'Measurement',
        content: <div>Measurement actions</div>,
      },
    ]
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <WorkbenchRibbon activeSectionId="experiment" panels={panels} />
      </TooltipProvider>,
    )

    const runButton = screen.getByRole('button', { name: '실행' })
    expect(runButton).toHaveClass('h-[68px]')
    await user.click(runButton)
    await user.click(screen.getByRole('button', { name: /측정: Prepared Measurement가 필요합니다/ }))
    expect(run).toHaveBeenCalledOnce()
    expect(blocked).not.toHaveBeenCalled()
    expect(screen.queryByText('Measurement actions')).not.toBeInTheDocument()

    rerender(
      <TooltipProvider delayDuration={0}>
        <WorkbenchRibbon activeSectionId="measurement" panels={panels} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('region', { name: 'Measurement 리본' })).toHaveTextContent('Measurement actions')
    expect(screen.queryByRole('button', { name: '실행' })).not.toBeInTheDocument()
  })
})

describe('EditorDock', () => {
  it('activates, closes, and keyboard-reorders tabs', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    const initialTabs: readonly EditorDockTab[] = [
      { id: 'experiment', label: 'Experiment', content: <div>Experiment editor</div> },
      { id: 'recorded-data', label: 'RecordedData', content: <div>Recorded data</div> },
      { id: 'notes', label: 'Notes', content: <div>Notes editor</div> },
    ]

    function DockHarness() {
      const [tabs, setTabs] = useState(initialTabs)
      const [activeTab, setActiveTab] = useState('experiment')
      return (
        <EditorDock
          activeTabId={activeTab}
          onActiveTabChange={setActiveTab}
          onTabClose={close}
          onTabsReorder={(ids) => setTabs(ids.map((id) => initialTabs.find((tab) => tab.id === id)!))}
          tabs={tabs}
        />
      )
    }

    render(<DockHarness />)
    await user.click(screen.getByRole('tab', { name: 'Experiment' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Experiment editor')

    const experimentTab = screen.getByRole('tab', { name: 'Experiment' })
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'RecordedData' })).toHaveAttribute('aria-selected', 'true')
    expect(experimentTab).toHaveAttribute('aria-selected', 'false')

    const moveExperiment = screen.getByRole('button', { name: 'Experiment 탭 이동' })
    moveExperiment.focus()
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['RecordedData', 'Experiment', 'Notes'])

    await user.click(screen.getByRole('button', { name: 'Experiment 탭 닫기' }))
    expect(close).toHaveBeenCalledWith('experiment')
  })

  it('keeps an inactive AI panel mounted and cleans it up only when its tab closes', async () => {
    const user = userEvent.setup()
    const cleanupPanel = vi.fn()

    function StatefulAiPanel() {
      const [messages, setMessages] = useState(0)
      useEffect(() => cleanupPanel, [])
      return <button onClick={() => setMessages((count) => count + 1)}>AI messages {messages}</button>
    }

    function DockHarness() {
      const [tabs, setTabs] = useState<readonly EditorDockTab[]>(() => [
        { id: 'experiment', label: 'Experiment', content: <div>Experiment editor</div> },
        { id: 'ai-helper', label: 'AI Helper', content: <StatefulAiPanel /> },
      ])
      const [activeTab, setActiveTab] = useState('ai-helper')
      return (
        <EditorDock
          activeTabId={activeTab}
          onActiveTabChange={setActiveTab}
          onTabClose={(id) => {
            setTabs((current) => current.filter((tab) => tab.id !== id))
            if (activeTab === id) setActiveTab('experiment')
          }}
          onTabsReorder={(ids) => setTabs((current) => ids.map((id) => current.find((tab) => tab.id === id)!))}
          tabs={tabs}
        />
      )
    }

    render(<DockHarness />)
    await user.click(screen.getByRole('button', { name: 'AI messages 0' }))
    await user.click(screen.getByRole('tab', { name: 'Experiment' }))
    expect(cleanupPanel).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'AI Helper' }))
    expect(screen.getByRole('button', { name: 'AI messages 1' })).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Experiment' }))
    await user.click(screen.getByRole('button', { name: 'AI Helper 탭 닫기' }))
    expect(cleanupPanel).toHaveBeenCalledOnce()
  })
})

describe('fixed desktop workbench layout', () => {
  it('keeps three panes visible and keyboard-resizes every open split', async () => {
    const user = userEvent.setup()

    function LayoutHarness() {
      const [leftWidth, setLeftWidth] = useState(280)
      const [rightWidth, setRightWidth] = useState(420)
      const [bottomHeight, setBottomHeight] = useState(220)
      return (
        <WorkbenchShell
          bottom={<div>Bottom content</div>}
          bottomHeightPx={bottomHeight}
          bottomMode="console"
          left={<div>Experiment list</div>}
          leftWidthPx={leftWidth}
          menubar={<div>Menubar</div>}
          onBottomHeightChange={setBottomHeight}
          onLeftWidthChange={setLeftWidth}
          onRightWidthChange={setRightWidth}
          ribbon={<div>Ribbon</div>}
          right={<div>Experiment detail</div>}
          rightWidthPx={rightWidth}
          viewer={<div>Viewer content</div>}
        />
      )
    }

    const { container } = render(<LayoutHarness />)
    expect(screen.getByRole('region', { name: '목록' })).toHaveTextContent('Experiment list')
    expect(screen.getByRole('region', { name: '3D CAD View' })).toHaveTextContent('Viewer content')
    expect(screen.getByRole('region', { name: 'Detail' })).toHaveTextContent('Experiment detail')
    expect(container.firstElementChild).toHaveStyle({ minWidth: '1280px' })

    const leftSeparator = screen.getByRole('separator', { name: '왼쪽 목록 너비 조절' })
    leftSeparator.focus()
    await user.keyboard('{ArrowRight}')
    expect(leftSeparator).toHaveAttribute('aria-valuenow', '296')

    const rightSeparator = screen.getByRole('separator', { name: '오른쪽 Detail 너비 조절' })
    rightSeparator.focus()
    await user.keyboard('{ArrowLeft}')
    expect(rightSeparator).toHaveAttribute('aria-valuenow', '436')

    const bottomSeparator = screen.getByRole('separator', { name: '3D CAD View와 하단 도크 높이 조절' })
    bottomSeparator.focus()
    await user.keyboard('{ArrowUp}')
    expect(bottomSeparator).toHaveAttribute('aria-valuenow', '236')
  })

  it('keeps the AI Agent mounted while switching or hiding the center-only dock', async () => {
    const user = userEvent.setup()
    const cleanupAgent = vi.fn()

    function Agent() {
      const [messages, setMessages] = useState(0)
      useEffect(() => cleanupAgent, [])
      return <button onClick={() => setMessages((count) => count + 1)}>Agent messages {messages}</button>
    }

    function DockHarness() {
      const [mode, setMode] = useState<BottomDockMode>('hidden')
      return (
        <WorkbenchShell
          bottom={
            <WorkbenchBottomDock
              agent={<Agent />}
              console={<div>Session console</div>}
              mode={mode}
              onModeChange={setMode}
            />
          }
          bottomMode={mode}
          left={<div>Left pane</div>}
          menubar={<div>Menubar</div>}
          ribbon={<div>Ribbon</div>}
          right={<div>Right pane</div>}
          viewer={<div>Viewer</div>}
        />
      )
    }

    render(<DockHarness />)
    const dock = screen.getByRole('region', { name: '중앙 하단 도크' })
    expect(screen.queryByRole('separator', { name: '3D CAD View와 하단 도크 높이 조절' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '목록' })).not.toContainElement(dock)
    expect(screen.getByRole('region', { name: 'Detail' })).not.toContainElement(dock)

    const agentTab = screen.getByRole('tab', { name: 'AI Agent' })
    expect(agentTab).toHaveAttribute('tabindex', '0')
    agentTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'true')

    await user.click(agentTab)
    await user.click(screen.getByRole('button', { name: 'Agent messages 0' }))
    await user.click(screen.getByRole('tab', { name: 'Console' }))
    expect(cleanupAgent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'AI Agent' }))
    expect(screen.getByRole('button', { name: 'Agent messages 1' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '하단 도크 숨기기' }))
    expect(cleanupAgent).not.toHaveBeenCalled()
  })
})
