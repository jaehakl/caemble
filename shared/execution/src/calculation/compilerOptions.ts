/** Monaco and Node supply their own TypeScript enum values to the same language options. */
export function calculationCompilerOptions(typescript: {
  ScriptTarget: { ES2020: number }
  ModuleKind: { CommonJS: number }
  ModuleResolutionKind: { NodeJs: number }
}) {
  return {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    strict: true,
    noImplicitAny: false,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: true,
    inlineSources: true,
  }
}
