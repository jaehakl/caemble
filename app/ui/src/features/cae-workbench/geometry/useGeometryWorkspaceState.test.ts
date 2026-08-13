import { describe, expect, it } from 'vitest'
import type { GeometryCoordinate } from '@/lib/cad'
import type { GeometryLocalDraft } from '../types'
import {
  attachGeometryImportSource,
  createGeometryPublishRequest,
  geometryDraftImporters,
  rebaseNewGeometryDraftConflict,
  reconcileGeometryDraftNamespace,
  retainReferencedStagedModules,
  relatedGeometryRootDrafts,
} from './useGeometryWorkspaceState'

function draft(
  draftId: string,
  coordinate: GeometryCoordinate,
  source: string,
  baseGeometryVersionId: number | null = null,
): GeometryLocalDraft {
  const [, repository, packageAndVersion] = coordinate.split('/').slice(1)
  const [packageName, version] = packageAndVersion.split('@')
  return {
    draftId,
    coordinate,
    source,
    description: '',
    baseGeometryVersionId,
    repository,
    packageName,
    repositoryId: null,
    packageId: null,
    version,
    bump: 'patch',
    rootAlias: null,
    standalonePreview: false,
  }
}

describe('rebaseNewGeometryDraftConflict', () => {
  it('rekeys a new draft and rewrites only exact import specifiers', () => {
    const previous = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const next = 'caemble:geometry/test-user/common/child@1.0.1' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const result = rebaseNewGeometryDraftConflict(
      {
        [previous]: draft('child', previous, 'export default <box size={[1, 1, 1]} />;'),
        [parent]: draft(
          'parent',
          parent,
          `import child from "${previous}";\nconst note = "${previous}";\nexport default child;`,
        ),
      },
      'child',
      '1.0.1',
    )

    expect(result?.nextCoordinate).toBe(next)
    expect(result?.nextVersion).toBe('1.0.1')
    expect(result?.drafts[previous]).toBeUndefined()
    expect(result?.drafts[next]?.version).toBe('1.0.1')
    expect(result?.drafts[parent]?.source).toBe(
      `import child from "${next}";\nconst note = "${previous}";\nexport default child;`,
    )
  })

  it('skips a suggested coordinate already occupied by another local draft', () => {
    const previous = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const occupied = 'caemble:geometry/test-user/common/child@1.0.1' as GeometryCoordinate
    const result = rebaseNewGeometryDraftConflict(
      {
        [previous]: draft('child', previous, 'export default <box size={[1, 1, 1]} />;'),
        [occupied]: draft('other', occupied, 'export default <box size={[2, 2, 2]} />;'),
      },
      'child',
      '1.0.1',
    )

    expect(result?.nextVersion).toBe('1.0.2')
    expect(result?.drafts['caemble:geometry/test-user/common/child@1.0.2']).toBeDefined()
    expect(result?.drafts[occupied]?.draftId).toBe('other')
  })

  it('keeps an existing-version overlay keyed by its published base coordinate', () => {
    const coordinate = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    expect(
      rebaseNewGeometryDraftConflict(
        { [coordinate]: draft('child-next', coordinate, 'export default <box size={[1, 1, 1]} />;', 7) },
        'child-next',
        '1.0.2',
      ),
    ).toBeNull()
  })

  it('preserves an unrelated malformed draft while rebasing valid references', () => {
    const previous = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const malformed = 'caemble:geometry/test-user/common/broken@1.0.0' as GeometryCoordinate
    const result = rebaseNewGeometryDraftConflict(
      {
        [previous]: draft('child', previous, 'export default <box size={[1, 1, 1]} />;'),
        [parent]: draft('parent', parent, `import child from "${previous}";\nexport default child;`),
        [malformed]: draft('broken', malformed, 'export default <box>'),
      },
      'child',
      '1.0.1',
    )

    expect(result?.drafts[malformed]?.source).toBe('export default <box>')
    expect(result?.drafts[parent]?.source).toContain('child@1.0.1')
  })
})

describe('Geometry local draft relationships', () => {
  it('rekeys only drafts for a not-yet-created repository when the default namespace changes', () => {
    const fresh = 'caemble:geometry/old-default/common/fresh@1.0.0' as GeometryCoordinate
    const importer = 'caemble:geometry/old-default/common/importer@1.0.0' as GeometryCoordinate
    const repositoryDraft = 'caemble:geometry/history/common/history@1.0.0' as GeometryCoordinate
    const versionDraft = 'caemble:geometry/history/common/versioned@1.0.0' as GeometryCoordinate
    const inputs = {
      [fresh]: draft('fresh', fresh, 'export default <box />;'),
      [importer]: draft('importer', importer, `import fresh from "${fresh}";\nexport default fresh;`),
      [repositoryDraft]: {
        ...draft('repository', repositoryDraft, 'export default <box />;'),
        repositoryId: 11,
      },
      [versionDraft]: draft('version', versionDraft, 'export default <box />;', 17),
    }

    const result = reconcileGeometryDraftNamespace(inputs, 'new-default')

    const nextFresh = 'caemble:geometry/new-default/common/fresh@1.0.0'
    const nextImporter = 'caemble:geometry/new-default/common/importer@1.0.0'
    expect(result.drafts[nextFresh]?.draftId).toBe('fresh')
    expect(result.drafts[nextImporter]?.source).toContain(nextFresh)
    expect(result.drafts[repositoryDraft]?.repositoryId).toBe(11)
    expect(result.drafts[versionDraft]?.baseGeometryVersionId).toBe(17)
  })

  it('rejects namespace reconciliation before mutation when an exact target is reserved', () => {
    const coordinate = 'caemble:geometry/old-default/common/fresh@1.0.0' as GeometryCoordinate
    expect(() =>
      reconcileGeometryDraftNamespace(
        { [coordinate]: draft('fresh', coordinate, 'export default <box />;') },
        'new-default',
        new Set(['caemble:geometry/new-default/common/fresh@1.0.0']),
      ),
    ).toThrow('new-default')
  })

  it('finds exact AST importers of a new draft without treating text literals as imports', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const note = 'caemble:geometry/test-user/common/note@1.0.0' as GeometryCoordinate
    const drafts = {
      [child]: draft('child', child, 'export default <box size={[1, 1, 1]} />;'),
      [parent]: draft('parent', parent, `import child from "${child}";\nexport default child;`),
      [note]: draft('note', note, `const note = "${child}";\nexport default <box size={[1, 1, 1]} />;`),
    }

    expect(geometryDraftImporters(drafts, child).map((item) => item.draftId)).toEqual(['parent'])
  })

  it('selects only local roots whose dependency path reaches the publish target', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const relatedRoot = 'caemble:geometry/test-user/common/assembly@1.0.0' as GeometryCoordinate
    const unrelatedRoot = 'caemble:geometry/test-user/common/other@1.0.0' as GeometryCoordinate
    const drafts = {
      [child]: draft('child', child, 'export default <box size={[1, 1, 1]} />;'),
      [parent]: draft('parent', parent, `import child from "${child}";\nexport default child;`),
      [relatedRoot]: {
        ...draft('related-root', relatedRoot, `import parent from "${parent}";\nexport default parent;`),
        rootAlias: 'assembly',
      },
      [unrelatedRoot]: {
        ...draft('unrelated-root', unrelatedRoot, 'export default <box size={[2, 2, 2]} />;'),
        rootAlias: 'other',
      },
    }

    expect(relatedGeometryRootDrafts(drafts, 'child').map((item) => item.draftId)).toEqual(['related-root'])
    expect(relatedGeometryRootDrafts(drafts, 'unrelated-root').map((item) => item.draftId)).toEqual(['unrelated-root'])
  })

  it('adds an exact import and combines the previous export with lowercase union', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate

    expect(attachGeometryImportSource('const body = <box />;\nexport default body;', child, 'geometry_child')).toBe(
      `import geometry_child from "${child}";\nconst body = <box />;\nexport default <union>{body}{geometry_child}</union>;`,
    )
  })

  it('blocks publish-only for an imported new draft and excludes unrelated local roots from apply', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const other = 'caemble:geometry/test-user/common/other@1.0.0' as GeometryCoordinate
    const inputs = {
      [child]: draft('child', child, 'export default <box />;'),
      [parent]: {
        ...draft('parent', parent, `import child from "${child}";\nexport default child;`),
        rootAlias: 'parent',
      },
      [other]: { ...draft('other', other, 'export default <box />;'), rootAlias: 'other' },
    }

    expect(() => createGeometryPublishRequest(inputs, [], child, false)).toThrow('Publish & Apply')
    expect(createGeometryPublishRequest(inputs, [], child, true).currentRoots).toEqual([
      { alias: 'parent', draftId: 'parent' },
    ])
  })

  it('keeps repository identity in publish input and blocks apply for a standalone preview', () => {
    const coordinate = 'caemble:geometry/history/common/part@1.0.0' as GeometryCoordinate
    const standalone = {
      ...draft('standalone', coordinate, 'export default <box />;'),
      repositoryId: 21,
      standalonePreview: true,
    }

    expect(createGeometryPublishRequest({ [coordinate]: standalone }, [], coordinate, false).drafts[0]).toMatchObject({
      draftId: 'standalone',
      repositoryId: 21,
      repository: 'common',
    })
    expect(() => createGeometryPublishRequest({ [coordinate]: standalone }, [], coordinate, true)).toThrow(
      'Publish only',
    )
  })

  it('keeps the full immutable staging closure while a draft references its root', () => {
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const stagedRoot = 'caemble:geometry/test-user/common/staged@1.0.0' as GeometryCoordinate
    const stagedChild = 'caemble:geometry/test-user/common/staged-child@1.0.0' as GeometryCoordinate
    const hash = 'a'.repeat(64)
    const modules = [
      {
        geometryVersionId: 7,
        coordinate: stagedRoot,
        moduleFormatVersion: 1 as const,
        cadApiVersion: 5 as const,
        description: null,
        source: `import child from "${stagedChild}";\nexport default child;`,
        sourceHash: hash,
        moduleHash: hash,
        imports: [{ geometryVersionId: 8, coordinate: stagedChild, moduleHash: hash }],
      },
      {
        geometryVersionId: 8,
        coordinate: stagedChild,
        moduleFormatVersion: 1 as const,
        cadApiVersion: 5 as const,
        description: null,
        source: 'export default <box />;',
        sourceHash: hash,
        moduleHash: hash,
        imports: [],
      },
    ]
    const inputs = {
      [parent]: draft('parent', parent, `import staged from "${stagedRoot}";\nexport default staged;`),
    }

    expect(retainReferencedStagedModules(inputs, modules)).toEqual(modules)
    expect(retainReferencedStagedModules({}, modules)).toEqual([])
    expect(
      retainReferencedStagedModules({ [parent]: draft('parent', parent, 'export default <union>') }, modules),
    ).toEqual(modules)
  })
})
