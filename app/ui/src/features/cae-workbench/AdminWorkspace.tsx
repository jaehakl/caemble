import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Star, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { dbTables, type AvailableExperimentRecord, type SavedExperimentRecord, type UserData } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { privateQueryScope } from '@/features/auth/queryKeys'
import { adminDemoCandidatesQueryOptions, adminExperimentsQueryOptions } from '@/features/experiment/queryOptions'
import { invalidateExperimentSummaries } from '@/features/experiment/queryInvalidation'
import { MaterialManager } from '@/features/materials/MaterialManager'
import { adminQueryKeys, adminUsersQueryOptions } from './adminQueryOptions'

function countLabel(experiment: AvailableExperimentRecord) {
  const counts = experiment.predictionCounts
  return `${counts.recordedMeasurements} Measurements · ${counts.readyCalculations} Calculations · ${counts.calculationData} Data`
}

export function AdminWorkspace({
  currentUser,
  onOpenExperiment,
}: {
  currentUser: UserData
  onOpenExperiment: (experiment: SavedExperimentRecord) => void
}) {
  const queryClient = useQueryClient()
  const queryScope = privateQueryScope(currentUser)
  const usersQuery = useQuery(adminUsersQueryOptions(queryScope))
  const experimentsQuery = useQuery(adminExperimentsQueryOptions(queryScope))
  const candidatesQuery = useQuery(adminDemoCandidatesQueryOptions(queryScope))
  const [orderedIds, setOrderedIds] = useState<readonly number[]>([])
  const [defaultId, setDefaultId] = useState<number | null>(null)

  useEffect(() => {
    if (!candidatesQuery.data) return
    const demos = candidatesQuery.data.items
      .filter((item) => item.isDemo)
      .sort((left, right) => (left.demoOrder ?? 0) - (right.demoOrder ?? 0))
    setOrderedIds(demos.map((item) => item.id))
    setDefaultId(demos.find((item) => item.demoDefault)?.id ?? demos[0]?.id ?? null)
  }, [candidatesQuery.dataUpdatedAt])

  const candidates = candidatesQuery.data?.items ?? []
  const byId = useMemo(() => new Map(candidates.map((item) => [item.id, item])), [candidates])
  const availableToAdd = candidates.filter((item) => !orderedIds.includes(item.id))

  const deleteUser = useMutation({
    mutationFn: (id: string) => dbTables.User.deleteUserAdmin(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.users(queryScope) })
      toast.success('사용자를 삭제했습니다.')
    },
    onError: (cause: unknown) => toast.error(cause instanceof Error ? cause.message : '사용자를 삭제하지 못했습니다.'),
  })
  const saveDemos = useMutation({
    mutationFn: () => dbTables.Experiment.replaceDemos(orderedIds, defaultId),
    onSuccess: async () => {
      await invalidateExperimentSummaries(queryClient, queryScope)
      toast.success('공개 Demo 구성을 저장했습니다.')
    },
    onError: (cause: unknown) =>
      toast.error(cause instanceof Error ? cause.message : 'Demo 구성을 저장하지 못했습니다.'),
  })

  const removeDemo = (id: number) => {
    const next = orderedIds.filter((value) => value !== id)
    setOrderedIds(next)
    if (defaultId === id) setDefaultId(next[0] ?? null)
  }
  const moveDemo = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= orderedIds.length) return
    const next = [...orderedIds]
    ;[next[index], next[target]] = [next[target], next[index]]
    setOrderedIds(next)
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-muted/20 p-4">
      <Tabs className="mx-auto max-w-7xl" defaultValue="demos">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="experiments">All Experiments</TabsTrigger>
          <TabsTrigger value="demos">Demo Curation</TabsTrigger>
          <TabsTrigger value="materials">Public Materials</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="users">
          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>계정을 확인하고 자기 자신을 제외한 사용자를 삭제할 수 있습니다.</CardDescription>
            </CardHeader>
            <CardContent>
              {usersQuery.isPending ? <LoaderCircle className="animate-spin" /> : null}
              <div className="divide-y rounded-md border">
                {(usersQuery.data ?? []).map((user) => (
                  <div className="flex items-center gap-3 p-3" key={user.id}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{user.display_name || user.email || user.id}</p>
                      <p className="truncate text-xs text-muted-foreground">{user.email || user.id}</p>
                    </div>
                    {user.roles.map((role) => (
                      <Badge key={role}>{role}</Badge>
                    ))}
                    <Button
                      aria-label={`${user.email || user.id} 삭제`}
                      disabled={user.id === currentUser.id || deleteUser.isPending}
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`${user.email || user.id} 사용자를 삭제할까요?`)) deleteUser.mutate(user.id)
                      }}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent className="mt-4" value="experiments">
          <Card>
            <CardHeader>
              <CardTitle>All Experiments</CardTitle>
              <CardDescription>모든 소유자의 저장된 Experiment Version입니다.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y rounded-md border p-0">
              {experimentsQuery.isPending ? <LoaderCircle className="m-4 animate-spin" /> : null}
              {(experimentsQuery.data?.items ?? []).map((experiment) => (
                <button
                  className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50"
                  key={experiment.id}
                  type="button"
                  onClick={() => onOpenExperiment(experiment)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{experiment.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{experiment.coordinate}</span>
                  </span>
                  {experiment.isDemo ? <Badge>Demo</Badge> : null}
                  <span className="text-xs text-muted-foreground">{experiment.user_id}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent className="mt-4 space-y-4" value="demos">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            공개 Demo로 등록하면 source bundle과 현재 및 향후 생성되는 전체 Measurement, RecordedData, Calculation,
            CalculationData가 로그인 없이 공개됩니다. 스냅샷이 아니라 최신 데이터를 그대로 노출합니다.
          </div>
          <Card>
            <CardHeader>
              <CardTitle>공개 순서와 대표 Demo</CardTitle>
              <CardDescription>첫 방문자는 별표로 표시된 대표 Demo를 자동으로 엽니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {orderedIds.map((id, index) => {
                const experiment = byId.get(id)
                if (!experiment) return null
                return (
                  <div className="flex items-center gap-2 rounded-md border p-3" key={id}>
                    <span className="w-6 text-center text-sm text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{experiment.name}</span>
                      <span className="block text-xs text-muted-foreground">{countLabel(experiment)}</span>
                    </span>
                    <Badge className={experiment.predictionReady ? '' : 'bg-destructive text-white'}>
                      {experiment.predictionReady ? 'Ready' : 'Not ready'}
                    </Badge>
                    <Button aria-label="대표 Demo 지정" size="icon" variant="ghost" onClick={() => setDefaultId(id)}>
                      <Star className={defaultId === id ? 'fill-amber-400 text-amber-500' : ''} />
                    </Button>
                    <Button disabled={index === 0} size="icon" variant="ghost" onClick={() => moveDemo(index, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button
                      disabled={index === orderedIds.length - 1}
                      size="icon"
                      variant="ghost"
                      onClick={() => moveDemo(index, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button aria-label="공개 해제" size="icon" variant="ghost" onClick={() => removeDemo(id)}>
                      <X className="text-destructive" />
                    </Button>
                  </div>
                )
              })}
              {orderedIds.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  등록된 Demo가 없습니다.
                </p>
              ) : null}
              <div className="flex items-center gap-2 border-t pt-3">
                <select className="h-9 min-w-72 rounded-md border bg-background px-2 text-sm" id="demo-candidate">
                  <option value="">Experiment 선택</option>
                  {availableToAdd.map((experiment) => (
                    <option disabled={!experiment.predictionReady} key={experiment.id} value={experiment.id}>
                      {experiment.name} ·{' '}
                      {experiment.predictionReady ? countLabel(experiment) : 'Prediction 준비 안 됨'}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  onClick={() => {
                    const element = document.getElementById('demo-candidate') as HTMLSelectElement | null
                    const id = Number(element?.value)
                    if (!Number.isSafeInteger(id) || id <= 0) return
                    const next = [...orderedIds, id]
                    setOrderedIds(next)
                    if (defaultId === null) setDefaultId(id)
                    if (element) element.value = ''
                  }}
                >
                  <Plus /> 추가
                </Button>
                <Button
                  className="ml-auto"
                  disabled={saveDemos.isPending || (orderedIds.length > 0 && defaultId === null)}
                  onClick={() => saveDemos.mutate()}
                >
                  {saveDemos.isPending ? <LoaderCircle className="animate-spin" /> : null}
                  저장
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent className="mt-4" value="materials">
          <MaterialManager scope="public" />
        </TabsContent>
      </Tabs>
    </div>
  )
}
