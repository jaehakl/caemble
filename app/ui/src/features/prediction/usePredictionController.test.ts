import { expect, it, vi } from 'vitest'
import { PredictionRuntimeController } from './predictionRuntime'
import { model, reference, remoteFixture } from './forward.fixture'

it('shares an in-flight load and cached instance across Candidate transactions', async () => {
  const remote = remoteFixture()
  let complete!: (value: typeof model) => void
  remote.load.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const first = runtime.loadModel(reference, runtime.beginTransaction())
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = runtime.loadModel(reference, runtime.beginTransaction())
  complete(model)
  await rejected
  expect(await second).toBe(model)
  expect(await runtime.loadModel(reference, runtime.beginTransaction())).toBe(model)
  expect(remote.load).toHaveBeenCalledTimes(1)
  expect(remote).not.toHaveProperty('prepare')
  expect(remote.release).not.toHaveBeenCalled()
  runtime.dispose()
})

it('settles cancelled prediction immediately even when transport ignores abort and keeps its model', async () => {
  const remote = remoteFixture()
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const transaction = runtime.beginTransaction()
  const loaded = await runtime.loadModel(reference, transaction)
  let complete!: (value: Awaited<ReturnType<typeof remote.predict>>) => void
  remote.predict.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const result = runtime.predict(loaded, { direction: 'forward', vars: { x: 0.5 } }, transaction)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  runtime.invalidateTransaction()
  await rejected
  expect(remote.cancel).toHaveBeenCalledOnce()
  expect(runtime.cachedModel()).toBe(loaded)
  expect(remote.release).not.toHaveBeenCalled()
  complete(await remote.predict())
  await Promise.resolve()
  const next = runtime.beginTransaction()
  expect(await runtime.loadModel(reference, next)).toBe(loaded)
  runtime.dispose()
})

it('releases a late old-session load and never adopts its handle after reconnection', async () => {
  const remote = remoteFixture()
  const replacement = remoteFixture()
  let complete!: (value: typeof model) => void
  remote.load.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const pending = runtime.loadModel(reference, runtime.beginTransaction())
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  runtime.setExecution({ key: 'replacement', create: () => replacement })
  const loaded = await runtime.loadModel(reference, runtime.beginTransaction())
  complete(model)
  await rejected
  await vi.waitFor(() => expect(remote.release).toHaveBeenCalledWith(model.instance))
  expect(runtime.cachedModel()).toBe(loaded)
  expect(replacement.load).toHaveBeenCalledOnce()
  runtime.dispose()
})

it('releases RAM without preparing or deleting saved files', async () => {
  const remote = remoteFixture()
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  await runtime.loadModel(reference, runtime.beginTransaction())
  await runtime.releaseLoadedModels()
  expect(remote.release).toHaveBeenCalledExactlyOnceWith(model.instance)
  expect(runtime.cachedModel()).toBeNull()
  expect(remote).not.toHaveProperty('prepare')
  runtime.dispose()
})

it('explicit cancel aborts unfinished load and disposes its connection, unlike Candidate supersession', async () => {
  const remote = remoteFixture()
  let complete!: (value: typeof model) => void
  remote.load.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const pending = runtime.loadModel(reference, runtime.beginTransaction())
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  runtime.cancelCurrent()
  await rejected
  expect(remote.dispose).toHaveBeenCalledOnce()
  complete(model)
  await vi.waitFor(() => expect(remote.release).toHaveBeenCalledWith(model.instance))
  expect(runtime.cachedModel()).toBeNull()
  runtime.dispose()
})
