import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim()
const repositoryFiles = new Set(
  execFileSync('git', ['-C', repositoryRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/')),
)
for (const file of repositoryFiles) {
  if (!existsSync(path.join(repositoryRoot, file))) repositoryFiles.delete(file)
}
const markdownFiles = [...repositoryFiles].filter((file) => file.toLocaleLowerCase().endsWith('.md')).sort()
const decoder = new TextDecoder('utf-8', { fatal: true })
const documents = new Map()
const errors = []

for (const file of markdownFiles) {
  try {
    documents.set(file, decoder.decode(readFileSync(path.join(repositoryRoot, file))))
  } catch (error) {
    errors.push(`${file}: invalid UTF-8 or unreadable file (${error.message})`)
  }
}

function maskCode(markdown) {
  let fenced = false
  let marker = ''
  return markdown
    .split(/(?<=\n)/u)
    .map((line) => {
      const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
      if (fence && (!fenced || fence[1][0] === marker)) {
        fenced = !fenced
        marker = fenced ? fence[1][0] : ''
        return line.replace(/[^\r\n]/gu, ' ')
      }
      if (fenced) return line.replace(/[^\r\n]/gu, ' ')
      return line.replace(/`[^`\r\n]*`/gu, (code) => ' '.repeat(code.length))
    })
    .join('')
}

function linksIn(markdown) {
  const masked = maskCode(markdown)
  const links = []
  const patterns = [
    /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))/gu,
    /^\s{0,3}\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]+)>|(\S+))/gmu,
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu,
  ]
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      links.push({ index: match.index, target: match[1] ?? match[2] })
    }
  }
  return links
}

function anchorsIn(markdown) {
  const anchors = new Set()
  const counts = new Map()
  const masked = maskCode(markdown)
  for (const match of masked.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const label = match[1]
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/<[^>]+>/gu, '')
      .replace(/[`*_~]/gu, '')
      .trim()
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
      .replace(/\s+/gu, '-')
    if (!label) continue
    const duplicate = counts.get(label) ?? 0
    anchors.add(duplicate === 0 ? label : `${label}-${duplicate}`)
    counts.set(label, duplicate + 1)
  }
  for (const match of masked.matchAll(/<(?:a|[a-z][\w-]*)\b[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu)) {
    anchors.add(match[1])
  }
  return anchors
}

const anchorCache = new Map()
for (const [file, markdown] of documents) {
  for (const { index, target: encodedTarget } of linksIn(markdown)) {
    const line = markdown.slice(0, index).split(/\r?\n/u).length
    const target = encodedTarget.replace(/\\([()[\] ])/gu, '$1')
    if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('//') || target.startsWith('/')) continue

    const hashIndex = target.indexOf('#')
    const encodedPath = hashIndex === -1 ? target : target.slice(0, hashIndex)
    const encodedAnchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1)
    let linkPath
    let anchor
    try {
      linkPath = decodeURIComponent(encodedPath.split('?')[0])
      anchor = decodeURIComponent(encodedAnchor)
    } catch {
      errors.push(`${file}:${line}: malformed URL encoding in ${encodedTarget}`)
      continue
    }

    const resolved = linkPath
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), linkPath.replaceAll('\\', '/')))
      : file
    if (resolved === '..' || resolved.startsWith('../')) {
      errors.push(`${file}:${line}: link escapes the repository: ${encodedTarget}`)
      continue
    }

    const targetExists =
      repositoryFiles.has(resolved) || [...repositoryFiles].some((item) => item.startsWith(`${resolved}/`))
    if (!targetExists) {
      errors.push(`${file}:${line}: missing tracked target: ${encodedTarget}`)
      continue
    }

    if (anchor && resolved.toLocaleLowerCase().endsWith('.md') && documents.has(resolved)) {
      const anchors = anchorCache.get(resolved) ?? anchorsIn(documents.get(resolved))
      anchorCache.set(resolved, anchors)
      if (!anchors.has(anchor)) errors.push(`${file}:${line}: missing anchor in ${resolved}: #${anchor}`)
    }
  }
}

if (errors.length) {
  console.error(`Documentation check failed with ${errors.length} error(s):`)
  errors.forEach((error) => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log(`Documentation check passed for ${markdownFiles.length} repository Markdown files.`)
}
