import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'
import { server } from './server'

function HealthProbe() {
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    void fetch('http://localhost/api/tooling-health')
      .then((response) => response.json() as Promise<{ status: string }>)
      .then((payload) => setStatus(payload.status))
  }, [])

  return <output aria-label="health status">{status}</output>
}

describe('UI test tooling', () => {
  it('renders a component and resolves an MSW-backed request', async () => {
    server.use(http.get('http://localhost/api/tooling-health', () => HttpResponse.json({ status: 'ready' })))

    render(<HealthProbe />)

    expect(screen.getByLabelText('health status')).toHaveTextContent('loading')
    expect(await screen.findByText('ready')).toBeInTheDocument()
  })

  it('can exercise a product utility', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })
})
