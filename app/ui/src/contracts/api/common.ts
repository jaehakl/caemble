export type GetListRequest = Readonly<{
  scope?: 'visible' | 'mine' | 'public'
  offset: number
  limit: number | null
  selected_ids: readonly number[]
  search_text: string | null
  text_filter: Readonly<Record<string, readonly string[]>>
  filter: Readonly<Record<string, readonly unknown[]>>
  null_filter?: Readonly<Record<string, 'is_null' | 'is_not_null'>>
  sort: readonly [string, 'asc' | 'desc'] | readonly (readonly [string, 'asc' | 'desc'])[] | null
  random?: boolean
  include_system?: boolean
}>

export type GetListResponse<TItem> = { items: TItem[]; total: number }

export type UpsertResponse = Readonly<{
  id: number
}>
