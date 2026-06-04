type CacheEntry<T> = {
  value: T
  expiresAt: number
}

export class InMemoryCache {
  private readonly store = new Map<string, CacheEntry<unknown>>()

  get<T>(key: string): T | null {
    const current = this.store.get(key)
    if (!current) {
      return null
    }

    if (Date.now() >= current.expiresAt) {
      this.store.delete(key)
      return null
    }

    return current.value as T
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    })
  }

  delete(key: string): void {
    this.store.delete(key)
  }
}
