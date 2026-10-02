import { describe, expect, it } from 'vitest'
import { redact, registerSecret } from '../src/main/logger'

describe('redact', () => {
  it('removes registered secrets and known key shapes', () => {
    registerSecret('dg_super_secret_value_123')
    expect(redact('key=dg_super_secret_value_123 ok')).toBe('key=[REDACTED] ok')
    expect(redact('Authorization: Token abcdef1234567890')).toBe('Authorization: Token [REDACTED]')
    expect(redact('x sk-ant-api03-AbC_d-123 y')).toBe('x [REDACTED] y')
  })
})
