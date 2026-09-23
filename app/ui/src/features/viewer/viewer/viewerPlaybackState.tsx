import { createContext, useState, type ReactNode } from 'react'

export type ViewerPlaybackSource = {
  id: string
  label: string
  disabled?: string
  error?: string
  preferred?: boolean
  playing: boolean
  repeat: boolean
  speed: number
  position: number
  minimum: number
  maximum: number
  step: number | 'any'
  positionLabel: string
  timingLabel?: string
  duration?: number
  onDuration?: (value: number) => void
  play: () => void
  pause: () => void
  seek: (value: number) => void
  previous: () => void
  next: () => void
  onRepeat: (value: boolean) => void
  onSpeed: (value: number) => void
}

function createPlaybackSources() {
  const groups = new Map<string, ViewerPlaybackSource[]>()
  const signatures = new Map<string, string>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    groups,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => version,
    update(owner: string, sources: ViewerPlaybackSource[]) {
      const signature = JSON.stringify(sources)
      if (signatures.get(owner) === signature) {
        // A data refresh can replace callbacks without changing the displayed timeline.
        const previous = groups.get(owner)
        sources.forEach((source, index) => Object.assign(previous![index], source))
        return
      }
      if (sources.length) groups.set(owner, sources)
      else groups.delete(owner)
      signatures.set(owner, signature)
      version++
      listeners.forEach((listener) => listener())
    },
    remove(owner: string) {
      if (!signatures.delete(owner)) return
      groups.get(owner)?.forEach((source) => source.pause())
      groups.delete(owner)
      version++
      listeners.forEach((listener) => listener())
    },
  }
}

export const ViewerPlaybackAvailable = createContext(true)

export const ViewerPlaybackContext = createContext<ReturnType<typeof createPlaybackSources> | null>(null)

export function ViewerPlaybackProvider({ children }: { children: ReactNode }) {
  const [sources] = useState(createPlaybackSources)
  return <ViewerPlaybackContext.Provider value={sources}>{children}</ViewerPlaybackContext.Provider>
}
