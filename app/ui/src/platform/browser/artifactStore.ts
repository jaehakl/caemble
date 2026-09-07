import type { BuildArtifact, BuildArtifactItem } from '@/contracts/build'

/** Items live on disk in IndexedDB; only the index and one item are retained in memory. */
export class BrowserArtifactStore {
  private constructor(
    readonly id: string,
    private readonly database: IDBDatabase,
  ) {}
  static async open(id: string) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caemble-build-artifacts', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('artifacts')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new BrowserArtifactStore(id, database)
  }
  private async transact(mode: IDBTransactionMode, key: string, value?: unknown) {
    return new Promise<unknown>((resolve, reject) => {
      const transaction = this.database.transaction('artifacts', mode)
      const store = transaction.objectStore('artifacts')
      const request = mode === 'readonly' ? store.get(`${this.id}/${key}`) : store.put(value, `${this.id}/${key}`)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Artifact storage transaction aborted.'))
    })
  }
  async saveItem(item: BuildArtifactItem, bytes: Uint8Array) {
    await this.transact('readwrite', item.file, bytes)
  }
  async readItem(item: BuildArtifactItem) {
    const bytes = await this.transact('readonly', item.file)
    if (!(bytes instanceof Uint8Array)) throw new Error(`Stored artifact item ${item.index} is missing.`)
    return bytes
  }
  async saveManifest(artifact: BuildArtifact) {
    await this.transact('readwrite', 'manifest.json', artifact)
  }
  async readManifest() {
    return this.transact('readonly', 'manifest.json')
  }
  close() {
    this.database.close()
  }
}
