import { Component, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'

class RenderLimitBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <div>Render loop</div> : this.props.children
  }
}

describe('DataTable updates', () => {
  it('settles after a parent update and data replacement, and selects the current row', async () => {
    let renders = 0
    const columns = [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ getValue }: { getValue: () => unknown }) => {
          if (++renders > 100) throw new Error('Unbounded table renders')
          return String(getValue())
        },
      },
    ]
    const onRowClick = vi.fn()
    const view = (data: { name: string }[], selectedKey?: string) => (
      <RenderLimitBoundary>
        <DataTable
          columns={columns}
          data={data}
          getRowKey={(row) => row.name}
          onRowClick={onRowClick}
          selectedKey={selectedKey}
        />
      </RenderLimitBoundary>
    )
    const rows = [{ name: 'first' }]
    const { rerender } = render(view(rows))
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument())
    rerender(view(rows, 'first'))
    rerender(view([{ name: 'updated' }]))
    await waitFor(() => expect(screen.getByText('updated')).toBeInTheDocument())
    fireEvent.click(screen.getByText('updated'))
    expect(onRowClick).toHaveBeenCalledWith({ name: 'updated' })
    expect(renders).toBeLessThan(20)
    expect(screen.queryByText('Render loop')).not.toBeInTheDocument()
  })
  it('does not emit a delayed single click after a double click', async () => {
    const single = vi.fn(),
      double = vi.fn()
    render(
      <DataTable
        columns={[{ accessorKey: 'name' }]}
        data={[{ name: 'row' }]}
        getRowKey={(row) => row.name}
        onRowClick={single}
        onRowDoubleClick={double}
      />,
    )
    fireEvent.click(screen.getByText('row'))
    fireEvent.doubleClick(screen.getByText('row'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(double).toHaveBeenCalledOnce()
    expect(single).not.toHaveBeenCalled()
  })
})
