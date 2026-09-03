import { catalogApi } from '@/api/catalog'
import { createCachedCatalogRuntimeSliceResolver } from '@/lib/catalog/references'

export const fetchCatalogRuntimeSlice = createCachedCatalogRuntimeSliceResolver(catalogApi.runtimeSlice)
