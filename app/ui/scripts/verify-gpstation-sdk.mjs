import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const archive = new URL('../vendor/gpstation-v1-master-js-sdk-0.1.0.tgz', import.meta.url)
const expectedHash = '3e40bf4b3dc2be4af5217da23f9b5d199e1262725b34987b28e829b16addf42d'
const expectedVersion = '0.1.0'

const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')
if (archiveHash !== expectedHash) {
  throw new Error(`GPStation SDK archive hash mismatch: expected ${expectedHash}, received ${archiveHash}`)
}

const installedPackage = JSON.parse(
  await readFile(new URL('../node_modules/@gpstation/v1-master-js-sdk/package.json', import.meta.url), 'utf8'),
)
if (installedPackage.version !== expectedVersion) {
  throw new Error(
    `GPStation SDK version mismatch: expected ${expectedVersion}, received ${String(installedPackage.version)}`,
  )
}

console.log(`Verified @gpstation/v1-master-js-sdk ${expectedVersion} (${archiveHash})`)
