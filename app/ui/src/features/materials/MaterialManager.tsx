import { useState } from 'react'
import { MaterialDetail } from './MaterialDetailPage'
import { MaterialList } from './MaterialListPage'

export function MaterialManager({
  materialId,
  onMaterialIdChange,
  onRequestLogin,
  scope = 'visible',
}: {
  materialId?: number | null
  onMaterialIdChange?: (id: number | null) => void
  onRequestLogin?: () => void
  scope?: 'visible' | 'mine' | 'public'
}) {
  const [internalMaterialId, setInternalMaterialId] = useState<number | null>(materialId ?? null)
  const selectedMaterialId = materialId === undefined ? internalMaterialId : materialId
  const selectMaterial = (id: number | null) => {
    if (materialId === undefined) setInternalMaterialId(id)
    onMaterialIdChange?.(id)
  }

  return selectedMaterialId === null ? (
    <MaterialList embedded scope={scope} onSelectMaterial={selectMaterial} />
  ) : (
    <MaterialDetail
      embedded
      key={selectedMaterialId}
      materialId={selectedMaterialId}
      onBack={() => selectMaterial(null)}
      onRequestLogin={onRequestLogin}
    />
  )
}
