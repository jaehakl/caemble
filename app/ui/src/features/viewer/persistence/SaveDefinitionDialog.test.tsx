// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveDefinitionDialog, type ExperimentSaveMode } from './SaveDefinitionDialog'

afterEach(cleanup)

const defaults = {
  namespace: 'alpha-space',
  repository: 'examples',
  key: 'beam',
  name: 'Beam',
  description: '',
  bump: 'patch' as const,
}

describe('SaveDefinitionDialog', () => {
  it.each<ExperimentSaveMode>(['create', 'overwrite', 'new_version'])(
    'shows editable Experiment identity fields in %s mode',
    (mode) => {
      render(
        <SaveDefinitionDialog
          defaults={defaults}
          mode={mode}
          namespaceOptions={['alpha-space', 'beta-space']}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          open
          pending={false}
        />,
      )

      const namespace = screen.getByRole('combobox', { name: 'Namespace' })
      expect(namespace).toHaveValue('alpha-space')
      expect(namespace).toHaveAttribute('list')
      expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('examples')
      expect(screen.getByRole('textbox', { name: 'Experiment key' })).toHaveValue('beam')
      const list = document.getElementById(namespace.getAttribute('list')!)
      expect(Array.from(list?.querySelectorAll('option') ?? []).map((option) => option.value)).toEqual([
        'alpha-space',
        'beta-space',
      ])
      if (mode === 'create') {
        expect(screen.queryByText(/모든 Version에 적용됩니다/)).not.toBeInTheDocument()
      } else {
        expect(screen.getByText(/모든 Version에 적용됩니다/)).toBeVisible()
      }
    },
  )

  it('validates namespace and submits all identity fields', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => undefined)
    render(
      <SaveDefinitionDialog
        defaults={defaults}
        mode="overwrite"
        namespaceOptions={['alpha-space']}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        open
        pending={false}
      />,
    )

    const namespace = screen.getByRole('combobox', { name: 'Namespace' })
    await user.clear(namespace)
    await user.type(namespace, 'caemble')
    await user.click(screen.getByRole('button', { name: '정의 저장' }))
    expect(await screen.findByText('caemble Namespace는 Example 전용입니다.')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.clear(namespace)
    await user.type(namespace, 'beta-space')
    await user.click(screen.getByRole('button', { name: '정의 저장' }))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'beta-space', repository: 'examples', key: 'beam' }),
        expect.anything(),
      ),
    )
  })
})
