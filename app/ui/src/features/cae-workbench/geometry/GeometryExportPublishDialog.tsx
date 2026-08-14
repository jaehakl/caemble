import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
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
import {
  analyzeGeometrySource,
  compileCadDocument,
  createCadSourceDocument,
  createExperimentSourceBundle,
  projectGeometryExportSource,
  type LocalGeometryCoordinate,
} from '@/lib/cad'
import type { GeometryWorkspaceState } from './useGeometryWorkspaceState'

const slugPattern = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?'

function packageName(exportName: string) {
  return (
    exportName
      .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
      .replace(/_/gu, '-')
      .toLowerCase()
      .slice(0, 64)
      .replace(/-+$/gu, '') || 'geometry'
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export function GeometryExportPublishDialog({
  geometry,
  onOpenChange,
  open,
}: {
  geometry: GeometryWorkspaceState
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [sourceSnapshot, setSourceSnapshot] = useState('')
  const [exportName, setExportName] = useState('')
  const [repositoryId, setRepositoryId] = useState<number | null>(null)
  const [repository, setRepository] = useState('common')
  const [targetPackage, setTargetPackage] = useState('')
  const [description, setDescription] = useState('')
  const [namespaceInput, setNamespaceInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasOpen = useRef(false)
  const [published, setPublished] = useState<{
    coordinate: string
    snippet: string
    stageError: string | null
  } | null>(null)
  const { entryExports, entrySource, namespace, refreshRepositories } = geometry

  useEffect(() => {
    if (open && !wasOpen.current) {
      const firstExport = entryExports[0] ?? ''
      setSourceSnapshot(entrySource)
      setExportName(firstExport)
      setRepositoryId(null)
      setRepository('common')
      setTargetPackage(packageName(firstExport))
      setDescription('')
      setNamespaceInput(namespace ?? '')
      setError(null)
      setPublished(null)
      void refreshRepositories().catch(() => undefined)
    }
    wasOpen.current = open
  }, [entryExports, entrySource, namespace, open, refreshRepositories])

  const projection = useMemo(() => {
    if (!sourceSnapshot || !exportName)
      return { error: '업로드할 Geometry export가 없습니다.', imports: [], source: '' }
    try {
      const source = projectGeometryExportSource(sourceSnapshot, exportName)
      return {
        error: null,
        imports: analyzeGeometrySource(source).imports,
        source,
      }
    } catch (cause) {
      return { error: errorMessage(cause), imports: [], source: '' }
    }
  }, [exportName, sourceSnapshot])

  const selectedRepository = geometry.repositories.find((item) => item.id === repositoryId) ?? null
  const repositorySlug = selectedRepository?.slug ?? repository
  const targetNamespace = selectedRepository?.namespace ?? namespace

  const setNamespace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await geometry.setNamespace(namespaceInput.trim())
      toast.success('기본 Geometry namespace를 설정했습니다.')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (entrySource !== sourceSnapshot) {
      setError('팝업을 연 뒤 geometry.tsx가 변경되었습니다. 팝업을 닫고 다시 열어 최신 source를 확인하세요.')
      return
    }
    if (!projection.source || projection.error || !targetNamespace) {
      setError(projection.error ?? 'Geometry 발행 정보를 확인하세요.')
      return
    }
    const coordinate =
      `caemble:geometry/${targetNamespace}/${repositorySlug}/${targetPackage}@local` as LocalGeometryCoordinate
    setSubmitting(true)
    try {
      const files = {
        'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })
`,
        'geometry.tsx': `import { ${exportName} } from ${JSON.stringify(coordinate)}
export { ${exportName} }
`,
        'material.tsx': 'export {}\n',
        'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        'tasks/preview.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'preview', version: '1.0.0' }, config: () => ({}) })
`,
      }
      const document = createCadSourceDocument(
        'experiment',
        createExperimentSourceBundle(files, geometry.currentSnapshot),
      )
      await compileCadDocument(document, {
        geometryDrafts: { ...geometry.draftOverlay, [coordinate]: { source: projection.source } },
      })
      const result = await geometry.publishNewGeometry({
        description,
        exportName,
        packageName: targetPackage,
        repository: repositorySlug,
        repositoryId,
        source: projection.source,
      })
      setPublished({
        coordinate: result.version.coordinate,
        snippet: `import { ${exportName} } from ${JSON.stringify(result.version.coordinate)}`,
        stageError: result.stageError,
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const copy = () => {
    if (!published) return
    void navigator.clipboard
      .writeText(published.snippet)
      .then(() => toast.success('Geometry import 코드를 복사했습니다.'))
      .catch((cause: unknown) => toast.error(errorMessage(cause)))
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-3xl">
        {published ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Geometry 발행 완료</DialogTitle>
              <DialogDescription>
                새 exact Version을 발행했습니다. 현재 geometry.tsx source는 변경하지 않았습니다.
              </DialogDescription>
            </DialogHeader>
            <p className="font-mono text-xs break-all text-muted-foreground">{published.coordinate}</p>
            <pre className="overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
              <code>{published.snippet}</code>
            </pre>
            <p className="text-xs text-muted-foreground">
              현재 파일에는 같은 이름의 local declaration이 남아 있습니다. 이 파일에 import하려면 기존 선언을 제거하거나
              alias를 사용하세요.
            </p>
            {published.stageError ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" role="alert">
                DB 발행은 완료됐지만 Workbench staging을 갱신하지 못했습니다. 다시 불러온 뒤 사용하세요.{' '}
                {published.stageError}
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={copy} type="button" variant="outline">
                코드 복사
              </Button>
              <Button onClick={() => onOpenChange(false)} type="button">
                닫기
              </Button>
            </DialogFooter>
          </div>
        ) : !namespace ? (
          <form className="grid gap-4" onSubmit={setNamespace}>
            <DialogHeader>
              <DialogTitle>기본 Geometry namespace 설정</DialogTitle>
              <DialogDescription>새 Geometry를 발행하기 전에 사용자 namespace가 필요합니다.</DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              Namespace
              <Input
                autoFocus
                maxLength={32}
                minLength={3}
                onChange={(event) => setNamespaceInput(event.target.value)}
                pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
                required
                value={namespaceInput}
              />
            </label>
            {error ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button disabled={submitting} type="submit">
                Namespace 설정
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form className="grid max-h-[85dvh] gap-4 overflow-auto pr-1" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Publish geometry.tsx Export</DialogTitle>
              <DialogDescription>
                named export 하나와 필요한 선언·exact import만 새 Geometry Version 0.1.0으로 발행합니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Export
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  onChange={(event) => {
                    setExportName(event.target.value)
                    setTargetPackage(packageName(event.target.value))
                    setError(null)
                  }}
                  required
                  value={exportName}
                >
                  {entryExports.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Initial version
                <Input readOnly value="0.1.0" />
              </label>
              <label className="grid gap-1 text-sm">
                Existing Repository
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  onChange={(event) => setRepositoryId(Number(event.target.value) || null)}
                  value={repositoryId ?? ''}
                >
                  <option value="">현재 namespace의 새 Repository</option>
                  {geometry.repositories
                    .filter((item) => item.archived_at === null)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.namespace}/{item.slug}
                      </option>
                    ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Repository slug
                <Input
                  disabled={selectedRepository !== null}
                  maxLength={64}
                  onChange={(event) => setRepository(event.target.value)}
                  pattern={slugPattern}
                  required
                  value={repositorySlug}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Package name
                <Input
                  maxLength={64}
                  onChange={(event) => setTargetPackage(event.target.value)}
                  pattern={slugPattern}
                  required
                  value={targetPackage}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <Input maxLength={2_000} onChange={(event) => setDescription(event.target.value)} value={description} />
              </label>
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="font-mono break-all">
                caemble:geometry/{targetNamespace}/{repositorySlug}/{targetPackage}@0.1.0
              </p>
              <p>
                Exact dependencies:{' '}
                {projection.imports.length
                  ? projection.imports.map((item) => `${item.alias} → ${item.coordinate}`).join(', ')
                  : '없음'}
              </p>
            </div>
            <label className="grid gap-1 text-sm">
              Reconstructed TSX source
              <textarea
                className="min-h-72 resize-y rounded-md border bg-muted/20 p-3 font-mono text-xs"
                readOnly
                spellCheck={false}
                value={projection.source}
              />
            </label>
            {projection.error || error ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {error ?? projection.error}
              </p>
            ) : null}
            <DialogFooter>
              <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="outline">
                취소
              </Button>
              <Button disabled={submitting || Boolean(projection.error)} type="submit">
                Geometry 발행
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
