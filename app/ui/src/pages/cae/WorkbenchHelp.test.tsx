// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchHelpDetail, WorkbenchHelpExplorer } from './WorkbenchHelp'

const catalog = vi.hoisted(() => ({
  listSolvers: vi.fn(),
}))

vi.mock('@/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      listSolvers: catalog.listSolvers,
    },
  }
})

beforeEach(() => {
  catalog.listSolvers.mockRejectedValue(new Error('solver catalog unavailable'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Workbench Help', () => {
  it('ignores a retained inactive catalog error when switching to the Manual list', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onSelectedItemChange = vi.fn()
    const view = render(
      <QueryClientProvider client={queryClient}>
        <WorkbenchHelpExplorer kind="solvers" onSelectedItemChange={onSelectedItemChange} selectedItem={null} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('목록을 불러오지 못했습니다.')).toBeInTheDocument()

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkbenchHelpExplorer kind="manual" onSelectedItemChange={onSelectedItemChange} selectedItem={null} />
      </QueryClientProvider>,
    )

    expect(screen.queryByText('목록을 불러오지 못했습니다.')).not.toBeInTheDocument()
    const quickstart = await screen.findByRole('button', { name: /CAE Workbench 빠른 시작/ })
    expect(quickstart).toHaveTextContent('Experiment candidate를 준비하고 Measurement로 고정한 뒤 실행')
    await userEvent.click(quickstart)
    expect(onSelectedItemChange).toHaveBeenCalledWith('workbench-quickstart')
    await waitFor(() => expect(catalog.listSolvers).toHaveBeenCalledOnce())
  })

  it('renders the selected Manual article instead of querying a catalog detail', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkbenchHelpDetail kind="manual" selectedItem="workbench-quickstart" />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('heading', { name: 'CAE Workbench 빠른 시작' })).toBeInTheDocument()
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName === 'LI' &&
          element.textContent?.includes('상단 Experiment 메뉴를 선택하고 왼쪽 목록에서 Example'),
        ),
      ),
    ).toBeInTheDocument()
    expect(catalog.listSolvers).not.toHaveBeenCalled()
  })
})
