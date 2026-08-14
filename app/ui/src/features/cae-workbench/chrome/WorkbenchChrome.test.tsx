// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Beaker } from 'lucide-react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorDock, type EditorDockTab } from './EditorDock'
import { ResizableWorkbenchSplit } from './ResizableWorkbenchSplit'
import { WorkbenchMenubar } from './WorkbenchMenubar'
import { WorkbenchRibbon } from './WorkbenchRibbon'
import { WorkbenchShell } from './WorkbenchShell'
import { WorkbenchToolbar } from './WorkbenchToolbar'
import type { WorkbenchMenuDefinition } from './actions'

afterEach(cleanup)

describe('workbench action chrome', () => {
  it('uses the same action contract for menu and toolbar commands', async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    const blocked = vi.fn()
    const action = { id: 'run', label: '실행', icon: <Beaker />, onSelect: run }
    const disabledAction = {
      id: 'blocked',
      label: '측정',
      icon: <Beaker />,
      disabled: true,
      disabledReason: 'Prepared Measurement가 필요합니다.',
      onSelect: blocked,
    }
    const menus: readonly WorkbenchMenuDefinition[] = [
      {
        id: 'data',
        label: 'Data',
        items: [
          { type: 'action', action },
          { type: 'action', action: disabledAction },
        ],
      },
    ]

    render(
      <>
        <WorkbenchMenubar menus={menus} />
        <WorkbenchToolbar actions={[action, disabledAction]} />
      </>,
    )

    await user.click(screen.getByRole('menuitem', { name: 'Data' }))
    await user.click(screen.getByRole('menuitem', { name: '실행' }))
    await user.click(screen.getByRole('button', { name: '실행' }))
    const blockedButton = screen.getByRole('button', { name: /측정: Prepared Measurement가 필요합니다/ })
    await user.click(blockedButton)

    expect(run).toHaveBeenCalledTimes(2)
    expect(blocked).not.toHaveBeenCalled()
  })

  it('shows only the active tab ribbon', () => {
    const { rerender } = render(
      <WorkbenchRibbon
        activeTabId="experiment"
        panels={[
          { tabId: 'experiment', label: 'Experiment', content: <div>Experiment actions</div> },
          { tabId: 'recorded-data', label: 'RecordedData', content: <div>RecordedData actions</div> },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Experiment 리본' })).toHaveTextContent('Experiment actions')
    expect(screen.queryByText('RecordedData actions')).not.toBeInTheDocument()

    rerender(
      <WorkbenchRibbon
        activeTabId="recorded-data"
        panels={[
          { tabId: 'experiment', label: 'Experiment', content: <div>Experiment actions</div> },
          { tabId: 'recorded-data', label: 'RecordedData', content: <div>RecordedData actions</div> },
        ]}
      />,
    )
    expect(screen.getByRole('region', { name: 'RecordedData 리본' })).toHaveTextContent('RecordedData actions')
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

describe('responsive workbench layout', () => {
  it('resizes the desktop split with an accessible separator', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(
      <ResizableWorkbenchSplit
        editor={<div>Editor content</div>}
        onViewerPercentChange={changed}
        viewer={<div>Viewer content</div>}
      />,
    )

    const separator = screen.getByRole('separator', { name: 'Viewer와 Editor 크기 조절' })
    separator.focus()
    await user.keyboard('{ArrowRight}')
    expect(separator).toHaveAttribute('aria-valuenow', '52')
    expect(changed).toHaveBeenLastCalledWith(52)

    await user.keyboard('{Home}')
    expect(separator).toHaveAttribute('aria-valuenow', '25')
  })

  it('keeps the editor visible and opens the Viewer in a modal on a small screen', async () => {
    const user = userEvent.setup()
    render(
      <WorkbenchShell
        editor={<div>Editor content</div>}
        menubar={<div>Menubar</div>}
        ribbon={<div>Ribbon</div>}
        toolbar={<div>Toolbar</div>}
        viewer={<div>Viewer content</div>}
      />,
    )

    expect(screen.getByRole('region', { name: 'Editor' })).toHaveTextContent('Editor content')
    expect(screen.queryByText('Viewer content')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '3D Viewer' }))
    const dialog = screen.getByRole('dialog', { name: '3D Viewer' })
    expect(within(dialog).getByText('Viewer content')).toBeInTheDocument()
  })
})
