import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogApi } from '@/api/catalog'
import { readHelpLocation } from '@/documentation/helpNavigation'
import { HelpWorkspace } from './HelpWorkspace'

function Harness() {
  const location = useLocation(),
    navigate = useNavigate()
  const help = readHelpLocation(location.search)!
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
      <output aria-label="Address">{location.search}</output>
      <HelpWorkspace {...help} onNavigate={(href) => navigate(href)} onClose={() => navigate('/?help=home')} />
    </>
  )
}
function mount(address = '/?help=home') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter initialEntries={[address]}>
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
    fireEvent.click(screen.getByRole('link', { name: /01.*시작하기/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'CAE Workbench 빠른 시작' })).toBeInTheDocument()
    const toc = within(screen.getByRole('navigation', { name: '문서 목차' }))
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
    const input = screen.getByRole('searchbox', { name: 'Help 전체 검색' })
    fireEvent.change(input, { target: { value: 'Ready a' } })
    fireEvent.change(input, { target: { value: 'Ready' } })
    expect(catalogApi.search).not.toHaveBeenCalled()
    await waitFor(() => expect(catalogApi.search).toHaveBeenCalledOnce())
    expect(await screen.findByText(/카탈로그 검색을 불러오지 못했습니다/)).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('Help 본문')).getByRole('link', { name: /문서가 Ready가 되지 않을 때/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })
  it('shows an explicit missing-document state and a route back home', () => {
    mount('/?help=manual&item=missing')
    expect(screen.getByRole('heading', { name: '문서를 찾을 수 없습니다' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Help 홈으로' }))
    expect(screen.getByRole('heading', { name: '하고 싶은 작업에서 시작하세요' })).toBeInTheDocument()
  })
})
