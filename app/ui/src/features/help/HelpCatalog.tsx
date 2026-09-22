import { ArrowLeft } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { helpHref, type HelpKindId } from '@/documentation/helpNavigation'

const GeometryCatalog = lazy(() =>
  import('@/features/catalog/cad/CadCatalogPage').then((module) => ({ default: module.GeometryCatalog })),
)
const MaterialCatalog = lazy(() =>
  import('@/features/catalog/materials/MaterialCatalogPage').then((module) => ({ default: module.MaterialCatalog })),
)
const QuantityCatalog = lazy(() =>
  import('@/features/catalog/quantity-kinds/QuantityKindCatalogPage').then((module) => ({
    default: module.QuantityCatalog,
  })),
)
const PhysicsCatalog = lazy(() =>
  import('@/features/catalog/solvers/SolverCatalogPage').then((module) => ({ default: module.PhysicsCatalog })),
)
const ExampleCatalog = lazy(() =>
  import('@/features/catalog/solvers/SolverCatalogPage').then((module) => ({
    default: module.ExampleExperimentCatalog,
  })),
)

export function HelpCatalog({
  kind,
  item,
  onNavigate,
}: {
  kind: HelpKindId
  item: string | null
  onNavigate: (href: string) => void
}) {
  return (
    <div className="help-catalog">
      <Suspense
        fallback={
          <p className="p-8 text-sm text-muted-foreground" role="status">
            카탈로그를 불러오고 있습니다…
          </p>
        }
      >
        {kind === 'geometry' ? (
          <GeometryCatalog embedded selectedKey={item} onSelectedKeyChange={(key) => onNavigate(helpHref(kind, key))} />
        ) : kind === 'materials' ? (
          <MaterialCatalog embedded selectedKey={item} onSelectedKeyChange={(key) => onNavigate(helpHref(kind, key))} />
        ) : kind === 'quantity-kinds' ? (
          <QuantityCatalog embedded selectedKey={item} onSelectedKeyChange={(key) => onNavigate(helpHref(kind, key))} />
        ) : kind === 'examples' ? (
          <ExampleCatalog
            embedded
            selectedKey={item}
            onSelect={(key) => onNavigate(helpHref('examples', key))}
            onSelectSolver={(name, version) => onNavigate(helpHref('solvers', `${name}@${version}`))}
          />
        ) : (
          <PhysicsCatalog
            embedded
            selectedKey={item}
            onSelectedKeyChange={(key) =>
              onNavigate(key.startsWith('experiment:') ? helpHref('examples', key.slice(11)) : helpHref('solvers', key))
            }
          />
        )}
        {item ? (
          <div className="px-6 pb-6">
            <Button variant="ghost" asChild>
              <a href={helpHref(kind)}>
                <ArrowLeft className="size-4" /> 목록으로 돌아가기
              </a>
            </Button>
          </div>
        ) : null}
      </Suspense>
    </div>
  )
}
