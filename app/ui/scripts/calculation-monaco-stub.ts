export const calculationMonacoStubState = {
  emitCount: 0,
  modelUris: [] as string[],
}

const monaco = {
  Uri: {
    parse(value: string) {
      return { toString: () => value }
    },
  },
  editor: {
    createModel(_source: string, _language: string, uri: { toString: () => string }) {
      calculationMonacoStubState.modelUris.push(uri.toString())
      return { uri, dispose() {} }
    },
  },
  typescript: {
    typescriptDefaults: {
      addExtraLib() {
        return { dispose() {} }
      },
    },
    async getTypeScriptWorker() {
      return async () => ({
        async getSyntacticDiagnostics() {
          return []
        },
        async getSemanticDiagnostics() {
          return []
        },
        async getEmitOutput() {
          calculationMonacoStubState.emitCount += 1
          await new Promise((resolve) => setTimeout(resolve, 0))
          return {
            emitSkipped: false,
            outputFiles: [{ name: 'calculation.js', text: '"use strict"; exports.default = () => undefined;' }],
          }
        },
      })
    },
  },
}

export async function loadMonaco() {
  return monaco as never
}
