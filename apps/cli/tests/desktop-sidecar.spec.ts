/** Desktop sidecar private-frame parser. */

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PROTOCOL_PREFIX,
  DesktopNativeChannel,
  parseDesktopFrame,
} from '../src/desktop-sidecar.ts'

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

  it('accepts only opaque digest asset identifiers', () => {
    const asset = 'a'.repeat(64)
    expect(parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: { op: 'asset-read', id: 'asset-1', asset },
    }))).toMatchObject({ request: { op: 'asset-read', asset } })
    expect(() => parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: { op: 'asset-read', id: 'asset-1', asset: '../client.js' },
    }))).toThrow(/64-character lowercase hex digest/)
  })

  it('accepts only content-addressed normalized game assets', () => {
    const asset = 'b'.repeat(64)
    expect(parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: { op: 'game-asset-read', id: 'game-asset-1', asset, path: 'game.js' },
    }))).toMatchObject({ request: { op: 'game-asset-read', asset, path: 'game.js' } })
    expect(() => parseDesktopFrame(frame({
      v: 1,
      kind: 'request',
      request: { op: 'game-asset-read', id: 'game-asset-1', asset, path: '../secret' },
    }))).toThrow(/normalized lowercase relative text/)
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

  it('accepts native responses with exactly one outcome', () => {
    expect(parseDesktopFrame(frame({
      v: 1,
      kind: 'native-response',
      id: 'native-1',
      result: 'C:\\workspace',
    }))).toEqual({
      v: 1,
      kind: 'native-response',
      id: 'native-1',
      result: 'C:\\workspace',
    })
    expect(() => parseDesktopFrame(frame({
      v: 1,
      kind: 'native-response',
      id: 'native-1',
      result: null,
      error: 'cancelled',
    }))).toThrow(/exactly one/)
  })

  it('accepts only bounded deep-link native events', () => {
    expect(parseDesktopFrame(frame({
      v: 1,
      kind: 'native-event',
      event: 'deep-link',
      sessionId: 'session-1234',
    }))).toEqual({
      v: 1,
      kind: 'native-event',
      event: 'deep-link',
      sessionId: 'session-1234',
    })
    expect(() => parseDesktopFrame(frame({
      v: 1,
      kind: 'native-event',
      event: 'credential',
      sessionId: 'session-1234',
    }))).toThrow(/deep-link session id/)
  })

  it('round-trips a Rust native request and discards its late cancelled response', async () => {
    const channel = new DesktopNativeChannel()
    const sent: Record<string, unknown>[] = []
    channel.install((outbound) => {
      sent.push(outbound)
      return Promise.resolve()
    })
    const abort = new AbortController()
    const pending = channel.request({ op: 'pick-directory' }, abort.signal)
    expect(sent[0]).toEqual({
      kind: 'native-request',
      id: 'native-1',
      request: { op: 'pick-directory' },
    })
    channel.handle({ v: 1, kind: 'native-response', id: 'native-1', result: 'C:\\workspace' })
    await expect(pending).resolves.toBe('C:\\workspace')

    const cancelled = channel.request({ op: 'pick-directory' }, abort.signal)
    abort.abort(new Error('caller left'))
    await expect(cancelled).rejects.toThrow('caller left')
    channel.handle({ v: 1, kind: 'native-response', id: 'native-2', result: null })
    expect(sent.at(-1)).toEqual({ kind: 'native-cancel', id: 'native-2' })
  })

  it('carries only bounded media intent to the Rust shell', async () => {
    const channel = new DesktopNativeChannel()
    const sent: Record<string, unknown>[] = []
    channel.install((outbound) => {
      sent.push(outbound)
      return Promise.resolve()
    })
    const pending = channel.request({
      op: 'media-companion',
      url: 'https://www.bilibili.com/video/BV1x',
      active: true,
    }, new AbortController().signal)
    expect(sent[0]).toEqual({
      kind: 'native-request',
      id: 'native-1',
      request: {
        op: 'media-companion',
        url: 'https://www.bilibili.com/video/BV1x',
        active: true,
      },
    })
    channel.handle({ v: 1, kind: 'native-response', id: 'native-1', result: null })
    await expect(pending).resolves.toBeNull()
  })

  it('carries one complete game presentation intent to the Rust shell', async () => {
    const channel = new DesktopNativeChannel()
    const sent: Record<string, unknown>[] = []
    channel.install((outbound) => {
      sent.push(outbound)
      return Promise.resolve()
    })
    const pending = channel.request({
      op: 'game-companion',
      url: `dsh-game://localhost/${'a'.repeat(64)}/index.html`,
      title: '2048',
      mode: 'attention',
      activeAgentCount: 0,
      reason: 'work-complete',
    }, new AbortController().signal)
    expect(sent[0]).toMatchObject({
      kind: 'native-request',
      request: { op: 'game-companion', title: '2048', mode: 'attention', reason: 'work-complete' },
    })
    channel.handle({ v: 1, kind: 'native-response', id: 'native-1', result: null })
    await expect(pending).resolves.toBeNull()
  })
})
