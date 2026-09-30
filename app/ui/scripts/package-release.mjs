import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const deployment = path.resolve('../../deployment')
const staging = await mkdtemp(path.join(deployment, '.release-'))
try {
  await cp('dist', path.join(staging, 'web'), { recursive: true })
  await cp('dist-cli', path.join(staging, 'node'), { recursive: true })
  const archive = path.join(staging, 'caemble.tar.gz')
  execFileSync('tar', ['-C', staging, '-czf', archive, 'web', 'node'], { stdio: 'inherit', windowsHide: true })
  await rename(archive, path.join(deployment, 'caemble.tar.gz'))
} finally {
  await rm(staging, { recursive: true, force: true })
}
