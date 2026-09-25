import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ViewerDiagnostic, ViewerDiagnosticResult, ViewerDiagnostics } from './ViewerDiagnostics'
import { createRuntimeConsoleStore } from '@/features/runtime-console/store'
import { RuntimeConsoleView } from '@/features/runtime-console/RuntimeConsoleView'

it('records scene/chart diagnostics once, survives effect replay and reports a later recurrence', async () => {
  const onActivity = vi.fn()
  function View({ message }: { message?: string }) {
    return (
      <StrictMode>
        <ViewerDiagnostics onActivity={onActivity}>
          <ViewerDiagnosticResult.Provider value="detectorPower">
            <ViewerDiagnostic message={message} />
            <ViewerDiagnostic message={message} />
          </ViewerDiagnosticResult.Provider>
        </ViewerDiagnostics>
      </StrictMode>
    )
  }
  const view = render(<View message="Invalid tensor" />)
  view.rerender(<View message="Invalid tensor" />)
  expect(onActivity).toHaveBeenCalledTimes(1)
  expect(onActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      source: 'viewer',
      level: 'error',
      message: 'detectorPower: Invalid tensor',
    }),
  )
  expect(screen.queryByText(/Invalid tensor/)).not.toBeInTheDocument()
  await act(async () => view.rerender(<View />))
  view.rerender(<View message="Invalid tensor" />)
  expect(onActivity).toHaveBeenCalledTimes(2)
})

it('shows Viewer warnings in the app Console and does not reinsert them after clearing', () => {
  const store = createRuntimeConsoleStore()
  const content = (
    <>
      <ViewerDiagnostics onActivity={store.append}>
        <ViewerDiagnostic level="warning" result="@visualizations.trace.paths" message="Incompatible coordinates" />
      </ViewerDiagnostics>
      <RuntimeConsoleView store={store} />
    </>
  )
  const view = render(content)
  expect(store.getSnapshot().events).toHaveLength(1)
  expect(store.getSnapshot().events[0]).toMatchObject({ source: 'viewer', level: 'warning' })
  expect(screen.getByText('@visualizations.trace.paths: Incompatible coordinates')).toBeInTheDocument()
  act(() => store.clear())
  view.rerender(content)
  expect(store.getSnapshot().events).toHaveLength(0)
})

it('is silent without an app Console and preserves shared detail alerts outside Viewer', () => {
  const view = render(
    <ViewerDiagnostics>
      <ViewerDiagnostic message="Failure">
        <p>Shared alert</p>
      </ViewerDiagnostic>
    </ViewerDiagnostics>,
  )
  expect(screen.queryByText('Shared alert')).not.toBeInTheDocument()
  view.rerender(
    <ViewerDiagnostic message="Failure">
      <p>Shared alert</p>
    </ViewerDiagnostic>,
  )
  expect(screen.getByText('Shared alert')).toBeInTheDocument()
})
