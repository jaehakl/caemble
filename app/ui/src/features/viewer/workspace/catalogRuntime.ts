import { catalogApi } from '@/api/catalog'
import { createCachedCatalogRuntimeSliceResolver } from '@caemble/execution/catalog/references'

export const fetchCatalogRuntimeSlice = createCachedCatalogRuntimeSliceResolver(catalogApi.runtimeSlice)
