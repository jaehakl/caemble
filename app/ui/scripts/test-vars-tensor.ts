import assert from 'node:assert/strict'
import {
  clampVarsValue,
  flattenVarsTensor,
  rectangleFromCells,
  tensorCellFromPoint,
  tensorElementCount,
  tensorSliceCoordinates,
  tensorSliceCount,
  updateTensorRectangle,
  varsBarIndex,
  validateVarsTensor,
  varsTensorFromFlat,
  varsValueFromVerticalPosition,
  varsWheelStep,
} from '../src/features/cae-workbench/calculation/varsTensor'

assert.equal(tensorElementCount([]), 1)
assert.equal(tensorElementCount([2, 3, 4]), 24)
assert.deepEqual(flattenVarsTensor(3, []), [3])
assert.deepEqual(
  flattenVarsTensor(
    [
      [1, 2],
      [3, 4],
    ],
    [2, 2],
  ),
  [1, 2, 3, 4],
)
assert.deepEqual(varsTensorFromFlat([1, 2, 3, 4], [2, 2]), [
  [1, 2],
  [3, 4],
])
assert.throws(() => flattenVarsTensor([[1], [2, 3]], [2, 2]))
assert.throws(() => flattenVarsTensor(Number.NaN, []))

const entry = { shape: [2, 2], min: -10, max: 10 } as const
const normalized = validateVarsTensor(
  [
    [1, 2],
    [3, 4],
  ],
  entry,
)
assert.deepEqual(normalized, [
  [1, 2],
  [3, 4],
])
assert.ok(Object.isFrozen(normalized))
assert.throws(() =>
  validateVarsTensor(
    [
      [1, 2],
      [3, 11],
    ],
    entry,
  ),
)

const selection = rectangleFromCells(2, 3, 0, 1)
assert.deepEqual(selection, { rowStart: 0, rowEnd: 2, columnStart: 1, columnEnd: 3 })
const original = [0, 1, 2, 3, 4, 5, 6, 7]
const changed = updateTensorRectangle(original, 2, 2, 1, rectangleFromCells(0, 0, 1, 0), (value) => value + 10)
assert.deepEqual(changed, [0, 1, 2, 3, 14, 5, 16, 7])
assert.deepEqual(original, [0, 1, 2, 3, 4, 5, 6, 7])

assert.equal(clampVarsValue(-20, -10, 10), -10)
assert.equal(clampVarsValue(20, -10, 10), 10)
assert.equal(varsBarIndex(0, 100, 4), 0)
assert.equal(varsBarIndex(74, 100, 4), 2)
assert.equal(varsBarIndex(120, 100, 4), 3)
assert.equal(varsValueFromVerticalPosition(0, 100, -10, 10), 10)
assert.equal(varsValueFromVerticalPosition(50, 100, -10, 10), 0)
assert.equal(varsValueFromVerticalPosition(120, 100, -10, 10), -10)
assert.deepEqual(tensorCellFromPoint(75, 25, 100, 100, 4, 4), { row: 1, column: 3 })
assert.equal(varsWheelStep(entry, false, false), 0.2)
assert.equal(varsWheelStep(entry, true, false), 2)
assert.ok(Math.abs(varsWheelStep(entry, false, true) - 0.02) < Number.EPSILON)

assert.equal(tensorSliceCount([3, 4]), 1)
assert.equal(tensorSliceCount([2, 3, 4, 5]), 6)
assert.deepEqual(tensorSliceCoordinates([2, 3, 4, 5], 0), [0, 0])
assert.deepEqual(tensorSliceCoordinates([2, 3, 4, 5], 4), [1, 1])
assert.deepEqual(tensorSliceCoordinates([2, 3, 4, 5], 5), [1, 2])

console.info('Vars tensor tests passed.')
