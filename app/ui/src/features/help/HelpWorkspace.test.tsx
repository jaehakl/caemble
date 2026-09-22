import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogApi } from '@/api/catalog'
import { helpHref } from '@/documentation/helpNavigation'
import { DocumentationPage } from '@/routes/DocumentationRoute'
import { publicDocuments } from '@/documentation/public'
import { HelpWorkspace } from './HelpWorkspace'

function Harness() {
  const location = useLocation(),
    navigate = useNavigate()
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
      <output aria-label="Address">{location.search}</output>
      <DocumentationPage />
    </>
  )
}
function mount(address = '/doc?help=home', previous?: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter initialEntries={previous ? [previous, address] : [address]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Help workspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(catalogApi, 'search').mockResolvedValue([])
  })
  it('opens a task guide, follows its heading and relative links, and supports history', async () => {
    mount()
    fireEvent.click(screen.getByRole('link', { name: '첫 실험 따라 하기' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'CAE Workbench 빠른 시작' })).toBeInTheDocument()
    const toc = within(screen.getAllByRole('navigation', { name: '문서 목차' })[0])
    fireEvent.click(toc.getByRole('link', { name: '먼저 준비할 것' }))
    expect(screen.getByLabelText('Address')).toHaveTextContent('anchor=')
    fireEvent.click(screen.getByRole('link', { name: 'Calculation으로 결과 계산' }))
    expect(await screen.findByRole('heading', { level: 1, name: /Calculation/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'CAE Workbench 빠른 시작' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    expect(await screen.findByRole('heading', { level: 1, name: /Calculation/ })).toBeInTheDocument()
  })
  it('debounces server search while keeping local results available after a server failure', async () => {
    vi.mocked(catalogApi.search).mockRejectedValue(new Error('Offline'))
    mount()
    const input = screen.getByRole('searchbox', { name: '사용 가이드 전체 검색' })
    fireEvent.change(input, { target: { value: 'Ready a' } })
    fireEvent.change(input, { target: { value: 'Ready' } })
    expect(catalogApi.search).not.toHaveBeenCalled()
    await waitFor(() => expect(catalogApi.search).toHaveBeenCalledOnce())
    expect(await screen.findByText(/카탈로그 검색을 불러오지 못했습니다/)).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('사용 가이드 본문')).getByRole('link', {
        name: new RegExp(
          publicDocuments.find((page) => page.id === 'troubleshooting-ready')!.title.replace(/[()]/g, '\\$&'),
        ),
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })
  it('shows an explicit missing-document state and a route back home', () => {
    mount('/doc?help=manual&item=missing')
    expect(screen.getByRole('heading', { name: '문서를 찾을 수 없습니다' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: '가이드 홈으로' }))
    expect(screen.getByRole('heading', { name: /첫 실험부터/ })).toBeInTheDocument()
  })

  it('opens a manual Catalog link through the Documentation route', () => {
    const onNavigate = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HelpWorkspace kind="manual" item="program-task" anchor={null} onNavigate={onNavigate} />
      </QueryClientProvider>,
    )
    const link = within(screen.getByRole('article'))
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === '/doc?help=solvers')!
    expect(link).toHaveAttribute('href', '/doc?help=solvers')
    fireEvent.click(link)
    expect(onNavigate).toHaveBeenCalledWith('/doc?help=solvers')
  })

  it('renders real Markdown URLs for normal and modified-click navigation', () => {
    mount('/doc?help=manual&item=workbench-quickstart')
    const link = screen.getByRole('link', { name: 'Calculation으로 결과 계산' })
    expect(link).toHaveAttribute('href', helpHref('manual', 'workbench-calculation'))
    // jsdom cannot open a new browser tab; prevent its native fallback after capture.
    link.addEventListener('click', (event) => event.preventDefault(), { once: true })
    fireEvent.click(link, { ctrlKey: true })
    expect(screen.getByLabelText('Address')).toHaveTextContent('item=workbench-quickstart')
  })

  it('replaces a moved heading address without adding a history entry', async () => {
    mount(helpHref('manual', 'workbench-quickstart', 'measurement-탭'), helpHref('home'))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Measurement에서 조건 만들고 실행하기' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Address')).toHaveTextContent('item=workbench-measurement')
    expect(screen.getByLabelText('Address')).toHaveTextContent('anchor=')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: /첫 실험부터/ })).toBeInTheDocument()
  })

  it('scrolls back to the same heading when its outline link is selected again', () => {
    mount(helpHref('manual', 'workbench-quickstart', '먼저-준비할-것'))
    const heading = screen.getByRole('heading', { name: '먼저 준비할 것' })
    heading.scrollIntoView = vi.fn()
    const outline = within(screen.getAllByRole('navigation', { name: '문서 목차' })[0])
    fireEvent.click(outline.getByRole('link', { name: '먼저 준비할 것' }))
    fireEvent.click(outline.getByRole('link', { name: '먼저 준비할 것' }))
    expect(heading.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(heading).toHaveFocus()
  })

  it('follows the reading order and clears search when navigating through history', async () => {
    mount('/doc?help=manual&item=workbench-quickstart')
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '이전·다음 문서' })).getByRole('link', { name: /다음 문서/ }),
    )
    expect(screen.getByLabelText('Address')).toHaveTextContent('item=workbench-authoring-cycle')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '변수' } })
    expect(screen.getByRole('heading', { name: /검색 결과/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'CAE Workbench 빠른 시작' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    expect(screen.getByLabelText('Address')).toHaveTextContent('item=workbench-authoring-cycle')
    expect(screen.queryByRole('heading', { name: /검색 결과/ })).not.toBeInTheDocument()
  })

  it('waits for catalog search before displaying an empty result and offers another query', async () => {
    let finish!: (value: never[]) => void
    vi.mocked(catalogApi.search).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mount()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-match-92753' } })
    await waitFor(() => expect(catalogApi.search).toHaveBeenCalledOnce())
    expect(within(screen.getByLabelText('사용 가이드 본문')).getByRole('status')).toHaveTextContent('찾고 있습니다')
    expect(screen.queryByText('일치하는 문서를 찾지 못했습니다')).not.toBeInTheDocument()
    await act(async () => finish([]))
    expect(await screen.findByText('일치하는 문서를 찾지 못했습니다')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    expect(screen.getByRole('searchbox')).toHaveValue('Ready')
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(screen.getByRole('heading', { name: /첫 실험부터/ })).toBeInTheDocument()
  })

  it('closes the mobile menu with Escape, restores focus, and navigates from its portal', async () => {
    const user = userEvent.setup()
    mount()
    const trigger = screen.getByRole('button', { name: '가이드 메뉴 열기' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '사용 가이드' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Showcase에서 예제 둘러보기' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 1, name: 'Showcase에서 예제 둘러보기' })).toBeInTheDocument()
  })
})
