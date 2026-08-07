import { BookOpenText, Clipboard, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/use-auth'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import { StructureExperimentViewer } from '@/features/viewer/workspace/StructureExperimentViewer'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import {
  cadSource,
  createCadSourceDocument,
  deserializeCadScene,
  type CadDocumentType,
  type CadSourceDocument,
  type EvaluatedDocumentSnapshot,
} from '@/lib/cad'
import { CAEMBLE_PROGRAM_EXAMPLE_SEED, caembleProgramExamples, type CaembleProgramExample } from '@/lib/examples'
import { resolveMaterialParameters } from '@/lib/material'

const defaultExample = caembleProgramExamples[0]

export function ExamplesPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const { exampleId } = useParams()
  const selectedExample = caembleProgramExamples.find((example) => example.id === exampleId) ?? defaultExample
  const [structure, setStructure] = useState<CadSourceDocument>(() =>
    createCadSourceDocument('structure', selectedExample.structureCode, CAEMBLE_PROGRAM_EXAMPLE_SEED),
  )
  const [experiment, setExperiment] = useState<CadSourceDocument>(() =>
    createCadSourceDocument(
      'experiment',
      selectedExample.experimentCode,
      CAEMBLE_PROGRAM_EXAMPLE_SEED,
      selectedExample.simulationCode,
    ),
  )
  const [activeDocumentType, setActiveDocumentType] = useState<CadDocumentType>('structure')
  const [pendingExample, setPendingExample] = useState<CaembleProgramExample | null>(null)

  const resetCurrentExample = useCallback(() => {
    setStructure(createCadSourceDocument('structure', selectedExample.structureCode, CAEMBLE_PROGRAM_EXAMPLE_SEED))
    setExperiment(
      createCadSourceDocument(
        'experiment',
        selectedExample.experimentCode,
        CAEMBLE_PROGRAM_EXAMPLE_SEED,
        selectedExample.simulationCode,
      ),
    )
    setActiveDocumentType('structure')
    setPendingExample(null)
  }, [selectedExample])

  useEffect(() => {
    if (exampleId !== selectedExample.id) {
      navigate(`/examples/${selectedExample.id}`, { replace: true })
    }
  }, [exampleId, navigate, selectedExample.id])

  useEffect(() => {
    resetCurrentExample()
  }, [resetCurrentExample])

  const resolveMaterials = useCallback(async (snapshot: EvaluatedDocumentSnapshot) => {
    const scene = deserializeCadScene(snapshot.scene)
    const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
    return resolveMaterialParameters(materials, [], [], { sourceOnly: true })
  }, [])
  const { experimentDocument, simulation, structureDocument } = useCadWorkspace(
    structure,
    experiment,
    setStructure,
    setExperiment,
    undefined,
    undefined,
    resolveMaterials,
    'fast-reroll',
    auth.isAuthenticated,
  )

  const dirty =
    cadSource(structure) !== selectedExample.structureCode || cadSource(experiment) !== selectedExample.experimentCode
  const structureViewerDocument = useMemo(
    () => ({
      scene: structureDocument.scene,
      sceneHash: structureDocument.sceneHash,
      variables: structureDocument.variables,
    }),
    [structureDocument.scene, structureDocument.sceneHash, structureDocument.variables],
  )
  const experimentViewerDocument = useMemo(
    () => ({
      scene: experimentDocument.scene,
      sceneHash: experimentDocument.sceneHash,
      variables: experimentDocument.variables,
    }),
    [experimentDocument.scene, experimentDocument.sceneHash, experimentDocument.variables],
  )
  const handleRenderStart = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderStart()
      if (sources.includes('experiment')) experimentDocument.handleRenderStart()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderEnd = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderEnd()
      if (sources.includes('experiment')) experimentDocument.handleRenderEnd()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderError = useCallback(
    (message: string, sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderError(message)
      if (sources.includes('experiment')) experimentDocument.handleRenderError(message)
    },
    [experimentDocument, structureDocument],
  )

  const copySource = useCallback(
    async (documentType: CadDocumentType) => {
      try {
        await navigator.clipboard.writeText(cadSource(documentType === 'structure' ? structure : experiment))
        toast.success(`${documentType === 'structure' ? 'Structure' : 'Experiment'} Source를 복사했습니다.`)
      } catch {
        toast.error('Source를 클립보드에 복사하지 못했습니다.')
      }
    },
    [experiment, structure],
  )

  return (
    <section
      aria-label="Caemble v3 Examples Playground"
      className="flex h-full min-h-0 flex-col overflow-auto bg-background lg:overflow-hidden"
    >
      <header className="shrink-0 border-b bg-background px-3 py-3 sm:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>검증된 v3 예제</Badge>
              <Badge className="border bg-white">dc-current-density@0.0.0</Badge>
              <Badge className="border bg-white">steady-state-heat@0.0.0</Badge>
              {dirty ? <Badge className="bg-amber-100 text-amber-900">수정됨</Badge> : null}
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="truncate text-lg font-semibold">{selectedExample.title}</h2>
              <p className="text-xs text-muted-foreground">{selectedExample.description}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-56 gap-1 text-xs font-medium text-muted-foreground">
              예제 선택
              <select
                aria-label="Experiment Program 예제 선택"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedExample.id}
                onChange={(event) => {
                  const next = caembleProgramExamples.find((example) => example.id === event.target.value)
                  if (!next || next.id === selectedExample.id) return
                  if (dirty) setPendingExample(next)
                  else navigate(`/examples/${next.id}`)
                }}
              >
                {caembleProgramExamples.map((example) => (
                  <option key={example.id} value={example.id}>
                    {example.title}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="outline" onClick={() => void copySource('structure')}>
              <Clipboard />
              Structure 복사
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copySource('experiment')}>
              <Clipboard />
              Experiment 복사
            </Button>
            <Button size="sm" variant="outline" onClick={resetCurrentExample}>
              <RotateCcw />
              전체 예제 초기화
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to="/docs?section=program">
                <BookOpenText />
                v3 가이드
              </Link>
            </Button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span className="font-semibold text-slate-800">학습 포인트</span>
            {selectedExample.concepts.map((concept) => (
              <span key={concept}>• {concept}</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span className="font-semibold text-slate-800">예상 결과</span>
            {selectedExample.verification.expectations.map((expectation) => (
              <span key={expectation}>• {expectation}</span>
            ))}
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(420px,46%)_minmax(0,1fr)] lg:overflow-hidden">
        <div className="min-h-[620px] min-w-0 border-b lg:h-full lg:min-h-0 lg:overflow-hidden lg:border-r lg:border-b-0">
          <StructureExperimentViewer
            activeDocumentType={activeDocumentType}
            experiment={experiment}
            experimentDocument={experimentDocument}
            structure={structure}
            structureDocument={structureDocument}
            onActiveDocumentTypeChange={setActiveDocumentType}
          />
        </div>
        <div className="min-h-[520px] min-w-0 lg:h-full lg:min-h-0">
          <CadViewer
            experiment={experimentViewerDocument}
            recordedData={simulation.recordedData}
            resultsLayout="tabs"
            simulation={{
              canRun: simulation.canRun,
              cancel: simulation.cancel,
              process: simulation.process,
              program: experimentDocument.simulationProgram,
              run: simulation.run,
              stale: simulation.stale,
            }}
            structure={structureViewerDocument}
            onRenderEnd={handleRenderEnd}
            onRenderError={handleRenderError}
            onRenderStart={handleRenderStart}
          />
        </div>
      </div>

      <Dialog open={pendingExample !== null} onOpenChange={(open) => !open && setPendingExample(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>수정한 예제를 바꿀까요?</DialogTitle>
            <DialogDescription>
              현재 Structure와 Experiment의 로컬 변경은 저장되지 않습니다. 선택한 예제의 검증된 원본 pair를 새로
              불러옵니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingExample(null)}>
              계속 편집
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingExample) navigate(`/examples/${pendingExample.id}`)
                setPendingExample(null)
              }}
            >
              변경 버리고 이동
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export const Component = ExamplesPage
