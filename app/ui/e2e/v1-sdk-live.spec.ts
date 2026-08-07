import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const apiBaseUrl = process.env.CAEMBLE_V1_E2E_API_BASE_URL?.trim()
const clientToken = process.env.CAEMBLE_V1_E2E_CLIENT_TOKEN?.trim()
const timeoutSeconds = Number(process.env.CAEMBLE_V1_E2E_TIMEOUT_SECONDS?.trim() || '300')
const sdkModuleUrl = `/@fs/${fileURLToPath(new URL('../../sdk/master/js/dist/index.js', import.meta.url)).replaceAll(
  '\\',
  '/',
)}`

test('runs the frozen JavaScript v1 SDK contract against Caemble', async ({ page }) => {
  test.skip(
    !apiBaseUrl || !clientToken,
    'live E2E requires CAEMBLE_V1_E2E_API_BASE_URL and CAEMBLE_V1_E2E_CLIENT_TOKEN',
  )
  expect(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0).toBe(true)

  await page.goto('/')
  const result = await page.evaluate(
    async ({ moduleUrl, baseUrl, token, timeoutMs }) => {
      const { GpStationClient } = await import(/* @vite-ignore */ moduleUrl)
      const client = new GpStationClient({ apiBaseUrl: baseUrl, token })
      const deltas: string[] = []
      try {
        const launchers = await client.listLaunchers()
        if (
          !launchers.some(
            (launcher: { slave_app_ids: string[] }) =>
              launcher.slave_app_ids.includes('ai') && launcher.slave_app_ids.includes('cae'),
          )
        ) {
          throw new Error('no connected launcher advertises both ai and cae')
        }

        const caeResult = await client.runJob('cae.solvers.manifests', {}, { slaveAppId: 'cae', timeoutMs })
        const manifestFile = caeResult.files.find((file: { id: string }) => file.id === caeResult.payload?.attachmentId)
        if (!manifestFile) throw new Error('CAE manifest attachment is missing')
        const manifests = JSON.parse(await manifestFile.blob.text())
        if (
          caeResult.payload?.formatVersion !== 1 ||
          !Array.isArray(manifests) ||
          manifests.length !== caeResult.payload?.count
        ) {
          throw new Error('CAE manifest response is invalid')
        }

        const modelResult = await client.runJob('ai.llm.models', {}, { slaveAppId: 'ai', timeoutMs })
        const model = modelResult.payload?.default_model
        if (
          typeof model !== 'string' ||
          !model ||
          !modelResult.payload?.models?.some((item: { name?: string }) => item?.name === model)
        ) {
          throw new Error('AI model response is invalid')
        }

        const chatResult = await client.runJob(
          'ai.chat',
          {
            model,
            system_prompt: 'Answer briefly and follow the user request.',
            prompt: 'Reply with the single word CAEMBLE.',
            max_tokens: 16,
            temperature: 0,
            think: false,
          },
          {
            slaveAppId: 'ai',
            timeoutMs,
            autoFinish: false,
            onEvent: (event: { type: string; payload?: { delta?: unknown } }) => {
              if (event.type === 'ai.chat.delta' && typeof event.payload?.delta === 'string') {
                deltas.push(event.payload.delta)
              }
            },
          },
        )
        try {
          const answer = chatResult.payload?.answer
          if (typeof answer !== 'string' || !answer || deltas.join('') !== answer) {
            throw new Error('AI chat stream does not match its final answer')
          }
          return {
            answer,
            launcherCount: launchers.length,
            manifestCount: manifests.length,
            model,
          }
        } finally {
          await chatResult.session.finish({ timeoutMs })
        }
      } finally {
        client.clearPrewarmedJobConnections()
      }
    },
    {
      moduleUrl: sdkModuleUrl,
      baseUrl: apiBaseUrl!,
      token: clientToken!,
      timeoutMs: timeoutSeconds * 1000,
    },
  )

  expect(result.launcherCount).toBeGreaterThan(0)
  expect(result.manifestCount).toBeGreaterThan(0)
  expect(result.model).not.toBe('')
  expect(result.answer).not.toBe('')
})
