import { createContext, useContext, useRef, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { WorkbenchDialog } from '@/features/cae-workbench/caePageTypes'
import { defaultWorkbenchLayoutState, type WorkbenchLayoutState } from '@/features/cae-workbench/types'

type WorkbenchShellState = Readonly<{
  dialog: WorkbenchDialog
  layout: WorkbenchLayoutState
  setDialog: (next: WorkbenchDialog | ((current: WorkbenchDialog) => WorkbenchDialog)) => void
  setLayout: (next: WorkbenchLayoutState | ((current: WorkbenchLayoutState) => WorkbenchLayoutState)) => void
}>

export type WorkbenchShellStore = StoreApi<WorkbenchShellState>

export function createWorkbenchShellStore(initialLayout: WorkbenchLayoutState = defaultWorkbenchLayoutState) {
  return createStore<WorkbenchShellState>((set) => ({
    dialog: null,
    layout: initialLayout,
    setDialog: (next) => set((state) => ({ dialog: typeof next === 'function' ? next(state.dialog) : next })),
    setLayout: (next) => set((state) => ({ layout: typeof next === 'function' ? next(state.layout) : next })),
  }))
}

const WorkbenchShellStoreContext = createContext<WorkbenchShellStore | null>(null)

export function WorkbenchShellProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<WorkbenchShellStore>(null)
  if (!storeRef.current) storeRef.current = createWorkbenchShellStore()
  return <WorkbenchShellStoreContext.Provider value={storeRef.current}>{children}</WorkbenchShellStoreContext.Provider>
}

export function useWorkbenchShell<T>(selector: (state: WorkbenchShellState) => T) {
  const store = useContext(WorkbenchShellStoreContext)
  if (!store) throw new Error('WorkbenchShellProvider가 필요합니다.')
  return useStore(store, selector)
}
