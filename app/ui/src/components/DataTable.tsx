import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { useEffect, useRef } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export function DataTable<T>({
  columns,
  data,
  emptyLabel = '조건에 맞는 항목이 없습니다.',
  getRowKey,
  onRowClick,
  onRowDoubleClick,
  selectedKey,
}: {
  columns: ColumnDef<T, unknown>[]
  data: T[]
  emptyLabel?: string
  getRowKey: (row: T) => string
  onRowClick?: (row: T) => void
  onRowDoubleClick?: (row: T) => void
  selectedKey?: string
}) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })

  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    },
    [],
  )

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length ? (
          table.getRowModel().rows.map((row) => {
            const key = getRowKey(row.original)
            return (
              <TableRow
                aria-selected={key === selectedKey}
                className={cn(
                  (onRowClick || onRowDoubleClick) && 'cursor-pointer',
                  key === selectedKey && 'bg-orange-50 hover:bg-orange-50',
                )}
                key={key}
                onClick={() => {
                  if (!onRowDoubleClick) {
                    onRowClick?.(row.original)
                    return
                  }
                  if (clickTimer.current) clearTimeout(clickTimer.current)
                  clickTimer.current = setTimeout(() => {
                    clickTimer.current = null
                    onRowClick?.(row.original)
                  }, 250)
                }}
                onDoubleClick={() => {
                  if (clickTimer.current) {
                    clearTimeout(clickTimer.current)
                    clickTimer.current = null
                  }
                  onRowDoubleClick?.(row.original)
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            )
          })
        ) : (
          <TableRow>
            <TableCell className="h-28 text-center text-muted-foreground" colSpan={columns.length}>
              {emptyLabel}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
