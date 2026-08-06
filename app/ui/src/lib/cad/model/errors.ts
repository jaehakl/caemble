export class CadModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CadModelError'
  }
}
