import type { ExperimentRecordedDataRecord, RecordedDataRecord } from '@/api'
import { browserClient } from '@/api/http'
import { resolveObjects } from '@/api/objectStorage'
import type { RecordedDataRule, Vars, VarsSchemaEntry } from '@/lib/cad/model'
import { PredictionWorkerClient, PredictionWorkerRestartError } from './client'
import { assertTrainingCellLimit, browserPredictionTrainingPolicy } from './browserTrainingPolicy'
import {
  calculationOutputSample,
  inverseTrainingRows,
  predictionFingerprint,
  predictionRecordedRowSample,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import {
  PredictionInstanceInvalidatedError,
  type PredictionExecution,
  type PredictionExecutionResult,
  type PredictionInput,
  type PredictionModelDefinition,
  type PredictionModelInstance,
  type PredictionModelProfile,
  type PredictionRequest,
  type PreparedPredictionModel,
} from './execution'
import type { PredictionNumericDtype, PredictionTrainingRow } from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import type { TrainingSnapshot } from './trainingSnapshot'

type WorkerModel = Readonly<{
  modelId: string
  generation: number
  fingerprint: string
  profile: PredictionWorkerModelProfile
  records: readonly ExperimentRecordedDataRecord[]
  rules: readonly RecordedDataRule[]
}>

type BrowserModel = Readonly<{
  prepared: PreparedPredictionModel
  models: readonly WorkerModel[]
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  calculationIds: readonly number[]
}>

type BrowserRequest = {
  abort: AbortController
  sessionId: string
  workerPending: number
}

function publicProfile(profile: PredictionWorkerModelProfile): PredictionModelProfile {
  const {
    k,
    weighting,
    inputScaling,
    inputScales,
    inputBlockWeights,
    activeInputBlockCount,
    dominantShapeSignature,
    baselineMeasurementId,
    persistentBytes,
    workingSetBytes,
    ...common
  } = profile
  return Object.freeze({
    ...common,
    knn: Object.freeze({
      k,
      weighting,
      inputScaling,
      inputScales,
      inputBlockWeights,
      activeInputBlockCount,
      dominantShapeSignature,
      baselineMeasurementId,
    }),
    resources: Object.freeze({ persistentBytes, workingSetBytes }),
  })
}

function aggregateForwardProfiles(models: readonly WorkerModel[]): PredictionWorkerModelProfile {
  const profiles = models.map((model) => model.profile)
  const excluded = {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  }
  profiles.forEach((profile) => {
    ;(Object.keys(excluded) as (keyof typeof excluded)[]).forEach((reason) => {
      excluded[reason] += profile.excluded[reason]
    })
  })
  const diagnostics = profiles.flatMap((profile) => profile.diagnostics)
  return Object.freeze({
    direction: 'forward',
    activeInputBlockCount: profiles[0]?.activeInputBlockCount ?? 0,
    rowCount: Math.min(...profiles.map((profile) => profile.rowCount)),
    k: Math.min(...profiles.map((profile) => profile.k)),
    weighting: profiles[0]?.weighting ?? 'distance',
    inputScaling: 'range',
    inputLayouts: Object.freeze([]),
    inputScales: new Float64Array(),
    inputBlockWeights: profiles[0]?.inputBlockWeights ?? Object.freeze({}),
    inputSize: profiles[0]?.inputSize ?? 0,
    outputSize: profiles.reduce((total, profile) => total + profile.outputSize, 0),
    persistentBytes: profiles.reduce((total, profile) => total + profile.persistentBytes, 0),
    workingSetBytes: profiles.reduce((total, profile) => total + profile.workingSetBytes, 0),
    includedMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.includedMeasurementIds))].sort((a, b) => a - b),
    ),
    warningMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.warningMeasurementIds))].sort((a, b) => a - b),
    ),
    dominantShapeSignature: JSON.stringify(
      Object.fromEntries(
        models.map((model) => [model.records[0].name, JSON.parse(model.profile.dominantShapeSignature)]),
      ),
    ),
    baselineMeasurementId: Math.min(...profiles.map((profile) => profile.baselineMeasurementId)),
    diagnostics: Object.freeze(diagnostics.slice(0, 500)),
    omittedDiagnosticGroups:
      profiles.reduce((total, profile) => total + profile.omittedDiagnosticGroups, 0) +
      Math.max(0, diagnostics.length - 500),
    excluded: Object.freeze(excluded),
  })
}

/** Browser kNN owns vectorization, Worker transport and browser resource limits. */
export class BrowserPredictionExecution implements PredictionExecution {
  readonly id = 'browser-knn'
  readonly location = 'browser'
  readonly implementationVersion = 'knn-v1'
  readonly preprocessingVersion = 'box-relative-v1'
  readonly algorithms = Object.freeze(['knn'] as const)
  readonly directions = Object.freeze(['forward', 'inverse'] as const)
  readonly trainingPolicy = browserPredictionTrainingPolicy
  private readonly sessionKey = crypto.randomUUID()
  private readonly models = new Map<string, BrowserModel>()
  private readonly requests = new Map<string, BrowserRequest>()
  private client: PredictionWorkerClient | null = null
  private generation = 0
  private disposed = false

  get sessionId() {
    return `${this.sessionKey}:${this.client?.epoch ?? 1}`
  }

  private assertCurrent(request: BrowserRequest) {
    if (this.disposed || request.abort.signal.aborted)
      throw new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError')
    if (request.sessionId !== this.sessionId)
      throw new PredictionInstanceInvalidatedError('Prediction 실행 세션이 변경되었습니다.')
  }

  private async run<T>(request: PredictionRequest, operation: (active: BrowserRequest) => Promise<T>): Promise<T> {
    if (this.disposed || request.signal.aborted)
      throw new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError')
    if (this.requests.has(request.requestId)) throw new Error('Prediction requestId가 중복되었습니다.')
    this.client ??= new PredictionWorkerClient()
    const active: BrowserRequest = { abort: new AbortController(), sessionId: this.sessionId, workerPending: 0 }
    this.requests.set(request.requestId, active)
    const cancel = () => this.cancel(request.requestId)
    request.signal.addEventListener('abort', cancel, { once: true })
    let rejectAborted!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
      active.abort.signal.addEventListener('abort', rejectAborted, { once: true })
    })
    try {
      const result = await Promise.race([operation(active), aborted])
      this.assertCurrent(active)
      return result
    } catch (error) {
      if (error instanceof PredictionWorkerRestartError) {
        this.models.clear()
        throw new PredictionInstanceInvalidatedError(error.message)
      }
      throw error
    } finally {
      request.signal.removeEventListener('abort', cancel)
      active.abort.signal.removeEventListener('abort', rejectAborted)
      this.requests.delete(request.requestId)
    }
  }

  private async workerRequest<T>(active: BrowserRequest, operation: (client: PredictionWorkerClient) => Promise<T>) {
    this.assertCurrent(active)
    active.workerPending += 1
    try {
      const result = await operation(this.client!)
      this.assertCurrent(active)
      return result
    } finally {
      active.workerPending -= 1
    }
  }

  async prepare(snapshot: TrainingSnapshot, definition: PredictionModelDefinition, request: PredictionRequest) {
    let completed: PreparedPredictionModel | null = null
    return this.run(request, async (active) => {
      if (definition.algorithm.kind !== 'knn') throw new Error('브라우저 Prediction은 kNN만 지원합니다.')
      if (
        definition.snapshotFingerprint !== snapshot.fingerprint ||
        definition.implementationId !== this.id ||
        definition.implementationVersion !== this.implementationVersion ||
        definition.preprocessingVersion !== this.preprocessingVersion
      )
        throw new Error('Prediction 모델 정의가 학습 입력 또는 실행 구현과 일치하지 않습니다.')
      const generation = ++this.generation
      const handle = crypto.randomUUID()
      const instance: PredictionModelInstance = Object.freeze({
        executionId: this.id,
        sessionId: active.sessionId,
        generation,
        handle,
      })
      const attempted: Array<Readonly<{ modelId: string; fingerprint: string }>> = []
      const models: WorkerModel[] = []
      const errors: Record<number, string> = {}
      const algorithm = definition.algorithm
      const layouts = predictionVarsLayouts(snapshot.varsSchema)
      try {
        if (snapshot.direction === 'inverse') {
          this.trainingPolicy.checkCalculationData(snapshot.calculationData)
          const calculationIds = snapshot.calculations.map((calculation) => calculation.id)
          if (!calculationIds.length) throw new Error('Inverse에 사용할 Calculation을 선택하세요.')
          const rows = inverseTrainingRows(
            snapshot.measurements,
            snapshot.calculationData,
            calculationIds,
            snapshot.varsSchema,
          )
          assertTrainingCellLimit(rows)
          const fixedInputLayouts = Object.freeze(
            snapshot.calculations.map((calculation) => {
              if (!calculation.output_layout)
                throw new Error(`Calculation #${calculation.id}의 Output 계약이 없습니다.`)
              return Object.freeze({
                key: `calculation:${calculation.id}`,
                dtype: calculation.output_layout.dtype as PredictionNumericDtype,
                shape: Object.freeze([...calculation.output_layout.shape]),
                axes: Object.freeze(
                  calculation.output_layout.axes.map((axis) =>
                    Object.freeze({
                      name: axis.name,
                      ticks: Object.freeze([...axis.ticks]),
                      ...(axis.unit ? { unit: axis.unit } : {}),
                    }),
                  ),
                ),
              })
            }),
          )
          const identity = { modelId: `${handle}:inverse`, fingerprint: definition.fingerprint }
          attempted.push(identity)
          const profile = await this.workerRequest(active, (client) =>
            client.build(identity.modelId, generation, identity.fingerprint, {
              direction: 'inverse',
              fingerprint: identity.fingerprint,
              inputKeys: calculationIds.map((id) => `calculation:${id}`),
              outputKeys: layouts.map((layout) => layout.key),
              rows,
              fixedInputLayouts,
              fixedOutputLayouts: layouts,
              inputBlockWeights: Object.freeze(
                Object.fromEntries(
                  calculationIds.map((id) => [`calculation:${id}`, algorithm.calculationWeights[id] ?? 1]),
                ),
              ),
              inputScaling: 'standard-deviation',
              weighting: algorithm.weighting,
              ...(algorithm.kMode === 'manual' ? { k: algorithm.manualK } : {}),
            }),
          )
          models.push({ ...identity, generation, profile, records: [], rules: [] })
        } else {
          if (!snapshot.records.length) throw new Error('선택한 Calculation이 사용하는 ExperimentRecord가 없습니다.')
          this.trainingPolicy.checkRecordedData(snapshot.recorded, snapshot.varsSchema)
          const hydratedRows = await resolveObjects(browserClient, snapshot.recorded, active.abort.signal)
          this.assertCurrent(active)
          const measurementIds = new Set(snapshot.measurements.map((measurement) => measurement.id))
          const requiredRecordIds = new Set(snapshot.records.map((record) => record.id))
          const rowsByRecord = new Map<number, Map<number, RecordedDataRecord>>()
          hydratedRows.forEach((row) => {
            if (!measurementIds.has(row.measurement_id) || !requiredRecordIds.has(row.experiment_record_id)) return
            const byMeasurement = rowsByRecord.get(row.experiment_record_id) ?? new Map<number, RecordedDataRecord>()
            byMeasurement.set(row.measurement_id, row)
            rowsByRecord.set(row.experiment_record_id, byMeasurement)
          })
          const rulesByName = new Map(snapshot.rules.map((rule) => [rule.label, rule]))
          const groups = new Map<string, ExperimentRecordedDataRecord[]>()
          for (const record of snapshot.records) {
            const rule = rulesByName.get(record.name)
            const contract = Object.entries(snapshot.resultContracts).find(
              ([name]) => record.name === name || record.name.startsWith(`${name}.`),
            )?.[1]
            const key =
              rule?.result.boxGrid?.frequencyKind === 'modal' && contract
                ? `modal:${contract.task}`
                : `record:${record.id}`
            const group = groups.get(key) ?? []
            group.push(record)
            groups.set(key, group)
          }
          for (const group of groups.values()) {
            this.assertCurrent(active)
            const record = group[0]
            const rule = rulesByName.get(record.name)
            const groupRules = group.flatMap((member) => {
              const current = rulesByName.get(member.name)
              return current ? [current] : []
            })
            if (!rule || groupRules.length !== group.length || groupRules.some((member) => !member.result.boxGrid)) {
              group.forEach((member) => {
                errors[member.id] = `현재 Experiment source에서 ${member.name} Box Grid Output을 찾을 수 없습니다.`
              })
              continue
            }
            if (rule.result.dtype === 'bool' || rule.result.dtype === 'string') {
              group.forEach((member) => {
                errors[member.id] =
                  `${member.name}의 dtype ${rule.result.dtype}은 numeric Prediction을 지원하지 않습니다.`
              })
              continue
            }
            const rows = Object.freeze(
              snapshot.measurements.map((measurement): PredictionTrainingRow => {
                try {
                  const inputs = predictionVarsSamples(measurement.vars as Readonly<Vars>, snapshot.varsSchema)
                  const stored = group.map((member) => rowsByRecord.get(member.id)?.get(measurement.id))
                  if (stored.some((member) => !member))
                    return Object.freeze({ measurementId: measurement.id, inputs, outputs: Object.freeze([]) })
                  try {
                    return Object.freeze({
                      measurementId: measurement.id,
                      inputs,
                      outputs: Object.freeze(stored.map((member) => predictionRecordedRowSample(member!))),
                    })
                  } catch {
                    return Object.freeze({
                      measurementId: measurement.id,
                      inputs,
                      outputs: Object.freeze([
                        Object.freeze({
                          layout: Object.freeze({
                            key: record.name,
                            dtype: 'float64' as const,
                            shape: Object.freeze([]),
                          }),
                          values: Object.freeze([Number.NaN]),
                        }),
                      ]),
                    })
                  }
                } catch {
                  return Object.freeze({
                    measurementId: measurement.id,
                    inputs: Object.freeze([]),
                    outputs: Object.freeze([]),
                  })
                }
              }),
            )
            const identity = {
              modelId: `${handle}:forward:${record.id}`,
              fingerprint: predictionFingerprint([
                definition.fingerprint,
                group.map((member) => [member.id, member.contract_hash]),
              ]),
            }
            try {
              assertTrainingCellLimit(rows)
              attempted.push(identity)
              const modal = rule.result.boxGrid?.frequencyKind === 'modal'
              const profile = await this.workerRequest(active, (client) =>
                client.build(identity.modelId, generation, identity.fingerprint, {
                  direction: 'forward',
                  fingerprint: identity.fingerprint,
                  inputKeys: layouts.map((layout) => layout.key),
                  outputKeys: group.map((member) => member.name),
                  outputDtypes: Object.freeze(
                    Object.fromEntries(
                      groupRules.map((member) => [member.label, member.result.dtype as PredictionNumericDtype]),
                    ),
                  ),
                  rows,
                  diagnoseMetadata: false,
                  fixedInputLayouts: layouts,
                  inputScaling: 'range',
                  weighting: algorithm.weighting,
                  ...(modal
                    ? { k: 1, nearestOnly: true }
                    : algorithm.kMode === 'manual'
                      ? { k: algorithm.manualK }
                      : {}),
                }),
              )
              models.push(Object.freeze({ ...identity, generation, profile, records: group, rules: groupRules }))
            } catch (error) {
              if (
                error instanceof PredictionWorkerRestartError ||
                error instanceof PredictionInstanceInvalidatedError ||
                (error as { name?: string })?.name === 'AbortError'
              )
                throw error
              group.forEach((member) => {
                errors[member.id] = error instanceof Error ? error.message : String(error)
              })
              await this.workerRequest(active, (client) =>
                client.drop(identity.modelId, generation, identity.fingerprint),
              )
            }
          }
        }
        this.assertCurrent(active)
        if (!models.length) throw new Error(Object.values(errors)[0] ?? '사용 가능한 ExperimentRecord 모델이 없습니다.')
        const profile = publicProfile(
          snapshot.direction === 'forward' ? aggregateForwardProfiles(models) : models[0].profile,
        )
        const prepared: PreparedPredictionModel = Object.freeze({
          fingerprint: definition.fingerprint,
          instance,
          profile,
          errors: Object.freeze(errors),
          recordProfiles: Object.freeze(
            snapshot.direction === 'forward'
              ? snapshot.records.map((record) => {
                  const model = models.find((entry) => entry.records.some((member) => member.id === record.id))
                  return Object.freeze({
                    recordId: record.id,
                    name: record.name,
                    error: errors[record.id] ?? null,
                    profile: model ? publicProfile(model.profile) : null,
                  })
                })
              : [],
          ),
          rules: Object.freeze(models.flatMap((model) => model.rules)),
        })
        this.models.set(
          handle,
          Object.freeze({
            prepared,
            models,
            varsSchema: snapshot.varsSchema,
            calculationIds:
              snapshot.direction === 'inverse' ? snapshot.calculations.map((calculation) => calculation.id) : [],
          }),
        )
        completed = prepared
        return prepared
      } catch (error) {
        if (!this.disposed && active.sessionId === this.sessionId) {
          const released = await Promise.allSettled(
            attempted.map((model) => this.client!.drop(model.modelId, generation, model.fingerprint)),
          )
          if (released.some((result) => result.status === 'rejected')) {
            this.client?.reset()
            this.models.clear()
          }
        }
        throw error
      }
    }).catch(async (error: unknown) => {
      if (completed) await this.release(completed.instance)
      throw error
    })
  }

  async predict(instance: PredictionModelInstance, input: PredictionInput, request: PredictionRequest) {
    return this.run(request, async (active): Promise<PredictionExecutionResult> => {
      const model = this.models.get(instance.handle)
      if (
        instance.executionId !== this.id ||
        instance.sessionId !== this.sessionId ||
        !model ||
        model.prepared.instance.generation !== instance.generation
      )
        throw new PredictionInstanceInvalidatedError('Prediction 모델 인스턴스가 현재 실행 세션에 없습니다.')
      if (model.prepared.profile.direction !== input.direction)
        throw new Error('Prediction 입력 방향이 모델과 다릅니다.')
      const query =
        input.direction === 'forward'
          ? predictionVarsSamples(input.vars, model.varsSchema)
          : model.calculationIds.map((id) => calculationOutputSample(id, input.targets[id]))
      const results = await Promise.all(
        model.models.map((entry) =>
          this.workerRequest(active, (client) =>
            client.predict(entry.modelId, entry.generation, entry.fingerprint, query),
          ),
        ),
      )
      this.assertCurrent(active)
      if (!this.models.has(instance.handle))
        throw new PredictionInstanceInvalidatedError('Prediction 모델이 반납되었습니다.', false)
      if (input.direction === 'inverse') {
        const { neighbors, ...result } = results[0]
        return Object.freeze({ ...result, fingerprint: model.prepared.fingerprint, knn: Object.freeze({ neighbors }) })
      }
      const neighbors = new Map<number, { distanceSquared: number; weight: number }>()
      results.forEach((result) =>
        result.neighbors.forEach((neighbor) => {
          const current = neighbors.get(neighbor.measurementId)
          neighbors.set(neighbor.measurementId, {
            distanceSquared: Math.min(current?.distanceSquared ?? Number.POSITIVE_INFINITY, neighbor.distanceSquared),
            weight: (current?.weight ?? 0) + neighbor.weight / results.length,
          })
        }),
      )
      return Object.freeze({
        direction: input.direction,
        fingerprint: model.prepared.fingerprint,
        output: Object.freeze(results.flatMap((result) => result.output)),
        knn: Object.freeze({
          neighbors: Object.freeze(
            [...neighbors.entries()]
              .map(([measurementId, neighbor]) => Object.freeze({ measurementId, ...neighbor }))
              .sort((a, b) => b.weight - a.weight || a.measurementId - b.measurementId),
          ),
        }),
        extrapolatedInputKeys: Object.freeze(
          [...new Set(results.flatMap((result) => result.extrapolatedInputKeys))].sort(),
        ),
        constantInputKeysChanged: Object.freeze(
          [...new Set(results.flatMap((result) => result.constantInputKeysChanged))].sort(),
        ),
        queryDiagnostics: Object.freeze(results.flatMap((result) => result.queryDiagnostics)),
      })
    })
  }

  cancel(requestId: string) {
    const active = this.requests.get(requestId)
    if (!active || active.abort.signal.aborted) return
    active.abort.abort()
    if (active.workerPending > 0 && active.sessionId === this.sessionId) {
      this.client?.reset()
      this.models.clear()
    }
  }

  async release(instance: PredictionModelInstance) {
    const model = this.models.get(instance.handle)
    if (
      !model ||
      instance.executionId !== this.id ||
      model.prepared.instance.sessionId !== instance.sessionId ||
      model.prepared.instance.generation !== instance.generation
    )
      return
    this.models.delete(instance.handle)
    if (this.disposed || instance.sessionId !== this.sessionId) return
    const released = await Promise.allSettled(
      model.models.map((entry) => this.client!.drop(entry.modelId, entry.generation, entry.fingerprint)),
    )
    if (
      released.some((result) => result.status === 'rejected') &&
      !this.disposed &&
      instance.sessionId === this.sessionId
    ) {
      this.client?.reset()
      this.models.clear()
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.requests.forEach((request) => request.abort.abort())
    this.requests.clear()
    this.models.clear()
    this.client?.dispose()
  }
}
