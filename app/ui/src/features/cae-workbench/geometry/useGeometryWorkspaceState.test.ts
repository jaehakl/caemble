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
  rewriteGeometryRootAliasFiles,
  suggestGeometryRootAlias,
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

describe('Geometry root aliases', () => {
  it('rewrites all TSX sources atomically and ignores simulation Python', () => {
    const result = rewriteGeometryRootAliasFiles(
      {
        'experiment.tsx': 'const Main = () => <Block id="main" />',
        'tasks/solve.tsx': 'const TaskGeometry = Block',
        'simulate.py': "root = 'Block'",
      },
      'Block',
      'Conductor',
    )
    expect(result.references).toBe(2)
    expect(result.files['experiment.tsx']).toContain('<Conductor')
    expect(result.files['tasks/solve.tsx']).toContain('= Conductor')
    expect(result.files['simulate.py']).toBe("root = 'Block'")
  })

  it('suggests a valid non-conflicting PascalCase alias', () => {
    expect(suggestGeometryRootAlias('notched-conductor', new Set())).toBe('NotchedConductor')
    expect(suggestGeometryRootAlias('notched-conductor', new Set(['NotchedConductor', 'NotchedConductor2']))).toBe(
      'NotchedConductor3',
    )
  })
})

describe('rebaseNewGeometryDraftConflict', () => {
  it('rekeys a new draft and rewrites only exact import specifiers', () => {
    const previous = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const next = 'caemble:geometry/test-user/common/child@1.0.1' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const result = rebaseNewGeometryDraftConflict(
      {
        [previous]: draft('child', previous, 'const Child = () => <box size={[1, 1, 1]} />; export default Child;'),
        [parent]: draft(
          'parent',
          parent,
          `import Child from "${previous}";\nconst note = "${previous}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
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
      `import Child from "${next}";\nconst note = "${previous}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
    )
  })

  it('skips a suggested coordinate already occupied by another local draft', () => {
    const previous = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const occupied = 'caemble:geometry/test-user/common/child@1.0.1' as GeometryCoordinate
    const result = rebaseNewGeometryDraftConflict(
      {
        [previous]: draft('child', previous, 'const Child = () => <box size={[1, 1, 1]} />; export default Child;'),
        [occupied]: draft('other', occupied, 'const Other = () => <box size={[2, 2, 2]} />; export default Other;'),
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
        {
          [coordinate]: draft(
            'child-next',
            coordinate,
            'const Child = () => <box size={[1, 1, 1]} />; export default Child;',
            7,
          ),
        },
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
        [previous]: draft('child', previous, 'const Child = () => <box size={[1, 1, 1]} />; export default Child;'),
        [parent]: draft(
          'parent',
          parent,
          `import Child from "${previous}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
        ),
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
      [fresh]: draft('fresh', fresh, 'const Fresh = () => <box />; export default Fresh;'),
      [importer]: draft(
        'importer',
        importer,
        `import Fresh from "${fresh}";\nconst Importer = () => <Fresh id="fresh" />;\nexport default Importer;`,
      ),
      [repositoryDraft]: {
        ...draft('repository', repositoryDraft, 'const History = () => <box />; export default History;'),
        repositoryId: 11,
      },
      [versionDraft]: draft('version', versionDraft, 'const Versioned = () => <box />; export default Versioned;', 17),
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
        { [coordinate]: draft('fresh', coordinate, 'const Fresh = () => <box />; export default Fresh;') },
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
      [child]: draft('child', child, 'const Child = () => <box size={[1, 1, 1]} />; export default Child;'),
      [parent]: draft(
        'parent',
        parent,
        `import Child from "${child}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
      ),
      [note]: draft(
        'note',
        note,
        `const note = "${child}";\nconst Note = () => <box size={[1, 1, 1]} />;\nexport default Note;`,
      ),
    }

    expect(geometryDraftImporters(drafts, child).map((item) => item.draftId)).toEqual(['parent'])
  })

  it('selects only local roots whose dependency path reaches the publish target', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const relatedRoot = 'caemble:geometry/test-user/common/assembly@1.0.0' as GeometryCoordinate
    const unrelatedRoot = 'caemble:geometry/test-user/common/other@1.0.0' as GeometryCoordinate
    const drafts = {
      [child]: draft('child', child, 'const Child = () => <box size={[1, 1, 1]} />; export default Child;'),
      [parent]: draft(
        'parent',
        parent,
        `import Child from "${child}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
      ),
      [relatedRoot]: {
        ...draft(
          'related-root',
          relatedRoot,
          `import Parent from "${parent}";\nconst Assembly = () => <Parent id="parent" />;\nexport default Assembly;`,
        ),
        rootAlias: 'Assembly',
      },
      [unrelatedRoot]: {
        ...draft(
          'unrelated-root',
          unrelatedRoot,
          'const Other = () => <box size={[2, 2, 2]} />; export default Other;',
        ),
        rootAlias: 'Other',
      },
    }

    expect(relatedGeometryRootDrafts(drafts, 'child').map((item) => item.draftId)).toEqual(['related-root'])
    expect(relatedGeometryRootDrafts(drafts, 'unrelated-root').map((item) => item.draftId)).toEqual(['unrelated-root'])
  })

  it('adds an exact import and combines the previous export with lowercase union', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate

    expect(
      attachGeometryImportSource(
        'const Parent = () => <box />;\nexport default Parent;',
        child,
        'GeometryChild',
        '<GeometryChild id="child" />',
      ),
    ).toBe(
      `import GeometryChild from "${child}";\nconst Parent = () => <union>{<box />}<GeometryChild id="child" /></union>;\nexport default Parent;`,
    )
  })

  it('composes one top-level block return and rejects conditional returns', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const source = `const Parent = () => {
  const size = [1, 1, 1] as const
  return <box size={size} />
}
export default Parent`

    expect(attachGeometryImportSource(source, child, 'Child', '<Child id="child" />')).toContain(
      'return <union>{<box size={size} />}<Child id="child" /></union>',
    )
    expect(() =>
      attachGeometryImportSource(
        'const Parent = () => { if (true) return <box /> }\nexport default Parent',
        child,
        'Child',
        '<Child id="child" />',
      ),
    ).toThrow('one top-level return')
  })

  it('blocks publish-only for an imported new draft and excludes unrelated local roots from apply', () => {
    const child = 'caemble:geometry/test-user/common/child@1.0.0' as GeometryCoordinate
    const parent = 'caemble:geometry/test-user/common/parent@1.0.0' as GeometryCoordinate
    const other = 'caemble:geometry/test-user/common/other@1.0.0' as GeometryCoordinate
    const inputs = {
      [child]: draft('child', child, 'const Child = () => <box />; export default Child;'),
      [parent]: {
        ...draft(
          'parent',
          parent,
          `import Child from "${child}";\nconst Parent = () => <Child id="child" />;\nexport default Parent;`,
        ),
        rootAlias: 'Parent',
      },
      [other]: { ...draft('other', other, 'const Other = () => <box />; export default Other;'), rootAlias: 'Other' },
    }

    expect(() => createGeometryPublishRequest(inputs, [], child, false)).toThrow('Publish & Apply')
    expect(createGeometryPublishRequest(inputs, [], child, true).currentRoots).toEqual([
      { alias: 'Parent', draftId: 'parent' },
    ])
  })

  it('keeps repository identity in publish input and blocks apply for a standalone preview', () => {
    const coordinate = 'caemble:geometry/history/common/part@1.0.0' as GeometryCoordinate
    const standalone = {
      ...draft('standalone', coordinate, 'const Standalone = () => <box />; export default Standalone;'),
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
        moduleFormatVersion: 2 as const,
        cadApiVersion: 5 as const,
        description: null,
        source: `import Child from "${stagedChild}";\nconst Staged = () => <Child id="child" />;\nexport default Staged;`,
        sourceHash: hash,
        moduleHash: hash,
        imports: [{ geometryVersionId: 8, coordinate: stagedChild, moduleHash: hash }],
      },
      {
        geometryVersionId: 8,
        coordinate: stagedChild,
        moduleFormatVersion: 2 as const,
        cadApiVersion: 5 as const,
        description: null,
        source: 'const StagedChild = () => <box />; export default StagedChild;',
        sourceHash: hash,
        moduleHash: hash,
        imports: [],
      },
    ]
    const inputs = {
      [parent]: draft(
        'parent',
        parent,
        `import Staged from "${stagedRoot}";\nconst Parent = () => <Staged id="staged" />;\nexport default Parent;`,
      ),
    }

    expect(retainReferencedStagedModules(inputs, modules)).toEqual(modules)
    expect(retainReferencedStagedModules({}, modules)).toEqual([])
    expect(
      retainReferencedStagedModules({ [parent]: draft('parent', parent, 'export default <union>') }, modules),
    ).toEqual(modules)
  })
})
