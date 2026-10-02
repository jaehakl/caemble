// Monaco and the server compiler use their own TypeScript runtime with identical options.
export function cadCompilerOptions(typescript: {
  ScriptTarget: { ES2020: number }
  ModuleKind: { CommonJS: number }
  ModuleResolutionKind: { NodeJs: number }
  JsxEmit: { React: number }
}) {
  return {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    jsx: typescript.JsxEmit.React,
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    strict: true,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: true,
    inlineSources: true,
  }
}
