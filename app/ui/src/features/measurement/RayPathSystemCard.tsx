import { Route } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RAY_PATH_EVENT_NAMES, type RayPathBundle } from '@/lib/cad/model'

export function RayPathSystemCard({
  bundles,
  declared,
  error,
}: {
  bundles: readonly RayPathBundle[]
  declared: boolean
  error?: string | null
}) {
  if (!declared && bundles.length === 0 && !error) return null
  const pathCount = bundles.reduce((sum, bundle) => sum + bundle.pathCount, 0)
  const segmentCount = bundles.reduce((sum, bundle) => sum + bundle.segmentCount, 0)
  const eventCounts = new Uint32Array(RAY_PATH_EVENT_NAMES.length)
  bundles.forEach((bundle) => bundle.segmentEvent.forEach((event) => (eventCounts[event] += 1)))

  return (
    <Card className={error ? 'border-destructive/50' : undefined} data-system-result="ray-paths">
      <CardHeader className="p-3 pb-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Route className="size-4 text-primary" />
          Ray paths · {pathCount.toLocaleString()} paths · {segmentCount.toLocaleString()} segments
          <Badge className="ml-auto border bg-transparent">System result</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-3 text-xs text-muted-foreground">
        {error ? <p className="text-destructive">{error}</p> : null}
        {!error && bundles.length === 0 ? <p>저장된 ray path가 없습니다.</p> : null}
        {bundles.map((bundle) => (
          <p key={bundle.id}>
            {bundle.id} · {bundle.pathCount.toLocaleString()} paths · {bundle.segmentCount.toLocaleString()} segments
          </p>
        ))}
        {eventCounts.some((count) => count > 0) ? (
          <div className="flex flex-wrap gap-1" aria-label="Ray path events">
            {RAY_PATH_EVENT_NAMES.flatMap((name, index) =>
              eventCounts[index] > 0
                ? [
                    <Badge key={name}>
                      {name} · {eventCounts[index].toLocaleString()}
                    </Badge>,
                  ]
                : [],
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
