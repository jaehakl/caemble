export class CaeSimulationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CaeSimulationError'
  }
}
