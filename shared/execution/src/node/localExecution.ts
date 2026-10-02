import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commandJson, CliError, verifyPython, type CliEnvironment } from './environment'
import { openArtifact } from './artifact'

export async function testLocalArtifact(
  environment: CliEnvironment,
  location: string,
  output: string,
  options: Readonly<{ signal?: AbortSignal; timeout?: number }> = {},
) {
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
    throw new CliError('Local simulation timeout must be a positive number of seconds.')
  const info = await verifyPython(environment)
  const stored = await openArtifact(location)
  if (stored.artifact.catalog_revision !== info.catalogRevision || info.catalogRevision !== info.runtimeCatalogRevision)
    throw new CliError(
      'Artifact Catalog differs from the canonical runtime Catalog. Publish Draft explicitly and rebuild.',
      4,
    )
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new CliError('Local result directory must be empty.')
  const summary = {
    kind: 'caemble.local-executions',
    artifact: stored.directory,
    source_hash: stored.artifact.source_hash,
    catalog_revision: stored.artifact.catalog_revision,
    state: 'running',
    executions: [] as unknown[],
    numerical: 'not-verified',
  }
  let failure: unknown
  try {
    for (const item of stored.artifact.items) {
      await stored.readItem(item)
      const directory = path.join(output, String(item.index))
      try {
        const result = await commandJson(
          environment.python,
          [
            '-X',
            'utf8',
            '-m',
            'app.kernel.transport.local',
            'run',
            '--input',
            path.join(stored.directory, item.file),
            '--out',
            directory,
            '--input-hash',
            item.input_hash,
            '--catalog-revision',
            stored.artifact.catalog_revision,
            ...(options.timeout ? ['--timeout', String(options.timeout)] : []),
          ],
          {
            cwd: environment.cae,
            signal: options.signal,
            cooperativeCancel: true,
            timeoutMs: options.timeout ? options.timeout * 1000 + 15_000 : 24 * 60 * 60 * 1000,
          },
        )
        if ((result as { inputHash?: string }).inputHash !== item.input_hash)
          throw new CliError('Local execution reported an input hash different from its artifact.', 4)
        summary.executions.push(result)
        if ((result as { state?: string }).state !== 'succeeded')
          failure = new CliError(`Local simulation ${item.index} failed.`, 1)
      } catch (error) {
        const manifest = await readFile(path.join(directory, 'manifest.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => ({ state: 'failed', index: item.index, directory }))
        summary.executions.push(manifest)
        failure = error
        if (options.signal?.aborted || (error instanceof CliError && error.exitCode === 5)) break
      }
    }
  } catch (error) {
    failure = error
  } finally {
    summary.state =
      options.signal?.aborted || (failure instanceof CliError && failure.exitCode === 130)
        ? 'cancelled'
        : failure
          ? 'failed'
          : 'succeeded'
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(summary, null, 2), 'utf8')
  }
  if (failure)
    throw new CliError(
      failure instanceof Error ? failure.message : 'Local simulation failed.',
      failure instanceof CliError ? failure.exitCode : 1,
      summary,
    )
  return summary
}
