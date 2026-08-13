export function geometryComponentName(packageName: string) {
  const name = packageName
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
  return /^[A-Z][A-Za-z0-9_]*$/u.test(name) ? name : 'SelectedGeometry'
}

export function geometryUsageCode(alias: string) {
  const id = `${alias[0]?.toLowerCase() ?? 'geometry'}${alias.slice(1)}`
  return `<${alias}\n  id=${JSON.stringify(id)}\n  /* 기본값 없는 필수 props는 Monaco 자동완성으로 입력 */\n/>`
}
