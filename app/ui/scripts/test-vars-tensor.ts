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
  updateTensorBrush,
  validateVarsChanges,
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

const normalizedChanges = validateVarsChanges(
  {
    matrix: [
      [1, 2],
      [3, 4],
    ],
    scalar: 5,
  },
  {
    matrix: entry,
    scalar: { shape: [], min: 0, max: 10 },
  },
)
assert.deepEqual(normalizedChanges, {
  matrix: [
    [1, 2],
    [3, 4],
  ],
  scalar: 5,
})
assert.ok(Object.isFrozen(normalizedChanges))
assert.ok(Object.isFrozen(normalizedChanges.matrix))
assert.throws(() =>
  validateVarsChanges(
    {
      matrix: [
        [1, 2],
        [3, 11],
      ],
      scalar: 5,
    },
    { matrix: entry, scalar: { shape: [], min: 0, max: 10 } },
  ),
)
assert.throws(() => validateVarsChanges({ unknown: 1 }, { scalar: { shape: [], min: 0, max: 10 } }))

const selection = rectangleFromCells(2, 3, 0, 1)
assert.deepEqual(selection, { rowStart: 0, rowEnd: 2, columnStart: 1, columnEnd: 3 })
const original = [0, 1, 2, 3, 4, 5, 6, 7]
const changed = updateTensorRectangle(original, 2, 2, 1, rectangleFromCells(0, 0, 1, 0), (value) => value + 10)
assert.deepEqual(changed, [0, 1, 2, 3, 14, 5, 16, 7])
assert.deepEqual(original, [0, 1, 2, 3, 4, 5, 6, 7])

const brushedOnce = updateTensorBrush(
  Array(18).fill(0),
  3,
  3,
  1,
  { row: 0, column: 0 },
  { row: 2, column: 2 },
  1,
  (value) => clampVarsValue(value + 0.4, 0, 1),
)
assert.deepEqual(brushedOnce.slice(0, 9), Array(9).fill(0))
assert.equal(brushedOnce[9], 0.4)
assert.equal(brushedOnce[10], 0.8)
assert.equal(brushedOnce[13], 0.4)
assert.equal(brushedOnce[17], 0.4)
assert.equal(
  updateTensorBrush(
    Array(9).fill(0),
    3,
    3,
    0,
    { row: 1, column: 1 },
    { row: 1, column: 1 },
    1,
    (value) => value + 0.4,
  )[4],
  0.4,
)
const brushedTwice = updateTensorBrush(brushedOnce, 3, 3, 1, { row: 0, column: 0 }, { row: 2, column: 2 }, 1, (value) =>
  clampVarsValue(value + 0.8, 0, 1),
)
assert.equal(brushedTwice[9], 1)
assert.equal(brushedTwice[13], 1)
assert.equal(brushedTwice[17], 1)
const resetBaseline = Array.from({ length: 18 }, (_item, index) => index)
const erased = updateTensorBrush(
  brushedTwice,
  3,
  3,
  1,
  { row: 1, column: 1 },
  { row: 1, column: 1 },
  1,
  (_value, index) => resetBaseline[index],
)
assert.equal(erased[13], 13)
assert.equal(erased[9], 1)

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
