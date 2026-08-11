// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'

function renderDialog(className?: string) {
  render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>테스트 모달</DialogTitle>
        <p>내용</p>
      </DialogContent>
    </Dialog>,
  )
  return screen.getByRole('dialog', { name: '테스트 모달' })
}

describe('DialogContent', () => {
  it('sizes the default dialog to its content within the viewport and desktop cap', () => {
    const dialog = renderDialog()

    expect(dialog).toHaveClass('w-fit', 'max-w-[calc(100%-2rem)]', 'sm:max-w-lg')
  })

  it('allows a wider responsive maximum without forcing that width', () => {
    const dialog = renderDialog('sm:max-w-3xl')

    expect(dialog).toHaveClass('w-fit', 'max-w-[calc(100%-2rem)]', 'sm:max-w-3xl')
    expect(dialog).not.toHaveClass('sm:max-w-lg')
  })

  it('allows workspace dialogs to retain the full viewport-relative width', () => {
    const dialog = renderDialog('w-[calc(100%-2rem)] sm:max-w-[calc(100%-2rem)]')

    expect(dialog).toHaveClass('w-[calc(100%-2rem)]', 'sm:max-w-[calc(100%-2rem)]')
    expect(dialog).not.toHaveClass('w-fit', 'sm:max-w-lg')
  })
})
