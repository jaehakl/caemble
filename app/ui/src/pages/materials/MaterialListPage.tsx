import type { ColumnDef } from '@tanstack/react-table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, LockKeyhole, Plus, Search } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { dbTables, type MaterialNameRecord, type MaterialRecord } from '@/api'
import { DataTable } from '@/components/DataTable'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import { MaterialColorField } from './MaterialColorField'
import { allRowsRequest, isMaterialColorValid, materialDisplayName } from './material-utils'
import { VisibilityField, type Visibility } from './VisibilityField'

type MaterialListRow = {
  aliases: string[]
  material: MaterialRecord
  name: string
}

const columns: ColumnDef<MaterialListRow, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Material',
    cell: ({ row }) => (
      <div>
        <div className="flex items-center gap-2">
          {row.original.material.color ? (
            <span
              aria-label={`색상 ${row.original.material.color}`}
              className="size-4 shrink-0 rounded-full border"
              style={{ backgroundColor: row.original.material.color }}
            />
          ) : null}
          <p className="font-medium">{row.original.name}</p>
          {row.original.material.color ? (
            <code className="text-xs text-muted-foreground">{row.original.material.color}</code>
          ) : null}
        </div>
        {row.original.aliases.length > 1 ? (
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{row.original.aliases.slice(1).join(', ')}</p>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: 'material.inchi',
    header: 'InChI',
    cell: ({ row }) => (
      <code className="line-clamp-2 max-w-xl text-xs text-muted-foreground">{row.original.material.inchi || '—'}</code>
    ),
  },
  {
    id: 'visibility',
    header: '범위',
    cell: ({ row }) => <Badge>{row.original.material.user_id === null ? 'Public' : 'Private'}</Badge>,
  },
]

function MaterialCreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { isAuthenticated, user } = useAuth()
  const isAdmin = Boolean(user?.roles.includes('admin'))
  const [inchi, setInchi] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')
  const [initialName, setInitialName] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('public')
  const [nameVisibility, setNameVisibility] = useState<Visibility>('public')

  const reset = () => {
    setInchi('')
    setDescription('')
    setColor('')
    setInitialName('')
    setVisibility(isAdmin ? 'public' : 'private')
    setNameVisibility(isAdmin ? 'public' : 'private')
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('로그인이 필요합니다.')
      const ownerId = isAdmin && visibility === 'public' ? null : user.id
      const [created] = await dbTables.Material.upsertRow([
        {
          inchi: inchi.trim() || null,
          description: description.trim() || null,
          color: color.trim().toLowerCase() || null,
          user_id: ownerId,
        },
      ])
      if (!created) throw new Error('Material 생성 결과가 없습니다.')

      const name = initialName.trim()
      if (name) {
        const initialNameOwner = ownerId !== null ? ownerId : isAdmin && nameVisibility === 'public' ? null : user.id
        try {
          await dbTables.MaterialName.upsertRow([{ material_id: created.id, name, user_id: initialNameOwner }])
        } catch (error) {
          try {
            await dbTables.Material.deleteRows([created.id])
          } catch {
            throw new Error('최초 이름 저장에 실패했고 생성된 Material을 정리하지 못했습니다.')
          }
          throw error
        }
      }
      return created.id
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ['materials'] })
      toast.success('Material을 생성했습니다.')
      reset()
      onOpenChange(false)
      navigate(`/materials/${id}`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Material을 생성하지 못했습니다.'),
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    createMutation.mutate()
  }

  const effectiveVisibility = isAdmin ? visibility : 'private'
  const colorValid = isMaterialColorValid(color)

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && !createMutation.isPending) reset()
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogContent>
        <form className="grid gap-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Material 추가</DialogTitle>
            <DialogDescription>InChI와 설명을 등록하고 첫 번째 이름을 함께 만들 수 있습니다.</DialogDescription>
          </DialogHeader>
          {!isAuthenticated ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Material을 추가하려면 로그인하세요.
            </div>
          ) : (
            <>
              <VisibilityField disabled={!isAdmin} onChange={setVisibility} value={effectiveVisibility} />
              <label className="grid gap-1.5 text-sm font-medium">
                InChI
                <Input onChange={(event) => setInchi(event.target.value)} placeholder="선택 사항" value={inchi} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                설명
                <textarea
                  className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="선택 사항"
                  value={description}
                />
              </label>
              <MaterialColorField onChange={setColor} value={color} />
              <label className="grid gap-1.5 text-sm font-medium">
                최초 이름
                <Input
                  onChange={(event) => setInitialName(event.target.value)}
                  placeholder="선택 사항"
                  value={initialName}
                />
              </label>
              {initialName.trim() && effectiveVisibility === 'public' ? (
                <VisibilityField
                  disabled={!isAdmin}
                  onChange={setNameVisibility}
                  value={isAdmin ? nameVisibility : 'private'}
                />
              ) : null}
            </>
          )}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              취소
            </Button>
            <Button disabled={!isAuthenticated || !colorValid || createMutation.isPending} type="submit">
              {createMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              생성
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function MaterialListPage() {
  const navigate = useNavigate()
  const { isAuthenticated } = useAuth()
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const request = useMemo(() => allRowsRequest(), [])
  const materialsQuery = useQuery({
    queryKey: ['materials', 'list'],
    queryFn: () => dbTables.Material.listRows(request),
  })
  const namesQuery = useQuery({
    queryKey: ['materials', 'names'],
    queryFn: () => dbTables.MaterialName.listRows(request),
  })

  const rows = useMemo(() => {
    const names = namesQuery.data?.items ?? []
    const needle = query.trim().toLocaleLowerCase()
    return (materialsQuery.data?.items ?? [])
      .filter((material): material is MaterialRecord & { id: number } => material.id !== undefined)
      .map((material) => {
        const aliases = names
          .filter((entry): entry is MaterialNameRecord => entry.material_id === material.id)
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right))
        return { aliases, material, name: materialDisplayName(material, names) }
      })
      .filter(
        ({ aliases, material }) =>
          !needle || [material.inchi ?? '', ...aliases].some((value) => value.toLocaleLowerCase().includes(needle)),
      )
  }, [materialsQuery.data, namesQuery.data, query])

  const loading = materialsQuery.isLoading || namesQuery.isLoading
  const failed = materialsQuery.isError || namesQuery.isError

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeader
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            {isAuthenticated ? <Plus /> : <LockKeyhole />}
            {isAuthenticated ? 'Material 추가' : '로그인 후 추가'}
          </Button>
        }
        description="공개 Material과 내 private Material의 이름, InChI, 물성 파라미터를 관리합니다."
        eyebrow={`${rows.length.toLocaleString()} materials`}
        title="Materials"
      />
      <Card className="overflow-hidden">
        <div className="border-b bg-muted/20 p-4">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Material 검색"
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Material 이름 또는 InChI 검색"
              value={query}
            />
          </div>
        </div>
        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="animate-spin" />
            Material 목록을 불러오는 중입니다.
          </div>
        ) : failed ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-destructive">
            Material 목록을 불러오지 못했습니다.
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            getRowKey={(row) => String(row.material.id)}
            onRowClick={(row) => navigate(`/materials/${row.material.id}`)}
          />
        )}
      </Card>
      <MaterialCreateDialog onOpenChange={setCreateOpen} open={createOpen} />
    </div>
  )
}

export const Component = MaterialListPage
