import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CalculationLogPanel } from './CalculationLogPanel'

it('shows read-only multiline logs, truncation and errors without a command input', () => {
  const { container } = render(
    <CalculationLogPanel
      logs={[
        { requestId: 'run', revision: 1, sourceHash: 'hash', sequence: 0, message: 'first\nsecond' },
        {
          requestId: 'run',
          revision: 1,
          sourceHash: 'hash',
          sequence: 1,
          message: '[Calculation console.log output truncated]',
        },
      ]}
      preview={{ status: 'error', code: 'runtime', message: 'Execution failed' }}
    />,
  )
  expect(container.querySelector('pre')?.textContent).toBe('first\nsecond')
  expect(screen.getByText(/출력 제한에 도달/)).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Execution failed')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
