import { GitFork } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { CatalogGeometryDetail } from '@/api/catalog'

export function GeometryExampleDetail({
  detail,
  authenticated,
  namespace,
  previewError,
  onFork,
  onAuthoringStateChange,
}: {
  detail: CatalogGeometryDetail
  authenticated: boolean
  namespace: string | null
  previewError: string | null
  onFork: () => void
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}) {
  return (
    <Card className="mx-auto flex min-h-[32rem] max-w-6xl flex-col overflow-hidden">
      <header className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-xl font-semibold">{detail.title}</h2>
              <Badge className="border-violet-300 bg-violet-100 text-violet-900">Example</Badge>
            </div>
            <p className="font-mono text-xs text-violet-700">
              Examples/{detail.repository}/{detail.key}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{detail.description}</p>
          </div>
          <Button
            disabled={!authenticated || !namespace}
            onClick={onFork}
            title={
              !authenticated
                ? '개인 Repository Fork는 로그인 후 사용할 수 있습니다.'
                : !namespace
                  ? '기본 Geometry namespace를 먼저 설정하세요.'
                  : undefined
            }
          >
            <GitFork /> 개인 Repository로 Fork
          </Button>
        </div>
        {!authenticated ? (
          <p className="text-xs text-muted-foreground">
            Examples는 미리보기만 제공됩니다. 로그인하면 개인 Repository로 Fork할 수 있습니다.
          </p>
        ) : !namespace ? (
          <p className="text-xs text-amber-700">Account에서 기본 Geometry namespace를 먼저 설정하세요.</p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <Badge>CAD API v{detail.cadApiVersion}</Badge>
          <Badge>module v{detail.moduleFormatVersion}</Badge>
          <Badge>{detail.exportName}</Badge>
          {detail.materialRoles.map((role) => (
            <Badge key={role.role}>{role.role}</Badge>
          ))}
        </div>
      </header>
      {previewError ? (
        <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          마지막 정상 Viewer scene을 유지합니다. {previewError}
        </div>
      ) : null}
      <div className="h-[28rem]">
        <CadEditor
          diagnostics={[]}
          modelPath={`file:///geometry-manager/official/${detail.key}.tsx`}
          onAuthoringStateChange={onAuthoringStateChange}
          onChange={() => undefined}
          readOnly
          value={detail.source}
        />
      </div>
    </Card>
  )
}
