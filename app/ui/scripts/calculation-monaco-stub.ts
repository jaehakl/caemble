export const calculationMonacoStubState = {
  compileCount: 0,
  modelLanguages: [] as string[],
  modelUris: [] as string[],
}

const monaco = {
  Uri: {
    parse(value: string) {
      return { toString: () => value }
    },
  },
  editor: {
    createModel(_source: string, language: string, uri: { toString: () => string }) {
      calculationMonacoStubState.modelLanguages.push(language)
      calculationMonacoStubState.modelUris.push(uri.toString())
      return { uri, dispose() {} }
    },
  },
  typescript: {
    javascriptDefaults: {
      addExtraLib() {
        return { dispose() {} }
      },
    },
    async getJavaScriptWorker() {
      return async () => ({
        async getSyntacticDiagnostics() {
          return []
        },
        async getSemanticDiagnostics() {
          calculationMonacoStubState.compileCount += 1
          return []
        },
      })
    },
  },
}

export async function loadMonaco() {
  return monaco as never
}
