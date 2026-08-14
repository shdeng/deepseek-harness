/** Desktop sidecar private-frame parser. */

import { describe, expect, it } from 'vitest'
import { DESKTOP_PROTOCOL_PREFIX, parseDesktopFrame } from '../src/desktop-sidecar.ts'

const frame = (value: unknown): string => `${DESKTOP_PROTOCOL_PREFIX}${JSON.stringify(value)}`

describe('desktop sidecar protocol', () => {
  it('accepts a versioned local fetch frame', () => {
    expect(parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: {
        op: 'fetch',
        id: 'request-1',
        path: '/api/host.describe',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    }))).toMatchObject({
      kind: 'request',
      request: { op: 'fetch', id: 'request-1', path: '/api/host.describe' },
    })
  })

  it('rejects missing versions, remote paths, and invalid ids', () => {
    expect(() => parseDesktopFrame('{}')).toThrow(/prefix/)
    expect(() => parseDesktopFrame(frame({ kind: 'cancel', id: 'request-1' }))).toThrow(/version 1/)
    expect(() => parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: { op: 'fetch', id: 'request-1', path: '//example.com/api', method: 'GET', headers: {} },
    }))).toThrow(/local path/)
    expect(() => parseDesktopFrame(frame({ v: 1, kind: 'cancel', id: 'not/a/request' }))).toThrow(/URL-safe/)
  })
})
