import { describe, expect, it, vi } from 'vitest'
import { countWords, createWordCounter, SYNC_WORD_COUNT_LIMIT, type IdleScheduler } from './textMetrics'

/** The pattern StatusBar used before extraction -- countWords must match it. */
const legacyCount = (text: string): number =>
  (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length

describe('countWords', () => {
  it('returns 0 for the empty string', () => {
    expect(countWords('')).toBe(0)
  })

  it('counts plain words', () => {
    expect(countWords('hello world')).toBe(2)
  })

  it('does not count markdown syntax tokens as words', () => {
    expect(countWords('# Title\n\n* item\n> quote')).toBe(3)
  })

  it('keeps apostrophes and hyphens inside a single word', () => {
    expect(countWords("world's")).toBe(1)
    expect(countWords('test-case')).toBe(1)
    expect(countWords('it’s a well-known fact')).toBe(4)
  })

  it('counts Unicode letters and digits', () => {
    expect(countWords('héllo wörld über')).toBe(3)
    expect(countWords('第1章 テスト')).toBe(legacyCount('第1章 テスト'))
    expect(countWords('abc123 42')).toBe(2)
  })

  it('matches the legacy StatusBar regex on mixed markdown', () => {
    const samples = [
      '',
      '# Heading with *emphasis* and `code`\n\n- list-item one\n- l’autre',
      "don't --- won't -- end.",
      '   \n\t\n',
      'a-b-c d_e f',
    ]
    for (const s of samples) expect(countWords(s)).toBe(legacyCount(s))
  })
})

function fakeScheduler(): IdleScheduler & { fire(): void; pendingCount(): number } {
  let next = 0
  const scheduled = new Map<number, () => void>()
  return {
    schedule(cb) {
      const handle = next++
      scheduled.set(handle, cb)
      return handle
    },
    cancel(handle) {
      scheduled.delete(handle as number)
    },
    fire() {
      const cbs = [...scheduled.values()]
      scheduled.clear()
      for (const cb of cbs) cb()
    },
    pendingCount: () => scheduled.size,
  }
}

describe('createWordCounter', () => {
  it('counts synchronously at or below the limit', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 20, scheduler })

    counter.update('one two three')
    expect(onCount).toHaveBeenCalledWith(3)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('counts a text exactly at the limit synchronously', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 5, scheduler })

    counter.update('ab cd')
    expect(onCount).toHaveBeenCalledWith(2)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('defers counting above the limit until the idle callback fires', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 5, scheduler })

    counter.update('one two three four')
    expect(onCount).not.toHaveBeenCalled()
    expect(scheduler.pendingCount()).toBe(1)

    scheduler.fire()
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onCount).toHaveBeenCalledWith(4)
  })

  it('coalesces multiple deferred updates, counting only the latest text', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 5, scheduler })

    counter.update('one two three')
    counter.update('four five six seven')
    counter.update('eight nine')
    expect(scheduler.pendingCount()).toBe(1)

    scheduler.fire()
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onCount).toHaveBeenCalledWith(2)
  })

  it('an update at/below the limit cancels a pending deferred count', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 5, scheduler })

    counter.update('one two three four')
    counter.update('ab')
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onCount).toHaveBeenCalledWith(1)
    expect(scheduler.pendingCount()).toBe(0)

    scheduler.fire() // nothing scheduled -- stale count must not appear
    expect(onCount).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels a pending deferred count', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { syncLimit: 5, scheduler })

    counter.update('one two three four')
    counter.dispose()
    expect(scheduler.pendingCount()).toBe(0)

    scheduler.fire()
    expect(onCount).not.toHaveBeenCalled()
  })

  it('defaults to the exported sync limit', () => {
    const onCount = vi.fn()
    const scheduler = fakeScheduler()
    const counter = createWordCounter(onCount, { scheduler })

    counter.update('a'.repeat(SYNC_WORD_COUNT_LIMIT))
    expect(onCount).toHaveBeenCalledWith(1)

    counter.update('a'.repeat(SYNC_WORD_COUNT_LIMIT + 1))
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(scheduler.pendingCount()).toBe(1)
  })
})
