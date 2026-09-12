import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ExperimentCard, experimentPlaceholder } from './ExperimentCard'

const row = {
  id: 1,
  name: '한국어 제목',
  namespace: 'owner',
  repository_slug: 'hidden-repo',
  experiment_key: 'key',
  version_major: 1,
  version_minor: 0,
  version_patch: 0,
  source_bundle: { files: {} },
  source_hash: 'hash',
  thumbnail_url: '/test.webp',
}

it('fills a 4:3 card and replaces a broken thumbnail without selecting on action clicks', () => {
  const onSelect = vi.fn(),
    onEdit = vi.fn(),
    onVersions = vi.fn(),
    onDelete = vi.fn()
  const { container } = render(
    <ExperimentCard
      row={row}
      selected
      onSelect={onSelect}
      onEdit={onEdit}
      onVersions={onVersions}
      onDelete={onDelete}
    />,
  )
  expect(container.querySelector('article')).toHaveClass('aspect-[4/3]')
  const image = container.querySelector('img')!
  expect(image).toHaveAttribute('src', '/test.webp')
  fireEvent.error(image)
  expect(image).toHaveAttribute('src', experimentPlaceholder)
  expect(screen.queryByText('hidden-repo')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /편집/ }))
  fireEvent.click(screen.getByRole('button', { name: /버전 목록/ }))
  fireEvent.click(screen.getByRole('button', { name: /삭제/ }))
  expect(onEdit).toHaveBeenCalledOnce()
  expect(onVersions).toHaveBeenCalledOnce()
  expect(onDelete).toHaveBeenCalledOnce()
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /선택/ }))
  expect(onSelect).toHaveBeenCalledOnce()
})
