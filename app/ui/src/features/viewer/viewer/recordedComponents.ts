export function componentIndexPaths(tensorOrder: number): readonly (readonly number[])[] {
  if (tensorOrder === 0) return Object.freeze([Object.freeze([])])
  const suffixes = componentIndexPaths(tensorOrder - 1)
  return Object.freeze([0, 1, 2].flatMap((index) => suffixes.map((suffix) => Object.freeze([index, ...suffix]))))
}

export function projectRecordedComponents(
  value: unknown,
  axisDepth: number,
  tensorOrder: number,
  selection: string,
): unknown {
  if (axisDepth > 0) {
    return Object.freeze(
      (value as readonly unknown[]).map((item) =>
        projectRecordedComponents(item, axisDepth - 1, tensorOrder, selection),
      ),
    )
  }
  if (tensorOrder === 0) return value
  if (selection === 'norm') {
    const components = (value as readonly unknown[]).flat(tensorOrder) as readonly number[]
    return Math.sqrt(components.reduce((sum, component) => sum + component ** 2, 0))
  }
  const indices = selection.slice('component:'.length).split(',').map(Number)
  return indices.reduce<unknown>((component, index) => (component as readonly unknown[])[index], value)
}

export function componentLabel(indices: readonly number[], identityBasis: boolean) {
  const names = identityBasis ? ['x', 'y', 'z'] : ['b0', 'b1', 'b2']
  return indices.map((index) => names[index]).join('')
}
