import type { CadElementType, CadNode } from './types'

export function isCadNode(value: unknown): value is CadNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value && 'children' in value
}

export function flattenValues(values: unknown[]): unknown[] {
  return values.flat(Infinity).filter((value) => value !== null && value !== undefined && value !== false)
}

export function Fragment({ children }: { children?: unknown }) {
  return children
}

export function h(type: CadElementType, props: Record<string, unknown> | null, ...children: unknown[]): CadNode {
  return {
    type,
    props: props ?? {},
    children: flattenValues(children),
  }
}
