import { describe, expect, it } from 'vitest'
import { createEchoGuard, createKeyedEchoGuard } from './echoGuard'

describe('createEchoGuard', () => {
  it('writes an unseen value, then suppresses it once stamped', () => {
    const g = createEchoGuard()
    expect(g.shouldWrite('a')).toBe(true)
    g.stamp('a')
    expect(g.shouldWrite('a')).toBe(false)
  })

  it('shouldWrite is a pure predicate — repeated calls never self-stamp', () => {
    const g = createEchoGuard()
    expect(g.shouldWrite('a')).toBe(true)
    expect(g.shouldWrite('a')).toBe(true)
  })

  it('a differing value writes again after a stamp', () => {
    const g = createEchoGuard()
    g.stamp('a')
    expect(g.shouldWrite('b')).toBe(true)
    g.stamp('b')
    expect(g.shouldWrite('b')).toBe(false)
    expect(g.shouldWrite('a')).toBe(true)
  })

  it('a seed suppresses that exact value on the first check', () => {
    const g = createEchoGuard('seed')
    expect(g.shouldWrite('seed')).toBe(false)
    expect(g.shouldWrite('other')).toBe(true)
  })

  it('no seed (undefined or null) writes the first time', () => {
    expect(createEchoGuard().shouldWrite('a')).toBe(true)
    expect(createEchoGuard(null).shouldWrite('a')).toBe(true)
  })
})

describe('createKeyedEchoGuard', () => {
  it('writes an unseen key, then suppresses it once stamped', () => {
    const g = createKeyedEchoGuard<string>()
    expect(g.shouldWrite('root', 'a')).toBe(true)
    g.stamp('root', 'a')
    expect(g.shouldWrite('root', 'a')).toBe(false)
  })

  it('isolates keys — a stamp on one key does not suppress another', () => {
    const g = createKeyedEchoGuard<string>()
    g.stamp('A', 'x')
    expect(g.shouldWrite('A', 'x')).toBe(false)
    expect(g.shouldWrite('B', 'x')).toBe(true)
  })

  it('reset() forgets every key', () => {
    const g = createKeyedEchoGuard<string>()
    g.stamp('A', 'x')
    g.stamp('B', 'y')
    g.reset()
    expect(g.shouldWrite('A', 'x')).toBe(true)
    expect(g.shouldWrite('B', 'y')).toBe(true)
  })
})
