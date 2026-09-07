import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArtifactInput, parseBuildArtifact } from '@/lib/cae/artifact'
import type { BuildArtifact, BuildArtifactItem } from '@/contracts/build'
import type { ExperimentSourceBundle } from '@/contracts/cad-persistence'
import { cadSourceHash } from '@/lib/cad/source/document'
import { CliError } from './environment'

export async function containedPath(directory: string, file: string) {
  const root = await realpath(directory)
  const resolved = await realpath(path.resolve(root, file))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new CliError(`File escapes the input directory: ${file}`)
  return resolved
}

export async function readSourceBundle(directory: string): Promise<ExperimentSourceBundle> {
  const files: Record<string, string> = {}
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    const relative = path.relative(directory, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/')
    if (
      !entry.isFile() ||
      !/\.(tsx?|py)$/.test(entry.name) ||
      /(^|\/)(node_modules|\.git|\.venv|dist|dist-cli)\//.test(relative)
    )
      continue
    files[relative] = await readFile(await containedPath(directory, relative), 'utf8')
  }
  if (!files['experiment.tsx']) throw new CliError('The source directory must contain experiment.tsx.')
  return { files }
}

export async function writeSourceBundle(directory: string, bundle: ExperimentSourceBundle) {
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) throw new CliError('The source destination must be empty.')
  for (const [name, content] of Object.entries(bundle.files)) {
    const target = path.resolve(directory, name)
    const relative = path.relative(directory, target)
    if (relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\') || !/\.(tsx?|py)$/.test(name))
      throw new CliError(`Invalid source path: ${name}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  }
}

export async function openArtifact(location: string) {
  const directory = path.resolve(location.endsWith('.json') ? path.dirname(location) : location)
  const manifest = await readFile(await containedPath(directory, 'manifest.json'), 'utf8')
  let artifact: BuildArtifact
  try {
    artifact = parseBuildArtifact(JSON.parse(manifest))
  } catch (error) {
    throw new CliError('Artifact manifest is invalid or incompatible. Rebuild with this checkout.', 4, {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  if ((await cadSourceHash({ kind: 'experiment', sourceBundle: artifact.source_bundle })) !== artifact.source_hash)
    throw new CliError('Artifact source bundle has changed.', 4)
  const readItem = async (item: BuildArtifactItem) => {
    const bytes = await readFile(await containedPath(directory, item.file))
    if (bytes.byteLength !== item.byte_length || createHash('sha256').update(bytes).digest('hex') !== item.input_hash)
      throw new CliError(`Artifact input ${item.index} has changed.`, 4)
    try {
      parseArtifactInput(JSON.parse(bytes.toString('utf8')), artifact)
    } catch (error) {
      throw new CliError(`Artifact input ${item.index} is invalid or incompatible.`, 4, {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return bytes
  }
  return { directory, artifact, readItem }
}
