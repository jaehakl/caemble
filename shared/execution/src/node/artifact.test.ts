// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readSourceBundle, writeSourceBundle } from '@caemble/execution/node/artifact'

it('includes every file for validation, except CLI metadata, and permits historical export for repair', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caemble-source-paths-'))
  try {
    const directory = path.join(root, 'source')
    await writeSourceBundle(directory, { files: { 'experiment.tsx': 'export default null', 'object.ts': 'legacy' } })
    await expect(readSourceBundle(directory)).rejects.toThrow('object.ts')
    await rm(path.join(directory, 'object.ts'))
    await writeFile(path.join(directory, 'caemble.json'), '{}')
    expect((await readSourceBundle(directory)).files).toEqual({ 'experiment.tsx': 'export default null' })
    await mkdir(path.join(directory, 'lib'))
    await writeFile(path.join(directory, 'lib/unused.json'), '{}')
    await expect(readSourceBundle(directory)).rejects.toThrow('lib/unused.json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
