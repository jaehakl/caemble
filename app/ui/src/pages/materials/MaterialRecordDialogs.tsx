import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  dbTables,
  type MaterialNameRecord,
  type MaterialParameterQualifierRecord,
  type MaterialParameterRecord,
  type MaterialRecord,
  type UserData,
} from '@/api'
import { catalogApi, type CatalogRuntimeSlice } from '@/api/catalog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { FloatDataDType } from '@/lib/cad'
import {
  MaterialCatalogPickerDialog,
  QualifierCatalogPickerDialog,
  type MaterialCatalogEntry,
} from './CatalogPickerDialog'
import { MaterialColorField } from './MaterialColorField'
import {
  createMaterialPropertyValue,
  createMaterialRelationValue,
  getMaterialModel,
  getMaterialProperty,
  getQuantityValueConfig,
  materialFloatDTypes,
  type MaterialModelDefinition,
  readMaterialPropertyValue,
  readMaterialRelationValue,
} from './material-value'
import {
  getQualifierNames,
  isDedicatedQualifierName,
  isMaterialCatalogKey,
  isMaterialColorValid,
} from './material-utils'
import { VisibilityField, type Visibility } from './VisibilityField'

function isAdmin(user: UserData) {
  return user.roles.includes('admin')
}

function defaultVisibility(material: MaterialRecord, user: UserData, recordOwner?: string | null): Visibility {
  if (material.user_id !== null) return 'private'
  if (!isAdmin(user)) return 'private'
  return recordOwner === undefined || recordOwner === null ? 'public' : 'private'
}

function childOwnerId(material: MaterialRecord, user: UserData, visibility: Visibility, existingOwner?: string | null) {
  if (material.user_id !== null) return material.user_id
  if (!isAdmin(user)) return user.id
  if (visibility === 'public') return null
  return existingOwner ?? user.id
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-medium">{children}</span>
}

export function MaterialEditDialog({
  material,
  onOpenChange,
  open,
}: {
  material: MaterialRecord
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const queryClient = useQueryClient()
  const [inchi, setInchi] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')
  useEffect(() => {
    if (open) {
      setInchi(material.inchi ?? '')
      setDescription(material.description ?? '')
      setColor(material.color ?? '')
    }
  }, [material.color, material.description, material.inchi, open])
  const mutation = useMutation({
    mutationFn: () =>
      dbTables.Material.upsertRow([
        {
          ...material,
          inchi: inchi.trim() || null,
          description: description.trim() || null,
          color: color.trim().toLowerCase() || null,
        },
      ]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['materials'] })
      toast.success('Material 정보를 저장했습니다.')
      onOpenChange(false)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Material 정보를 저장하지 못했습니다.'),
  })
  const colorValid = isMaterialColorValid(color)
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Material 정보 편집</DialogTitle>
            <DialogDescription>공개 범위는 생성 후 변경할 수 없습니다.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5">
            <FieldLabel>InChI</FieldLabel>
            <Input onChange={(event) => setInchi(event.target.value)} value={inchi} />
          </label>
          <label className="grid gap-1.5">
            <FieldLabel>설명</FieldLabel>
            <textarea
              className="min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </label>
          <MaterialColorField onChange={setColor} value={color} />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              취소
            </Button>
            <Button disabled={!colorValid || mutation.isPending} type="submit">
              {mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}저장
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function MaterialNameDialog({
  material,
  onOpenChange,
  open,
  record,
  user,
}: {
  material: MaterialRecord
  onOpenChange: (open: boolean) => void
  open: boolean
  record?: MaterialNameRecord
  user: UserData
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  useEffect(() => {
    if (open) {
      setName(record?.name ?? '')
      setVisibility(defaultVisibility(material, user, record?.user_id))
    }
  }, [material, open, record, user])
  const mutation = useMutation({
    mutationFn: () =>
      dbTables.MaterialName.upsertRow([
        {
          ...(record ?? {}),
          material_id: material.id!,
          name: name.trim(),
          user_id: childOwnerId(material, user, visibility, record?.user_id),
        },
      ]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['materials'] })
      toast.success(record ? 'Material 이름을 저장했습니다.' : 'Material 이름을 추가했습니다.')
      onOpenChange(false)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Material 이름을 저장하지 못했습니다.'),
  })
  const visibilityDisabled = !isAdmin(user) || material.user_id !== null
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            mutation.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{record ? 'Material 이름 편집' : 'Material 이름 추가'}</DialogTitle>
            <DialogDescription>검색과 표시에서 사용할 별칭을 등록합니다.</DialogDescription>
          </DialogHeader>
          <VisibilityField
            disabled={visibilityDisabled}
            onChange={setVisibility}
            value={visibilityDisabled ? 'private' : visibility}
          />
          <label className="grid gap-1.5">
            <FieldLabel>이름</FieldLabel>
            <Input autoFocus onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              취소
            </Button>
            <Button disabled={!name.trim() || mutation.isPending} type="submit">
              {mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}저장
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function optionalNumber(value: string) {
  if (!value.trim()) return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('조건 값은 유효한 숫자여야 합니다.')
  return number
}

type ComponentInput = string | ComponentInput[]

type RelationSampleInput = {
  input: ComponentInput
  output: ComponentInput
}

function emptyComponentInput(shape: readonly number[]): ComponentInput {
  if (shape.length === 0) return ''
  return Array.from({ length: shape[0] }, () => emptyComponentInput(shape.slice(1)))
}

function componentInputFromValue(value: unknown, shape: readonly number[]): ComponentInput {
  if (shape.length === 0) return typeof value === 'number' ? String(value) : ''
  if (!Array.isArray(value)) return emptyComponentInput(shape)
  return Array.from({ length: shape[0] }, (_, index) => componentInputFromValue(value[index], shape.slice(1)))
}

function componentInputValid(value: ComponentInput): boolean {
  if (Array.isArray(value)) return value.every(componentInputValid)
  return !value.trim() || Number.isFinite(Number(value))
}

function parseComponentInput(value: ComponentInput, shape: readonly number[], label: string): unknown {
  if (shape.length === 0) {
    if (Array.isArray(value)) throw new Error(`${label} 값의 형식이 올바르지 않습니다.`)
    if (!value.trim()) return 0
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${label} 값은 유효한 숫자여야 합니다.`)
    return number
  }
  if (!Array.isArray(value) || value.length !== shape[0]) {
    throw new Error(`${label} 값의 컴포넌트 수가 올바르지 않습니다.`)
  }
  return value.map((component, index) => parseComponentInput(component, shape.slice(1), `${label}[${index}]`))
}

function matrixGroupValue(value: ComponentInput, diagonal: boolean) {
  if (!Array.isArray(value)) return ''
  const group: string[] = []
  value.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return
    row.forEach((component, columnIndex) => {
      if ((rowIndex === columnIndex) === diagonal && typeof component === 'string') group.push(component)
    })
  })
  if (!group.length) return ''
  const first = group[0]
  return group.every((component) => component === first) ? first : ''
}

function setMatrixGroup(value: ComponentInput, diagonal: boolean, next: string): ComponentInput {
  const matrix = Array.isArray(value) ? value : (emptyComponentInput([3, 3]) as ComponentInput[])
  const component = next.trim() ? next : '0'
  return matrix.map((row, rowIndex) => {
    const components = Array.isArray(row) ? row : (emptyComponentInput([3]) as ComponentInput[])
    return components.map((current, columnIndex) => ((rowIndex === columnIndex) === diagonal ? component : current))
  })
}

function ComponentInputs({
  label,
  onChange,
  shape,
  showMatrixShortcuts = true,
  value,
}: {
  label: string
  onChange: (value: ComponentInput) => void
  shape: readonly number[]
  showMatrixShortcuts?: boolean
  value: ComponentInput
}) {
  if (shape.length === 0) {
    return (
      <Input
        aria-label={label}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        placeholder="0"
        value={Array.isArray(value) ? '' : value}
      />
    )
  }

  const components = Array.isArray(value) ? value : (emptyComponentInput(shape) as ComponentInput[])
  const isMatrix = showMatrixShortcuts && shape.length === 2 && shape[0] === 3 && shape[1] === 3
  return (
    <div className="grid gap-3">
      {isMatrix ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <FieldLabel>Diagonal</FieldLabel>
            <Input
              aria-label={`${label} Diagonal`}
              inputMode="decimal"
              onChange={(event) => onChange(setMatrixGroup(components, true, event.target.value))}
              placeholder="0"
              value={matrixGroupValue(components, true)}
            />
          </label>
          <label className="grid gap-1.5">
            <FieldLabel>Off diagonal</FieldLabel>
            <Input
              aria-label={`${label} Off diagonal`}
              inputMode="decimal"
              onChange={(event) => onChange(setMatrixGroup(components, false, event.target.value))}
              placeholder="0"
              value={matrixGroupValue(components, false)}
            />
          </label>
        </div>
      ) : null}
      <div aria-label={label} className="grid grid-cols-3 gap-2" role="group">
        {components.map((component, index) => (
          <div className={shape.length > 1 ? 'rounded-md border bg-muted/20 p-2' : ''} key={index}>
            <span className="mb-1 block text-[10px] text-muted-foreground">[{index}]</span>
            <ComponentInputs
              label={`${label} [${index}]`}
              onChange={(next) =>
                onChange(components.map((current, currentIndex) => (currentIndex === index ? next : current)))
              }
              shape={shape.slice(1)}
              showMatrixShortcuts={false}
              value={component}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function relationSamples(
  definition: MaterialModelDefinition,
  catalog: CatalogRuntimeSlice,
  value?: ReturnType<typeof readMaterialRelationValue>,
): RelationSampleInput[] {
  const inputShape = getQuantityValueConfig(definition.input.quantity_kind, catalog).shape
  const outputShape = getQuantityValueConfig(definition.output.quantity_kind, catalog).shape
  if (value) {
    return value.input.values.map((input, index) => ({
      input: componentInputFromValue(input, inputShape),
      output: componentInputFromValue(value.output.values[index], outputShape),
    }))
  }
  return Array.from({ length: definition.minimum_samples }, () => ({
    input: emptyComponentInput(inputShape),
    output: emptyComponentInput(outputShape),
  }))
}

export function MaterialParameterDialog({
  catalog,
  initialName,
  material,
  onOpenChange,
  open,
  record,
  user,
}: {
  catalog: CatalogRuntimeSlice
  initialName?: string
  material: MaterialRecord
  onOpenChange: (open: boolean) => void
  open: boolean
  record?: MaterialParameterRecord
  user: UserData
}) {
  const queryClient = useQueryClient()
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogRuntimeSlice | null>(null)
  const activeCatalog = selectedCatalog ?? catalog
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [name, setName] = useState('')
  const [dtype, setDtype] = useState<FloatDataDType>('float32')
  const [unit, setUnit] = useState('')
  const [componentValue, setComponentValue] = useState<ComponentInput>('')
  const [relationInputUnit, setRelationInputUnit] = useState('')
  const [relationOutputUnit, setRelationOutputUnit] = useState('')
  const [samples, setSamples] = useState<RelationSampleInput[]>([])
  const [incompatibleValue, setIncompatibleValue] = useState(false)
  const [source, setSource] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [temperature, setTemperature] = useState('')
  const [pressure, setPressure] = useState('')
  const [frequency, setFrequency] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [formError, setFormError] = useState('')
  useEffect(() => {
    if (!open) return
    setSelectedCatalog(null)
    const nextName = record?.name ?? initialName ?? ''
    const property = getMaterialProperty(nextName, catalog)
    const model = getMaterialModel(nextName, catalog)
    setName(nextName)
    setDtype('float32')
    setUnit('')
    setComponentValue('')
    setRelationInputUnit('')
    setRelationOutputUnit('')
    setSamples([])
    setIncompatibleValue(false)
    if (property) {
      const config = getQuantityValueConfig(property.quantity_kind, catalog)
      const stored = record ? readMaterialPropertyValue(property, record.value, catalog) : null
      setDtype(stored?.dtype ?? 'float32')
      setUnit(stored?.unit ?? config.units[0] ?? '')
      setComponentValue(
        stored ? componentInputFromValue(stored.value, config.shape) : emptyComponentInput(config.shape),
      )
      setIncompatibleValue(Boolean(record && !stored))
    } else if (model) {
      const inputConfig = getQuantityValueConfig(model.input.quantity_kind, catalog)
      const outputConfig = getQuantityValueConfig(model.output.quantity_kind, catalog)
      const stored = record ? readMaterialRelationValue(model, record.value, catalog) : null
      setRelationInputUnit(stored?.input.unit ?? inputConfig.units[0] ?? '')
      setRelationOutputUnit(stored?.output.unit ?? outputConfig.units[0] ?? '')
      setSamples(relationSamples(model, catalog, stored))
      setIncompatibleValue(Boolean(record && !stored))
    } else {
      setIncompatibleValue(Boolean(record))
    }
    setSource(record?.source ?? '')
    setVersion(record?.version ?? '')
    setDescription(record?.description ?? '')
    setTemperature(record?.temperature === null || record?.temperature === undefined ? '' : String(record.temperature))
    setPressure(record?.pressure === null || record?.pressure === undefined ? '' : String(record.pressure))
    setFrequency(
      property?.special_qualifiers?.some(
        (qualifier) => qualifier === 'frequency' || qualifier === 'wavelength_or_frequency',
      ) && record?.frequency !== null && record?.frequency !== undefined
        ? String(record.frequency)
        : '',
    )
    setVisibility(defaultVisibility(material, user, record?.user_id))
    setFormError('')
  }, [catalog, initialName, material, open, record, user])

  const selectCatalogName = async (entry: MaterialCatalogEntry) => {
    const slice = await catalogApi.runtimeSlice({
      solvers: [],
      quantityKinds: [],
      materialParameters: entry.kind === 'parameter' ? [entry.key] : [],
      materialModels: entry.kind === 'model' ? [entry.key] : [],
    })
    const mergedCatalog: CatalogRuntimeSlice = {
      ...slice,
      solvers: catalog.solvers,
      quantityKinds: [
        ...new Map([...catalog.quantityKinds, ...slice.quantityKinds].map((item) => [item.name, item])).values(),
      ],
      materialParameters: [
        ...new Map(
          [...catalog.materialParameters, ...slice.materialParameters].map((item) => [item.key, item]),
        ).values(),
      ],
      materialModels: [
        ...new Map([...catalog.materialModels, ...slice.materialModels].map((item) => [item.key, item])).values(),
      ],
      materialGlobalQualifiers: [...new Set([...catalog.materialGlobalQualifiers, ...slice.materialGlobalQualifiers])],
      warnings: [...new Set([...catalog.warnings, ...slice.warnings])],
    }
    const nextName = entry.key
    const property = getMaterialProperty(nextName, mergedCatalog)
    const model = getMaterialModel(nextName, mergedCatalog)
    setSelectedCatalog(mergedCatalog)
    setName(nextName)
    setDtype('float32')
    setIncompatibleValue(false)
    setFrequency('')
    if (property) {
      const config = getQuantityValueConfig(property.quantity_kind, mergedCatalog)
      setUnit(config.units[0] ?? '')
      setComponentValue(emptyComponentInput(config.shape))
      setRelationInputUnit('')
      setRelationOutputUnit('')
      setSamples([])
    } else if (model) {
      const inputConfig = getQuantityValueConfig(model.input.quantity_kind, mergedCatalog)
      const outputConfig = getQuantityValueConfig(model.output.quantity_kind, mergedCatalog)
      setUnit('')
      setComponentValue('')
      setRelationInputUnit(inputConfig.units[0] ?? '')
      setRelationOutputUnit(outputConfig.units[0] ?? '')
      setSamples(relationSamples(model, mergedCatalog))
    }
  }

  const property = getMaterialProperty(name, activeCatalog)
  const model = getMaterialModel(name, activeCatalog)
  const propertyConfig = property ? getQuantityValueConfig(property.quantity_kind, activeCatalog) : null
  const relationInputConfig = model ? getQuantityValueConfig(model.input.quantity_kind, activeCatalog) : null
  const relationOutputConfig = model ? getQuantityValueConfig(model.output.quantity_kind, activeCatalog) : null
  const frequencySupported = Boolean(
    property?.special_qualifiers?.some(
      (qualifier) => qualifier === 'frequency' || qualifier === 'wavelength_or_frequency',
    ),
  )
  const frequencyValid =
    !frequency.trim() || (Number.isFinite(Number(frequency)) && Number(frequency) > 0 && frequencySupported)
  const mutation = useMutation({
    mutationFn: async () => {
      if (!isMaterialCatalogKey(name, activeCatalog)) throw new Error('카탈로그에서 Material parameter를 선택하세요.')
      const normalizedFrequency = optionalNumber(frequency)
      if (normalizedFrequency !== null && (!frequencySupported || normalizedFrequency <= 0)) {
        throw new Error('Frequency는 지원되는 Material parameter에 양의 유한 Hz 값으로 입력해야 합니다.')
      }
      let value: unknown
      if (property && propertyConfig) {
        value = createMaterialPropertyValue(
          property,
          dtype,
          parseComponentInput(componentValue, propertyConfig.shape, 'Material parameter'),
          unit,
          activeCatalog,
        )
      } else if (model && relationInputConfig && relationOutputConfig) {
        if (samples.length < model.minimum_samples) {
          throw new Error(`${model.label_ko}에는 최소 ${model.minimum_samples}개의 샘플이 필요합니다.`)
        }
        value = createMaterialRelationValue(
          model,
          relationInputUnit,
          relationOutputUnit,
          samples.map((sample, index) =>
            parseComponentInput(sample.input, relationInputConfig.shape, `샘플 ${index + 1} input`),
          ),
          samples.map((sample, index) =>
            parseComponentInput(sample.output, relationOutputConfig.shape, `샘플 ${index + 1} output`),
          ),
          activeCatalog,
        )
      } else {
        throw new Error('카탈로그에서 Material parameter를 다시 선택하세요.')
      }
      return dbTables.MaterialParameter.upsertRow([
        {
          ...(record ?? {}),
          material_id: material.id!,
          name,
          value,
          source: source.trim() || null,
          version: version.trim() || null,
          description: description.trim() || null,
          temperature: optionalNumber(temperature),
          pressure: optionalNumber(pressure),
          frequency: normalizedFrequency,
          user_id: childOwnerId(material, user, visibility, record?.user_id),
        },
      ])
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['materials'] })
      toast.success(record ? 'Material parameter를 저장했습니다.' : 'Material parameter를 추가했습니다.')
      onOpenChange(false)
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : 'Material parameter를 저장하지 못했습니다.'),
  })
  const visibilityDisabled = !isAdmin(user) || material.user_id !== null
  const validName = isMaterialCatalogKey(name, activeCatalog)
  const valueComplete =
    property && propertyConfig
      ? propertyConfig.units.length > 0 && Boolean(unit) && componentInputValid(componentValue)
      : model && relationInputConfig && relationOutputConfig
        ? relationInputConfig.units.length > 0 &&
          relationOutputConfig.units.length > 0 &&
          Boolean(relationInputUnit) &&
          Boolean(relationOutputUnit) &&
          samples.length >= model.minimum_samples &&
          samples.every((sample) => componentInputValid(sample.input) && componentInputValid(sample.output))
        : false
  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <form
            className="grid gap-5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              setFormError('')
              mutation.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>{record ? 'Material parameter 편집' : 'Material parameter 추가'}</DialogTitle>
              <DialogDescription>카탈로그의 Quantity Kind에 맞춰 값과 unit을 등록합니다.</DialogDescription>
            </DialogHeader>
            <VisibilityField
              disabled={visibilityDisabled}
              onChange={setVisibility}
              value={visibilityDisabled ? 'private' : visibility}
            />
            <div className="grid gap-1.5">
              <FieldLabel>카탈로그 항목</FieldLabel>
              <Button
                className="h-auto min-h-9 justify-start whitespace-normal"
                onClick={() => setCatalogOpen(true)}
                type="button"
                variant="outline"
              >
                <Search />
                {name || 'Material parameter를 선택하세요'}
              </Button>
              {name && !validName ? (
                <p className="text-xs text-destructive">카탈로그 밖 key입니다. 저장하려면 새 항목을 선택하세요.</p>
              ) : null}
            </div>
            {incompatibleValue ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                <p className="font-medium">기존 값이 현재 구조화 형식과 호환되지 않습니다.</p>
                <p className="mt-1 text-xs">저장하면 아래 폼의 값으로 교체되며, 빈 값은 0으로 처리됩니다.</p>
                <pre
                  aria-label="기존 저장 값"
                  className="mt-2 max-h-28 overflow-auto rounded bg-white/70 p-2 text-[11px]"
                >
                  {JSON.stringify(record?.value, null, 2)}
                </pre>
              </div>
            ) : null}
            {property && propertyConfig ? (
              <div className="grid gap-4 rounded-lg border p-4">
                <div>
                  <p className="text-sm font-semibold">일반 Material property</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Quantity Kind · {property.quantity_kind} · component shape {JSON.stringify(propertyConfig.shape)}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <FieldLabel>Dtype</FieldLabel>
                    <Select
                      key={`${name}-dtype`}
                      onValueChange={(value) => setDtype(value as FloatDataDType)}
                      value={dtype}
                    >
                      <SelectTrigger aria-label="Dtype">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {materialFloatDTypes.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="grid gap-1.5">
                    <FieldLabel>Unit</FieldLabel>
                    <Select
                      disabled={!propertyConfig.units.length}
                      key={`${name}-unit`}
                      onValueChange={setUnit}
                      value={unit}
                    >
                      <SelectTrigger aria-label="Unit">
                        <SelectValue placeholder="사용 가능한 unit 없음" />
                      </SelectTrigger>
                      <SelectContent>
                        {propertyConfig.units.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                {!propertyConfig.units.length ? (
                  <p className="text-xs text-destructive">
                    이 Quantity Kind에는 선택 가능한 unit이 없어 저장할 수 없습니다.
                  </p>
                ) : null}
                <div className="grid gap-1.5">
                  <FieldLabel>Value</FieldLabel>
                  <ComponentInputs
                    label="Value"
                    onChange={setComponentValue}
                    shape={propertyConfig.shape}
                    value={componentValue}
                  />
                  <p className="text-xs text-muted-foreground">빈 값은 0으로 저장됩니다.</p>
                </div>
              </div>
            ) : null}
            {model && relationInputConfig && relationOutputConfig ? (
              <div className="grid gap-4 rounded-lg border p-4">
                <div>
                  <p className="text-sm font-semibold">Sampled relation</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    최소 {model.minimum_samples}개 샘플 · 계산 dtype float64 · identity basis
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <FieldLabel>Input unit · {model.input.quantity_kind}</FieldLabel>
                    <Select
                      disabled={!relationInputConfig.units.length}
                      key={`${name}-input-unit`}
                      onValueChange={setRelationInputUnit}
                      value={relationInputUnit}
                    >
                      <SelectTrigger aria-label="Input unit">
                        <SelectValue placeholder="사용 가능한 unit 없음" />
                      </SelectTrigger>
                      <SelectContent>
                        {relationInputConfig.units.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="grid gap-1.5">
                    <FieldLabel>Output unit · {model.output.quantity_kind}</FieldLabel>
                    <Select
                      disabled={!relationOutputConfig.units.length}
                      key={`${name}-output-unit`}
                      onValueChange={setRelationOutputUnit}
                      value={relationOutputUnit}
                    >
                      <SelectTrigger aria-label="Output unit">
                        <SelectValue placeholder="사용 가능한 unit 없음" />
                      </SelectTrigger>
                      <SelectContent>
                        {relationOutputConfig.units.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                {!relationInputConfig.units.length || !relationOutputConfig.units.length ? (
                  <p className="text-xs text-destructive">
                    입력 또는 출력 Quantity Kind에 선택 가능한 unit이 없습니다.
                  </p>
                ) : null}
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">빈 값은 0으로 저장됩니다.</p>
                  {samples.map((sample, index) => (
                    <div className="grid gap-3 rounded-md border bg-muted/10 p-3" key={index}>
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">샘플 {index + 1}</p>
                        <Button
                          aria-label={`샘플 ${index + 1} 삭제`}
                          disabled={samples.length <= model.minimum_samples}
                          onClick={() =>
                            setSamples((current) => current.filter((_, sampleIndex) => sampleIndex !== index))
                          }
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div className="grid gap-1.5">
                          <FieldLabel>{model.input.name}</FieldLabel>
                          <ComponentInputs
                            label={`샘플 ${index + 1} Input value`}
                            onChange={(value) =>
                              setSamples((current) =>
                                current.map((item, sampleIndex) =>
                                  sampleIndex === index ? { ...item, input: value } : item,
                                ),
                              )
                            }
                            shape={relationInputConfig.shape}
                            value={sample.input}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <FieldLabel>{model.output.name}</FieldLabel>
                          <ComponentInputs
                            label={`샘플 ${index + 1} Output value`}
                            onChange={(value) =>
                              setSamples((current) =>
                                current.map((item, sampleIndex) =>
                                  sampleIndex === index ? { ...item, output: value } : item,
                                ),
                              )
                            }
                            shape={relationOutputConfig.shape}
                            value={sample.output}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button
                    onClick={() =>
                      setSamples((current) => [
                        ...current,
                        {
                          input: emptyComponentInput(relationInputConfig.shape),
                          output: emptyComponentInput(relationOutputConfig.shape),
                        },
                      ])
                    }
                    type="button"
                    variant="outline"
                  >
                    <Plus />
                    샘플 추가
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <FieldLabel>Source</FieldLabel>
                <Input onChange={(event) => setSource(event.target.value)} value={source} />
              </label>
              <label className="grid gap-1.5">
                <FieldLabel>Version</FieldLabel>
                <Input onChange={(event) => setVersion(event.target.value)} value={version} />
              </label>
            </div>
            <label className="grid gap-1.5">
              <FieldLabel>설명</FieldLabel>
              <Input onChange={(event) => setDescription(event.target.value)} value={description} />
            </label>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-1.5">
                <FieldLabel>Temperature</FieldLabel>
                <Input
                  inputMode="decimal"
                  onChange={(event) => setTemperature(event.target.value)}
                  value={temperature}
                />
              </label>
              <label className="grid gap-1.5">
                <FieldLabel>Pressure</FieldLabel>
                <Input inputMode="decimal" onChange={(event) => setPressure(event.target.value)} value={pressure} />
              </label>
              <label className="grid gap-1.5">
                <FieldLabel>Frequency (Hz)</FieldLabel>
                <Input
                  aria-label="Frequency (Hz)"
                  disabled={!frequencySupported}
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => setFrequency(event.target.value)}
                  value={frequency}
                />
                {!frequencySupported ? (
                  <span className="text-xs text-muted-foreground">
                    frequency qualifier를 지원하는 Material property에서만 사용할 수 있습니다.
                  </span>
                ) : null}
              </label>
            </div>
            {formError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                취소
              </Button>
              <Button disabled={!validName || !valueComplete || !frequencyValid || mutation.isPending} type="submit">
                {mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}저장
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <MaterialCatalogPickerDialog onOpenChange={setCatalogOpen} onSelect={selectCatalogName} open={catalogOpen} />
    </>
  )
}

export function QualifierDialog({
  catalog,
  onOpenChange,
  open,
  parameter,
  record,
}: {
  catalog: CatalogRuntimeSlice
  onOpenChange: (open: boolean) => void
  open: boolean
  parameter: MaterialParameterRecord
  record?: MaterialParameterQualifierRecord
}) {
  const queryClient = useQueryClient()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const names = getQualifierNames(parameter.name, catalog)
  const validName = names.includes(name)
  const dedicated = isDedicatedQualifierName(name)
  useEffect(() => {
    if (open) {
      setName(record?.name ?? '')
      setValue(record ? String(record.value) : '')
    }
  }, [open, record])
  const mutation = useMutation({
    mutationFn: () => {
      if (!validName) throw new Error('카탈로그에서 qualifier를 선택하세요.')
      const parsedValue = Number(value)
      if (!Number.isFinite(parsedValue)) throw new Error('Qualifier 값은 유효한 숫자여야 합니다.')
      return dbTables.MaterialParameterQualifier.upsertRow([
        {
          ...(record ?? {}),
          material_parameter_id: parameter.id!,
          name,
          value: parsedValue,
        },
      ])
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['materials'] })
      toast.success(record ? 'Qualifier를 저장했습니다.' : 'Qualifier를 추가했습니다.')
      onOpenChange(false)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Qualifier를 저장하지 못했습니다.'),
  })
  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>{record ? 'Qualifier 편집' : 'Qualifier 추가'}</DialogTitle>
              <DialogDescription>{parameter.name}에 적용할 숫자 조건을 등록합니다.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <FieldLabel>카탈로그 항목</FieldLabel>
              <Button className="justify-start" onClick={() => setCatalogOpen(true)} type="button" variant="outline">
                <Search />
                {name || 'Qualifier를 선택하세요'}
              </Button>
              {name && !validName ? (
                <p className="text-xs text-destructive">
                  {dedicated
                    ? '전용 필드로 관리되는 qualifier입니다. 이 레코드는 삭제할 수 있습니다.'
                    : '카탈로그 밖 qualifier입니다. 저장하려면 새 항목을 선택하세요.'}
                </p>
              ) : null}
            </div>
            <label className="grid gap-1.5">
              <FieldLabel>값</FieldLabel>
              <Input inputMode="decimal" onChange={(event) => setValue(event.target.value)} value={value} />
            </label>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                취소
              </Button>
              <Button disabled={!validName || !value.trim() || mutation.isPending} type="submit">
                {mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}저장
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <QualifierCatalogPickerDialog names={names} onOpenChange={setCatalogOpen} onSelect={setName} open={catalogOpen} />
    </>
  )
}
