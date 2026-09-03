export function calculationAccessPolicy({
  dataReadable,
  experimentIsDemo,
  experimentManageable,
}: {
  dataReadable: boolean
  experimentIsDemo: boolean
  experimentManageable: boolean
}) {
  const demoSandbox = dataReadable && experimentIsDemo && !experimentManageable
  return {
    demoSandbox,
    persistable: experimentManageable,
    sourceEditable: experimentManageable || demoSandbox,
  } as const
}
