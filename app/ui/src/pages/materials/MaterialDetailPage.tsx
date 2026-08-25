import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleAlert, Edit3, LoaderCircle, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  dbTables,
  type MaterialNameRecord,
  type MaterialParameterQualifierRecord,
  type MaterialParameterRecord,
} from '@/api'
import { catalogApi, type CatalogRuntimeSlice } from '@/api/catalog'
import { ApiError } from '@/api/http'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/use-auth'
import { cn } from '@/lib/utils'
import {
  MaterialEditDialog,
  MaterialNameDialog,
  MaterialParameterDialog,
  QualifierDialog,
} from './MaterialRecordDialogs'
import {
  allRowsRequest,
  getQualifierNames,
  isDedicatedQualifierName,
  isMaterialCatalogKey,
  materialDisplayName,
  relationRowsRequest,
} from './material-utils'
import {
  getMaterialModel,
  getMaterialProperty,
  readMaterialPropertyValue,
  readMaterialRelationValue,
} from './material-value'

function VisibilityBadge({ userId }: { userId?: string | null }) {
  return (
    <Badge className={userId === null ? 'bg-emerald-100 text-emerald-800' : undefined}>
      {userId === null ? 'Public' : 'Private'}
    </Badge>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function ComponentValue({ value }: { value: unknown }) {
  return (
    <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs break-normal whitespace-pre">
      {typeof value === 'number' ? String(value) : JSON.stringify(value)}
    </code>
  )
}

function ParameterValueSummary({
  catalog,
  parameter,
}: {
  catalog: CatalogRuntimeSlice
  parameter: MaterialParameterRecord
}) {
  const property = getMaterialProperty(parameter.name, catalog)
  if (property) {
    const value = readMaterialPropertyValue(property, parameter.value, catalog)
    if (value) {
      return (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{value.dtype}</Badge>
            <Badge>{value.unit}</Badge>
            <span className="text-xs text-muted-foreground">{property.quantity_kind}</span>
          </div>
          <ComponentValue value={value.value} />
        </div>
      )
    }
  }

  const model = getMaterialModel(parameter.name, catalog)
  if (model) {
    const value = readMaterialRelationValue(model, parameter.value, catalog)
    if (value) {
      return (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>sampled relation</Badge>
            <Badge>{value.input.values.length} samples</Badge>
            <span className="text-xs text-muted-foreground">
              {model.input.quantity_kind} ({value.input.unit}) → {model.output.quantity_kind} ({value.output.unit})
            </span>
          </div>
          <div className="grid gap-1 text-xs">
            {value.input.values.map((input, index) => (
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2" key={index}>
                <span className="text-muted-foreground">#{index + 1}</span>
                <ComponentValue value={input} />
                <span>→</span>
                <ComponentValue value={value.output.values[index]} />
              </div>
            ))}
          </div>
        </div>
      )
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CircleAlert className="size-4" />
        구조화 형식과 호환되지 않는 기존 값입니다.
      </div>
      <code className="mt-2 block max-h-24 overflow-auto rounded bg-white/70 p-2 text-[11px] break-all">
        {JSON.stringify(parameter.value)}
      </code>
    </div>
  )
}

export function MaterialDetail({
  className,
  command,
  compact = false,
  embedded = false,
  materialId,
  onBack,
  onDeleted,
  onRequestLogin,
}: {
  className?: string
  command?: Readonly<{ id: number; type: 'edit' | 'add-name' | 'add-parameter' | 'delete' }> | null
  compact?: boolean
  embedded?: boolean
  materialId: number
  onBack?: () => void
  onDeleted?: () => void
  onRequestLogin?: () => void
}) {
  const id = Number(materialId)
  const validId = Number.isSafeInteger(id) && id > 0
  const queryClient = useQueryClient()
  const auth = useAuth()
  const user = auth.user
  const admin = Boolean(user?.roles.includes('admin'))
  const [editMaterialOpen, setEditMaterialOpen] = useState(false)
  const [nameDialog, setNameDialog] = useState<{ record?: MaterialNameRecord } | null>(null)
  const [parameterDialog, setParameterDialog] = useState<{
    initialName?: string
    record?: MaterialParameterRecord
  } | null>(null)
  const [qualifierDialog, setQualifierDialog] = useState<{
    parameter: MaterialParameterRecord
    record?: MaterialParameterQualifierRecord
  } | null>(null)
  const handledCommandIdRef = useRef<number | null>(null)

  const materialQuery = useQuery({
    enabled: validId,
    queryKey: ['materials', 'detail', id],
    queryFn: async () => {
      const response = await dbTables.Material.listRows({ ...allRowsRequest(), selected_ids: [id] })
      return response.items.find((entry) => entry.id === id) ?? null
    },
  })
  const namesQuery = useQuery({
    enabled: validId,
    queryKey: ['materials', id, 'names'],
    queryFn: () => dbTables.MaterialName.listRows(relationRowsRequest('material_id', id)),
  })
  const parametersQuery = useQuery({
    enabled: validId,
    queryKey: ['materials', id, 'parameters'],
    queryFn: () => dbTables.MaterialParameter.listRows(relationRowsRequest('material_id', id)),
  })
  const parameterNames = [...new Set((parametersQuery.data?.items ?? []).map((parameter) => parameter.name))].sort()
  const catalogQuery = useQuery({
    enabled: parametersQuery.isSuccess,
    queryKey: ['catalog', 'material-manager', parameterNames],
    queryFn: async () => {
      const materialParameters: string[] = []
      const materialModels: string[] = []
      for (const name of parameterNames) {
        try {
          if (name.startsWith('model.')) {
            await catalogApi.getMaterialModel(name)
            materialModels.push(name)
          } else {
            await catalogApi.getMaterialParameter(name)
            materialParameters.push(name)
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
        }
      }
      return catalogApi.runtimeSlice({
        solvers: [],
        quantityKinds: [],
        materialParameters,
        materialModels,
      })
    },
  })
  const parameterIds = (parametersQuery.data?.items ?? [])
    .map((parameter) => parameter.id)
    .filter((parameterId): parameterId is number => parameterId !== undefined)
    .sort((left, right) => left - right)
  const qualifiersQuery = useQuery({
    enabled: parametersQuery.isSuccess,
    queryKey: ['materials', id, 'qualifiers', parameterIds],
    queryFn: async () => {
      const responses = await Promise.all(
        parameterIds.map((parameterId) =>
          dbTables.MaterialParameterQualifier.listRows(relationRowsRequest('material_parameter_id', parameterId)),
        ),
      )
      return responses.flatMap((response) => response.items)
    },
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['materials'] })
  const deleteMaterialMutation = useMutation({
    mutationFn: () => dbTables.Material.deleteRows([id]),
    onSuccess: async () => {
      await invalidate()
      toast.success('Material을 삭제했습니다.')
      if (onDeleted) onDeleted()
      else onBack?.()
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Material을 삭제하지 못했습니다.'),
  })
  const deleteNameMutation = useMutation({
    mutationFn: (recordId: number) => dbTables.MaterialName.deleteRows([recordId]),
    onSuccess: async () => {
      await invalidate()
      toast.success('Material 이름을 삭제했습니다.')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Material 이름을 삭제하지 못했습니다.'),
  })
  const deleteParameterMutation = useMutation({
    mutationFn: (recordId: number) => dbTables.MaterialParameter.deleteRows([recordId]),
    onSuccess: async () => {
      await invalidate()
      toast.success('Material parameter를 삭제했습니다.')
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Material parameter를 삭제하지 못했습니다.'),
  })
  const deleteQualifierMutation = useMutation({
    mutationFn: (recordId: number) => dbTables.MaterialParameterQualifier.deleteRows([recordId]),
    onSuccess: async () => {
      await invalidate()
      toast.success('Qualifier를 삭제했습니다.')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Qualifier를 삭제하지 못했습니다.'),
  })

  useEffect(() => {
    if (!command || handledCommandIdRef.current === command.id) return
    const material = materialQuery.data
    if (!material) return
    handledCommandIdRef.current = command.id
    if (!user) {
      onRequestLogin?.()
      return
    }
    const canEditMaterial = admin || material.user_id === user.id
    const canAddChild = admin || material.user_id === null || material.user_id === user.id
    if ((command.type === 'edit' || command.type === 'delete') && !canEditMaterial) {
      toast.error('이 Material을 편집하거나 삭제할 권한이 없습니다.')
      return
    }
    if ((command.type === 'add-name' || command.type === 'add-parameter') && !canAddChild) {
      toast.error('이 Material에 항목을 추가할 권한이 없습니다.')
      return
    }
    if (command.type === 'edit') setEditMaterialOpen(true)
    if (command.type === 'add-name') setNameDialog({})
    if (command.type === 'add-parameter') setParameterDialog({})
    if (
      command.type === 'delete' &&
      window.confirm('이 Material과 연결된 이름, parameter, qualifier를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')
    ) {
      deleteMaterialMutation.mutate()
    }
  }, [admin, command, deleteMaterialMutation, materialQuery.data, onRequestLogin, user])

  const parameterItems = parametersQuery.data?.items ?? []

  const loading =
    materialQuery.isLoading ||
    namesQuery.isLoading ||
    parametersQuery.isLoading ||
    qualifiersQuery.isLoading ||
    (parametersQuery.isSuccess && catalogQuery.isPending)
  if (!validId) return <div className="p-8 text-center text-destructive">유효하지 않은 Material ID입니다.</div>
  if (loading)
    return (
      <div className="flex min-h-96 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="animate-spin" />
        Material을 불러오는 중입니다.
      </div>
    )
  if (materialQuery.isError || namesQuery.isError || parametersQuery.isError || qualifiersQuery.isError)
    return <div className="p-8 text-center text-destructive">Material 상세 정보를 불러오지 못했습니다.</div>
  if (catalogQuery.isError)
    return (
      <div className="p-8 text-center text-destructive" role="alert">
        <p>Material Catalog를 불러오지 못했습니다.</p>
        <Button className="mt-4" onClick={() => catalogQuery.refetch()} variant="outline">
          다시 시도
        </Button>
      </div>
    )
  const material = materialQuery.data
  if (!material)
    return (
      <div className="p-8 text-center">
        <p className="font-medium">Material을 찾을 수 없습니다.</p>
        {onBack ? (
          <Button className="mt-4" onClick={onBack} variant="outline">
            목록으로
          </Button>
        ) : null}
      </div>
    )

  const names = namesQuery.data?.items ?? []
  const parameters = parameterItems
  const catalog = catalogQuery.data!
  const qualifiers = qualifiersQuery.data ?? []
  const title = materialDisplayName(material, names)
  const canEditMaterial = Boolean(user && (admin || material.user_id === user.id))
  const canAddChild = Boolean(user && (admin || material.user_id === null || material.user_id === user.id))
  const canEditOwned = (ownerId?: string | null) => Boolean(user && (admin || ownerId === user.id))
  const actions = canEditMaterial ? (
    <>
      <Button onClick={() => setEditMaterialOpen(true)} size={compact ? 'sm' : 'default'} variant="outline">
        <Edit3 />
        편집
      </Button>
      <Button
        disabled={deleteMaterialMutation.isPending}
        onClick={() => {
          if (
            window.confirm(
              '이 Material과 연결된 이름, parameter, qualifier를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.',
            )
          )
            deleteMaterialMutation.mutate()
        }}
        size={compact ? 'sm' : 'default'}
        variant="destructive"
      >
        <Trash2 />
        삭제
      </Button>
    </>
  ) : undefined

  return (
    <div
      className={cn(
        compact ? 'h-full space-y-4 overflow-y-auto p-3' : 'space-y-6',
        !embedded && !compact && 'mx-auto max-w-7xl px-4 py-8 sm:px-6',
        className,
      )}
    >
      {onBack ? (
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft />
          Material 목록
        </Button>
      ) : null}
      {compact ? (
        <header className="space-y-2">
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Material #{material.id}
            </p>
            <h2 className="text-lg font-semibold break-words">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{material.description || '등록된 설명이 없습니다.'}</p>
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </header>
      ) : (
        <PageHeader
          actions={actions}
          description={material.description || '등록된 설명이 없습니다.'}
          eyebrow={`Material #${material.id}`}
          title={title}
        />
      )}

      <Card>
        <CardHeader className="sm:flex sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>기본 정보</CardTitle>
            <CardDescription className="mt-1">Material의 식별 정보와 고정된 공개 범위입니다.</CardDescription>
          </div>
          <VisibilityBadge userId={material.user_id} />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">InChI</p>
            <code className="mt-1 block rounded-lg bg-muted p-3 text-xs break-all">
              {material.inchi || '등록되지 않음'}
            </code>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Updated</p>
            <p className="mt-1 text-sm">
              {material.updated_at ? new Date(material.updated_at).toLocaleString('ko-KR') : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Color</p>
            {material.color ? (
              <div className="mt-1 flex items-center gap-2 text-sm">
                <span
                  aria-label={`색상 ${material.color}`}
                  className="size-6 rounded-md border"
                  style={{ backgroundColor: material.color }}
                />
                <code>{material.color}</code>
              </div>
            ) : (
              <p className="mt-1 text-sm">등록되지 않음</p>
            )}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="material-names-title">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold" id="material-names-title">
              Material names
            </h3>
            <p className="text-sm text-muted-foreground">검색과 표시에서 사용하는 이름 목록입니다.</p>
          </div>
          <Button disabled={!canAddChild} onClick={() => setNameDialog({})} size="sm">
            <Plus />
            이름 추가
          </Button>
        </div>
        <Card className="divide-y overflow-hidden">
          {names.length ? (
            names.map((name) => (
              <div className="flex items-center justify-between gap-3 p-4" key={name.id}>
                <div className="min-w-0">
                  <p className="truncate font-medium">{name.name}</p>
                  <div className="mt-1">
                    <VisibilityBadge userId={name.user_id} />
                  </div>
                </div>
                {canEditOwned(name.user_id) ? (
                  <div className="flex gap-1">
                    <Button
                      aria-label={`${name.name} 편집`}
                      onClick={() => setNameDialog({ record: name })}
                      size="icon"
                      variant="ghost"
                    >
                      <Edit3 />
                    </Button>
                    <Button
                      aria-label={`${name.name} 삭제`}
                      onClick={() => {
                        if (name.id !== undefined && window.confirm(`“${name.name}” 이름을 삭제할까요?`))
                          deleteNameMutation.mutate(name.id)
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ) : (
                  <LockKeyhole className="size-4 text-muted-foreground" />
                )}
              </div>
            ))
          ) : (
            <EmptyState>등록된 Material 이름이 없습니다.</EmptyState>
          )}
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="material-parameters-title">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold" id="material-parameters-title">
              Material parameters
            </h3>
            <p className="text-sm text-muted-foreground">카탈로그 Quantity Kind에 맞는 값과 unit을 관리합니다.</p>
          </div>
          <Button disabled={!canAddChild} onClick={() => setParameterDialog({})} size="sm">
            <Plus />
            Parameter 추가
          </Button>
        </div>
        <div className="space-y-3">
          {parameters.length ? (
            parameters.map((parameter) => {
              const parameterQualifiers = qualifiers.filter(
                (qualifier) => qualifier.material_parameter_id === parameter.id,
              )
              const editable = canEditOwned(parameter.user_id)
              const catalogKey = isMaterialCatalogKey(parameter.name, catalog)
              return (
                <Card key={parameter.id}>
                  <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-semibold break-all text-orange-700">{parameter.name}</code>
                        <VisibilityBadge userId={parameter.user_id} />
                        {!catalogKey ? <Badge className="bg-destructive/10 text-destructive">카탈로그 밖</Badge> : null}
                      </div>
                      <CardDescription className="mt-2">{parameter.description || '설명 없음'}</CardDescription>
                    </div>
                    {editable ? (
                      <div className="flex gap-1">
                        <Button
                          aria-label={`${parameter.name} 편집`}
                          onClick={() => setParameterDialog({ record: parameter })}
                          size="icon"
                          variant="ghost"
                        >
                          <Edit3 />
                        </Button>
                        <Button
                          aria-label={`${parameter.name} 삭제`}
                          onClick={() => {
                            if (
                              parameter.id !== undefined &&
                              window.confirm('이 parameter와 모든 qualifier를 삭제할까요?')
                            )
                              deleteParameterMutation.mutate(parameter.id)
                          }}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ) : (
                      <LockKeyhole className="size-4 text-muted-foreground" />
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ParameterValueSummary catalog={catalog} parameter={parameter} />
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {parameter.source ? <Badge>source · {parameter.source}</Badge> : null}
                      {parameter.version ? <Badge>version · {parameter.version}</Badge> : null}
                      {parameter.temperature !== null && parameter.temperature !== undefined ? (
                        <Badge>temperature · {parameter.temperature}</Badge>
                      ) : null}
                      {parameter.pressure !== null && parameter.pressure !== undefined ? (
                        <Badge>pressure · {parameter.pressure}</Badge>
                      ) : null}
                      {parameter.frequency !== null && parameter.frequency !== undefined ? (
                        <Badge>frequency · {parameter.frequency} Hz</Badge>
                      ) : null}
                    </div>
                    <div className="rounded-lg border">
                      <div className="flex items-center justify-between border-b px-3 py-2">
                        <p className="text-xs font-semibold">Qualifiers</p>
                        <Button
                          disabled={!editable || !catalogKey}
                          onClick={() => setQualifierDialog({ parameter })}
                          size="sm"
                          variant="ghost"
                        >
                          <Plus />
                          추가
                        </Button>
                      </div>
                      {parameterQualifiers.length ? (
                        parameterQualifiers.map((qualifier) => {
                          const validQualifier = getQualifierNames(parameter.name, catalog).includes(qualifier.name)
                          const dedicated = isDedicatedQualifierName(qualifier.name)
                          return (
                            <div
                              className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"
                              key={qualifier.id}
                            >
                              <div className="min-w-0">
                                <code className="text-xs">{qualifier.name}</code>
                                <span className="ml-2 text-sm">{qualifier.value}</span>
                                {!validQualifier ? (
                                  <Badge className="ml-2 bg-destructive/10 text-destructive">
                                    {dedicated ? '전용 필드 중복' : '카탈로그 밖'}
                                  </Badge>
                                ) : null}
                              </div>
                              {editable ? (
                                <div className="flex gap-1">
                                  <Button
                                    disabled={!validQualifier}
                                    onClick={() => setQualifierDialog({ parameter, record: qualifier })}
                                    size="icon"
                                    variant="ghost"
                                  >
                                    <Edit3 />
                                  </Button>
                                  <Button
                                    onClick={() => {
                                      if (qualifier.id !== undefined && window.confirm('이 qualifier를 삭제할까요?'))
                                        deleteQualifierMutation.mutate(qualifier.id)
                                    }}
                                    size="icon"
                                    variant="ghost"
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          )
                        })
                      ) : (
                        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                          등록된 qualifier가 없습니다.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          ) : (
            <EmptyState>등록된 Material parameter가 없습니다.</EmptyState>
          )}
        </div>
      </section>

      {!user ? (
        <Card className={cn('border-dashed')}>
          <CardContent className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="font-medium">Material 데이터를 추가하려면 로그인하세요</p>
              <p className="text-sm text-muted-foreground">공개 Material과 parameter는 계속 조회할 수 있습니다.</p>
            </div>
            <Button type="button" onClick={onRequestLogin}>
              Account 열기
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {canEditMaterial ? (
        <MaterialEditDialog material={material} onOpenChange={setEditMaterialOpen} open={editMaterialOpen} />
      ) : null}
      {user && nameDialog ? (
        <MaterialNameDialog
          material={material}
          onOpenChange={(open) => {
            if (!open) setNameDialog(null)
          }}
          open
          record={nameDialog.record}
          user={user}
        />
      ) : null}
      {user && parameterDialog ? (
        <MaterialParameterDialog
          catalog={catalog}
          initialName={parameterDialog.initialName}
          material={material}
          onOpenChange={(open) => {
            if (!open) setParameterDialog(null)
          }}
          open
          record={parameterDialog.record}
          user={user}
        />
      ) : null}
      {qualifierDialog ? (
        <QualifierDialog
          catalog={catalog}
          onOpenChange={(open) => {
            if (!open) setQualifierDialog(null)
          }}
          open
          parameter={qualifierDialog.parameter}
          record={qualifierDialog.record}
        />
      ) : null}
    </div>
  )
}
