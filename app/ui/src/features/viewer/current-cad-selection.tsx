import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

const CurrentCadSelectionContext = createContext<{
  currentExperimentId: number | null
  currentStructureId: number | null
  setCurrentExperimentId: (id: number | null) => void
  setCurrentStructureId: (id: number | null) => void
} | null>(null)

export function CurrentCadSelectionProvider({ children }: { children: ReactNode }) {
  const [currentExperimentId, setCurrentExperimentId] = useState<number | null>(null)
  const [currentStructureId, setCurrentStructureId] = useState<number | null>(null)
  const value = useMemo(
    () => ({
      currentExperimentId,
      currentStructureId,
      setCurrentExperimentId,
      setCurrentStructureId,
    }),
    [currentExperimentId, currentStructureId],
  )

  return <CurrentCadSelectionContext.Provider value={value}>{children}</CurrentCadSelectionContext.Provider>
}

// This hook intentionally shares the component provider module.
// eslint-disable-next-line react-refresh/only-export-components
export function useCurrentCadSelection() {
  const value = useContext(CurrentCadSelectionContext)
  if (!value) throw new Error('CurrentCadSelectionProvider가 필요합니다.')
  return value
}
