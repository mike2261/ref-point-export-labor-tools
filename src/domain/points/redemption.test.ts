import { describe, it, expect } from 'vitest'
import { validateRedemption } from './redemption'

describe('validateRedemption', () => {
  it('rejects when no wallet amount is given', () => {
    const result = validateRedemption({ hasCustomerReward: true, balances: { a: 10, b: 10, c: 10 }, amounts: {} })
    expect(result).toEqual({ ok: false, error: 'INVALID_AMOUNT' })
  })

  it('rejects a non-positive or non-integer amount', () => {
    expect(
      validateRedemption({ hasCustomerReward: true, balances: { a: 10, b: 10, c: 10 }, amounts: { a: 0 } }),
    ).toEqual({ ok: false, error: 'INVALID_AMOUNT' })
    expect(
      validateRedemption({ hasCustomerReward: true, balances: { a: 10, b: 10, c: 10 }, amounts: { b: -5 } }),
    ).toEqual({ ok: false, error: 'INVALID_AMOUNT' })
    expect(
      validateRedemption({ hasCustomerReward: true, balances: { a: 10, b: 10, c: 10 }, amounts: { c: 1.5 } }),
    ).toEqual({ ok: false, error: 'INVALID_AMOUNT' })
  })

  it('is LOCKED for wallet B/C when the CTV never had a customer reward', () => {
    expect(
      validateRedemption({ hasCustomerReward: false, balances: { a: 0, b: 10, c: 10 }, amounts: { b: 5 } }),
    ).toEqual({ ok: false, error: 'LOCKED' })
    expect(
      validateRedemption({ hasCustomerReward: false, balances: { a: 0, b: 10, c: 10 }, amounts: { c: 5 } }),
    ).toEqual({ ok: false, error: 'LOCKED' })
  })

  it('wallet A is NEVER locked — a CTV can earn commission without ever landing their own customer', () => {
    const result = validateRedemption({
      hasCustomerReward: false,
      balances: { a: 100, b: 0, c: 0 },
      amounts: { a: 50 },
    })
    expect(result).toEqual({ ok: true })
  })

  it('mixing A with a locked B/C amount still locks the whole request', () => {
    const result = validateRedemption({
      hasCustomerReward: false,
      balances: { a: 100, b: 100, c: 0 },
      amounts: { a: 50, b: 50 },
    })
    expect(result).toEqual({ ok: false, error: 'LOCKED' })
  })

  it('reports insufficient balance per wallet, checked A then B then C', () => {
    const balances = { a: 10, b: 10, c: 10 }
    expect(
      validateRedemption({ hasCustomerReward: true, balances, amounts: { a: 11 } }),
    ).toEqual({ ok: false, error: 'INSUFFICIENT_A' })
    expect(
      validateRedemption({ hasCustomerReward: true, balances, amounts: { b: 11 } }),
    ).toEqual({ ok: false, error: 'INSUFFICIENT_B' })
    expect(
      validateRedemption({ hasCustomerReward: true, balances, amounts: { c: 11 } }),
    ).toEqual({ ok: false, error: 'INSUFFICIENT_C' })
  })

  it('accepts a valid multi-wallet redemption within balance', () => {
    const result = validateRedemption({
      hasCustomerReward: true,
      balances: { a: 100, b: 50, c: 20 },
      amounts: { a: 100, b: 50, c: 20 },
    })
    expect(result).toEqual({ ok: true })
  })
})
