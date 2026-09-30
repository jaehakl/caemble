/* eslint-disable @typescript-eslint/no-require-imports -- This unbundled CommonJS entry loads the prepared CommonJS CLI. */
// This entry point must work before the release bundle has been installed.
const { existsSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '../../..')
const relativePython = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
const candidates = process.env.CAEMBLE_PYTHON
  ? [[process.env.CAEMBLE_PYTHON]]
  : [
      ...['app/slaves/evaluation', 'app/slaves/cae', 'app/launcher', '']
        .map((directory) => [path.join(repo, directory, '.venv', relativePython)])
        .filter(([file]) => existsSync(file)),
      ...(process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']]),
    ]
let python
for (const command of candidates) {
  const probe = spawnSync(command[0], [...command.slice(1), '-c', 'import sys; sys.exit(sys.version_info < (3, 11))'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  if (probe.status === 0) {
    python = command
    break
  }
}
if (!python) {
  console.error('Python 3.11+ is required to prepare the CLI bundle. Set CAEMBLE_PYTHON to an existing interpreter.')
  process.exit(2)
}
const prepared = spawnSync(python[0], [...python.slice(1), '-X', 'utf8', path.join(__dirname, 'node_runtime.py')], {
  windowsHide: true,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
})
if (prepared.status !== 0) {
  console.error(
    prepared.stderr?.trim() || prepared.stdout?.trim() || prepared.error?.message || 'Node bundle preparation failed.',
  )
  process.exit(2)
}
const { directory } = JSON.parse(prepared.stdout)
// Run in this process so signals and exit codes keep their original CLI behavior.
process.argv[1] = path.join(directory, 'caemble.cjs')
require(process.argv[1])
