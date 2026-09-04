import type { VarsSchemaEntry } from '@/lib/cad/model'
import { tensorElementCount } from '@/lib/cad/model/tensor'

export type TensorRectangle = Readonly<{
  rowStart: number
  rowEnd: number
  columnStart: number
  columnEnd: number
}>

export function clampVarsValue(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function varsBarIndex(position: number, width: number, count: number) {
  return Math.max(0, Math.min(count - 1, Math.floor((position / width) * count)))
}

export function varsValueFromVerticalPosition(position: number, height: number, minimum: number, maximum: number) {
  return clampVarsValue(minimum + (1 - position / height) * (maximum - minimum), minimum, maximum)
}

export function tensorCellFromPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  rows: number,
  columns: number,
) {
  return Object.freeze({
    row: Math.max(0, Math.min(rows - 1, Math.floor((y / height) * rows))),
    column: Math.max(0, Math.min(columns - 1, Math.floor((x / width) * columns))),
  })
}

export function varsWheelStep(entry: VarsSchemaEntry, shiftKey: boolean, altKey: boolean) {
  const modifier = shiftKey ? 10 : altKey ? 0.1 : 1
  return ((entry.max - entry.min) / 100) * modifier
}

export function rectangleFromCells(
  anchorRow: number,
  anchorColumn: number,
  row: number,
  column: number,
): TensorRectangle {
  return Object.freeze({
    rowStart: Math.min(anchorRow, row),
    rowEnd: Math.max(anchorRow, row),
    columnStart: Math.min(anchorColumn, column),
    columnEnd: Math.max(anchorColumn, column),
  })
}

export function updateTensorRectangle(
  values: readonly number[],
  rows: number,
  columns: number,
  sliceIndex: number,
  rectangle: TensorRectangle,
  update: (value: number) => number,
) {
  const next = [...values]
  const sliceOffset = sliceIndex * rows * columns
  for (let row = rectangle.rowStart; row <= rectangle.rowEnd; row += 1) {
    for (let column = rectangle.columnStart; column <= rectangle.columnEnd; column += 1) {
      const index = sliceOffset + row * columns + column
      next[index] = update(next[index])
    }
  }
  return next
}

export function updateTensorBrush(
  values: readonly number[],
  rows: number,
  columns: number,
  sliceIndex: number,
  from: Readonly<{ row: number; column: number }>,
  to: Readonly<{ row: number; column: number }>,
  radius: number,
  update: (value: number, index: number) => number,
) {
  const next = [...values]
  const rowDelta = to.row - from.row
  const columnDelta = to.column - from.column
  const pathSteps = Math.max(Math.abs(rowDelta), Math.abs(columnDelta))
  for (let step = 0; step <= pathSteps; step += 1) {
    const row = pathSteps === 0 ? from.row : Math.round(from.row + (rowDelta * step) / pathSteps)
    const column = pathSteps === 0 ? from.column : Math.round(from.column + (columnDelta * step) / pathSteps)
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      for (let columnOffset = -radius; columnOffset <= radius; columnOffset += 1) {
        if (rowOffset * rowOffset + columnOffset * columnOffset > radius * radius) continue
        const targetRow = row + rowOffset
        const targetColumn = column + columnOffset
        if (targetRow < 0 || targetRow >= rows || targetColumn < 0 || targetColumn >= columns) continue
        const index = sliceIndex * rows * columns + targetRow * columns + targetColumn
        next[index] = update(next[index], index)
      }
    }
  }
  return next
}

export function tensorSliceCount(shape: readonly number[]) {
  return shape.length <= 2 ? 1 : tensorElementCount(shape.slice(0, -2))
}

export function tensorSliceCoordinates(shape: readonly number[], sliceIndex: number) {
  const leadingShape = shape.slice(0, -2)
  const coordinates = Array(leadingShape.length).fill(0) as number[]
  let remaining = sliceIndex
  for (let index = leadingShape.length - 1; index >= 0; index -= 1) {
    coordinates[index] = remaining % leadingShape[index]
    remaining = Math.floor(remaining / leadingShape[index])
  }
  return coordinates
}
