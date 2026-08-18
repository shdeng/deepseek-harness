/** Private framed-stdio adapter used only by the Tauri desktop supervisor. */

import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { DesktopNative } from '@deepseek-ai/dsh-host-desktop-native'
import type {
  DesktopApplicationMetadata, DesktopGameCompanion, DesktopMediaCompanion, DesktopNotification,
} from '@deepseek-ai/dsh-host-desktop-native'
import type { GameAssetId } from '@deepseek-ai/dsh-game'
import type {} from '@deepseek-ai/dsh-game'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { ApiProxy, MuxFrame, HostFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import type { ProcessShutdown } from './process-shutdown.ts'

export const DESKTOP_PROTOCOL_PREFIX = 'DSH-IPC/1 '
export const DESKTOP_PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_ACTIVE_REQUESTS = 256
const INTERNAL_ORIGIN = 'http://127.0.0.1'

type StreamName = 'mux' | 'host'

interface FetchRequest {
  op: 'fetch'
  id: string
  path: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface StreamOpenRequest {
  op: 'stream-open'
  id: string
  stream: StreamName
  payload: unknown
}

interface AssetReadRequest {
  op: 'asset-read'
  id: string
  asset: string
}

interface GameAssetReadRequest {
  op: 'game-asset-read'
  id: string
  asset: string
  path: string
}

type DesktopRequest = FetchRequest | StreamOpenRequest | AssetReadRequest | GameAssetReadRequest

interface RequestFrame {
  v: 1
  kind: 'request'
  request: DesktopRequest
}

interface CancelFrame {
  v: 1
  kind: 'cancel'
  id: string
}

interface ShutdownFrame {
  v: 1
  kind: 'shutdown'
  id: string
}

export interface NativeResponseFrame {
  v: 1
  kind: 'native-response'
  id: string
  result?: unknown
  error?: string
}

export interface NativeEventFrame {
  v: 1
  kind: 'native-event'
  event: 'deep-link'
  sessionId: string
}

type InboundFrame = RequestFrame | CancelFrame | ShutdownFrame | NativeResponseFrame | NativeEventFrame

/**
 * Decode and validate one Rust-to-Node protocol line.
 * @param line - complete line read from supervised stdin.
 * @returns the version-one request frame.
 */
export function parseDesktopFrame(line: string): InboundFrame {
  if (!line.startsWith(DESKTOP_PROTOCOL_PREFIX)) {
    throw new Error('desktop sidecar frame is missing the DSH-IPC/1 prefix')
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`desktop sidecar frame exceeds ${String(MAX_FRAME_BYTES)} bytes`)
  }
  let value: unknown
  try {
    value = JSON.parse(line.slice(DESKTOP_PROTOCOL_PREFIX.length))
  } catch {
    throw new Error('desktop sidecar frame payload is not JSON')
  }
  if (!isRecord(value) || value.v !== DESKTOP_PROTOCOL_VERSION || typeof value.kind !== 'string') {
    throw new Error('desktop sidecar frame must carry protocol version 1 and a kind')
  }
  if (value.kind === 'cancel') {
    assertId(value.id)
    return { v: 1, kind: 'cancel', id: value.id }
  }
  if (value.kind === 'shutdown') {
    assertId(value.id)
    return { v: 1, kind: 'shutdown', id: value.id }
  }
  if (value.kind === 'native-response') {
    assertId(value.id)
    const hasResult = Object.hasOwn(value, 'result')
    const hasError = Object.hasOwn(value, 'error')
    if (hasResult === hasError || (hasError && typeof value.error !== 'string')) {
      throw new Error('desktop sidecar native response must carry exactly one of result or string error')
    }
    return {
      v: 1,
      kind: 'native-response',
      id: value.id,
      ...(hasResult ? { result: value.result } : { error: value.error as string }),
    }
  }
  if (value.kind === 'native-event') {
    if (value.event !== 'deep-link' || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0 || value.sessionId.length > 256) {
      throw new Error('desktop sidecar native event must carry a bounded deep-link session id')
    }
    return { v: 1, kind: 'native-event', event: 'deep-link', sessionId: value.sessionId }
  }
  if (value.kind !== 'request' || !isRecord(value.request)) {
    throw new Error(`desktop sidecar received unsupported frame kind ${JSON.stringify(value.kind)}`)
  }
  const request = value.request
  assertId(request.id)
  if (request.op === 'fetch') {
    if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//')) {
      throw new Error('desktop sidecar fetch path must be an absolute local path')
    }
    if (typeof request.method !== 'string' || !/^(GET|HEAD|POST)$/.test(request.method)) {
      throw new Error('desktop sidecar fetch method must be GET, HEAD, or POST')
    }
    if (!isStringRecord(request.headers)) {
      throw new Error('desktop sidecar fetch headers must be a string record')
    }
    if (request.body !== undefined && typeof request.body !== 'string') {
      throw new Error('desktop sidecar fetch body must be a string when present')
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && request.body !== undefined) {
      throw new Error('desktop sidecar GET and HEAD requests cannot carry a body')
    }
    return {
      v: 1,
      kind: 'request',
      request: {
        op: 'fetch',
        id: request.id,
        path: request.path,
        method: request.method,
        headers: request.headers,
        ...request.body === undefined ? {} : { body: request.body },
      },
    }
  }
  if (request.op === 'stream-open') {
    if (request.stream !== 'mux' && request.stream !== 'host') {
      throw new Error('desktop sidecar stream must be mux or host')
    }
    if (!isRecord(request.payload)) {
      throw new Error('desktop sidecar stream payload must be an object')
    }
    validateStreamPayload(request.stream, request.payload)
    return {
      v: 1,
      kind: 'request',
      request: {
        op: 'stream-open',
        id: request.id,
        stream: request.stream,
        payload: request.payload,
      },
    }
  }
  if (request.op === 'asset-read') {
    if (typeof request.asset !== 'string' || !/^[a-f0-9]{64}$/.test(request.asset)) {
      throw new Error('desktop sidecar asset id must be a 64-character lowercase hex digest')
    }
    return {
      v: 1,
      kind: 'request',
      request: { op: 'asset-read', id: request.id, asset: request.asset },
    }
  }
  if (request.op === 'game-asset-read') {
    if (typeof request.asset !== 'string' || !/^[a-f0-9]{64}$/.test(request.asset)) {
      throw new Error('desktop sidecar game asset id must be a 64-character lowercase hex digest')
    }
    if (typeof request.path !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/.test(request.path)
      || request.path.includes('..') || request.path.includes('//')) {
      throw new Error('desktop sidecar game asset path must be normalized lowercase relative text')
    }
    return {
      v: 1,
      kind: 'request',
      request: { op: 'game-asset-read', id: request.id, asset: request.asset, path: request.path },
    }
  }
  throw new Error(`desktop sidecar received unsupported request operation ${JSON.stringify(request.op)}`)
}

type SendFrame = (frame: Record<string, unknown>) => Promise<void>

interface PendingNativeRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  detachAbort(): void
}

/** Node half of Rust-provided Host operations over the supervised private protocol. */
export class DesktopNativeChannel {
  private sequence = 0
  private send: SendFrame | undefined
  private readonly pending = new Map<string, PendingNativeRequest>()
  private ctx: Context | undefined

  /** Bind native events to the desktop Host context. */
  bind(ctx: Context): void {
    if (this.ctx !== undefined) throw new Error('desktop native channel context is already bound')
    this.ctx = ctx
  }

  /** Attach the protocol writer once the sidecar read loop starts. */
  install(send: SendFrame): void {
    if (this.send !== undefined) throw new Error('desktop native channel writer is already installed')
    this.send = send
  }

  /**
   * Invoke one Rust operation.
   * @param op - closed native operation name.
   * @param signal - caller lifetime.
   * @returns the validated frame payload for operation-specific decoding.
   */
  async request(
    request:
      | { op: 'pick-directory' }
      | { op: 'capture-credential'; credential: CredentialRef }
      | { op: 'open-external'; url: string }
      | { op: 'notify'; title: string; body: string }
      | { op: 'media-companion'; url: string; active: boolean }
      | ({ op: 'game-companion' } & DesktopGameCompanion)
      | { op: 'metadata' },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw abortError(signal)
    const send = this.send
    if (send === undefined) throw new Error('desktop native channel is not ready')
    const id = `native-${String(++this.sequence)}`
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pending.delete(id)) {
          void send({ kind: 'native-cancel', id }).catch(() => {})
          reject(abortError(signal))
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        detachAbort: () => { signal.removeEventListener('abort', onAbort) },
      })
      void send({ kind: 'native-request', id, request }).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        pending.detachAbort()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Settle one Rust response after the wire parser has validated its envelope. */
  handle(frame: NativeResponseFrame): void {
    const pending = this.pending.get(frame.id)
    if (pending === undefined) return
    this.pending.delete(frame.id)
    pending.detachAbort()
    if (frame.error !== undefined) pending.reject(new Error(frame.error))
    else pending.resolve(frame.result)
  }

  /** Deliver one validated unsolicited Rust event into the Host event graph. */
  handleEvent(frame: NativeEventFrame): void {
    const ctx = this.ctx
    if (ctx === undefined) throw new Error('desktop native channel received an event before Host binding')
    ctx.emit('desktopNative/deep-link', frame.sessionId)
  }

  /** Reject every outstanding native operation and refuse future writes. */
  close(reason: string): void {
    this.send = undefined
    for (const pending of this.pending.values()) {
      pending.detachAbort()
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

class RustDesktopNative extends DesktopNative {
  constructor(ctx: Context, private readonly channel: DesktopNativeChannel) {
    super(ctx)
  }

  override async pickDirectory(signal: AbortSignal): Promise<string | null> {
    const result = await this.channel.request({ op: 'pick-directory' }, signal)
    if (result !== null && typeof result !== 'string') {
      throw new Error('Rust desktop directory picker returned neither a path nor cancellation')
    }
    return result
  }

  override async captureCredential(ref: CredentialRef, signal: AbortSignal): Promise<boolean> {
    const result = await this.channel.request({ op: 'capture-credential', credential: ref }, signal)
    if (typeof result !== 'boolean') {
      throw new Error('Rust desktop credential prompt returned a non-boolean outcome')
    }
    return result
  }

  override async openExternal(url: string, signal: AbortSignal): Promise<void> {
    const result = await this.channel.request({ op: 'open-external', url }, signal)
    if (result !== null) throw new Error('Rust desktop external-link opener returned an invalid outcome')
  }

  override async notify(notification: DesktopNotification, signal: AbortSignal): Promise<void> {
    const result = await this.channel.request({ op: 'notify', ...notification }, signal)
    if (result !== null) throw new Error('Rust desktop notification provider returned an invalid outcome')
  }

  override async setMediaCompanion(companion: DesktopMediaCompanion, signal: AbortSignal): Promise<void> {
    const result = await this.channel.request({ op: 'media-companion', ...companion }, signal)
    if (result !== null) throw new Error('Rust desktop media companion returned an invalid outcome')
  }

  override async setGameCompanion(companion: DesktopGameCompanion, signal: AbortSignal): Promise<void> {
    const result = await this.channel.request({ op: 'game-companion', ...companion }, signal)
    if (result !== null) throw new Error('Rust desktop game companion returned an invalid outcome')
  }

  override async metadata(signal: AbortSignal): Promise<DesktopApplicationMetadata> {
    const result = await this.channel.request({ op: 'metadata' }, signal)
    if (!isRecord(result) || typeof result.name !== 'string' || typeof result.version !== 'string'
      || typeof result.identifier !== 'string') {
      throw new Error('Rust desktop metadata provider returned an invalid object')
    }
    return { name: result.name, version: result.version, identifier: result.identifier }
  }
}

/**
 * Create the Rust-backed desktop service before the profile tree mounts.
 * @returns the channel and its root-context preparation hook.
 */
export function createDesktopNativeChannel(): {
  channel: DesktopNativeChannel
  provide: (ctx: Context) => void
} {
  const channel = new DesktopNativeChannel()
  return {
    channel,
    provide: (ctx) => {
      channel.bind(ctx)
      void new RustDesktopNative(ctx, channel)
      ctx.effect(() => () => { channel.close('desktop Host context was disposed') })
    },
  }
}

/**
 * Run the private desktop adapter until the supervisor requests shutdown.
 * @param runtime - booted Host context and its bounded shutdown controller.
 */
export async function runDesktopSidecar(
  runtime: { ctx: Context; shutdown: ProcessShutdown },
  native: DesktopNativeChannel,
): Promise<void> {
  const connection = runtime.ctx.get('connection')
  const api = runtime.ctx.get('apiProxy')
  const modules = runtime.ctx.get('clientModules')
  if (connection === undefined || api === undefined || modules === undefined) {
    throw new Error('desktop sidecar requires Connection, API Proxy, and Client Modules services')
  }

  const assetIds = new Map<string, string>()
  const graph = modules.graph()
  const manifest = {
    rev: graph.rev,
    entries: graph.entries.map((entry) => {
      const asset = createHash('sha256').update(`${entry.id}\0${entry.rev}`).digest('hex')
      assetIds.set(asset, entry.id)
      return { ...entry, url: `dsh-plugin://localhost/${asset}/client.js?rev=${entry.rev}` }
    }),
  }

  const active = new Map<string, AbortController>()
  let stopping = false
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = async (frame: Record<string, unknown>): Promise<void> => {
    const encoded = `${DESKTOP_PROTOCOL_PREFIX}${JSON.stringify({ v: 1, ...frame })}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
      throw new Error(`desktop sidecar output frame exceeds ${String(MAX_FRAME_BYTES)} bytes`)
    }
    if (!process.stdout.write(encoded)) await once(process.stdout, 'drain')
  }
  native.install(send)
  const fail = async (error: unknown): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      await send({ kind: 'fatal', message: error instanceof Error ? error.message : String(error) })
    } catch (writeError) {
      console.error('dsh desktop sidecar could not report its fatal protocol error:', writeError)
    }
    for (const controller of active.values()) controller.abort()
    active.clear()
    native.close('desktop sidecar failed')
    input.close()
    await runtime.shutdown.shutdown(1)
  }

  input.on('line', (line) => {
    void (async () => {
      const frame = parseDesktopFrame(line)
      if (frame.kind === 'native-response') {
        native.handle(frame)
        return
      }
      if (frame.kind === 'native-event') {
        native.handleEvent(frame)
        return
      }
      if (frame.kind === 'cancel') {
        active.get(frame.id)?.abort()
        return
      }
      if (frame.kind === 'shutdown') {
        if (stopping) return
        stopping = true
        for (const controller of active.values()) controller.abort()
        active.clear()
        native.close('desktop sidecar is shutting down')
        await runtime.shutdown.shutdown(0)
        await send({ kind: 'shutdown-complete', id: frame.id })
        input.close()
        return
      }
      if (stopping) {
        throw new Error('desktop sidecar received a request after shutdown began')
      }
      const { request } = frame
      if (active.size >= MAX_ACTIVE_REQUESTS) {
        await send({ kind: 'response', id: request.id, error: 'desktop sidecar has too many active requests' })
        return
      }
      if (active.has(request.id)) {
        throw new Error(`desktop sidecar request id ${JSON.stringify(request.id)} is already active`)
      }
      const controller = new AbortController()
      active.set(request.id, controller)
      if (request.op === 'fetch') {
        try {
          const response = await connection.fetch(new Request(new URL(request.path, INTERNAL_ORIGIN), {
            method: request.method,
            headers: request.headers,
            ...request.body === undefined ? {} : { body: request.body },
            signal: controller.signal,
          }))
          await send({
            kind: 'response',
            id: request.id,
            result: {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: await response.text(),
            },
          })
        } catch (error) {
          await send({ kind: 'response', id: request.id, error: error instanceof Error ? error.message : String(error) })
        } finally {
          active.delete(request.id)
        }
        return
      }
      if (request.op === 'asset-read') {
        try {
          const entryId = assetIds.get(request.asset)
          const asset = entryId === undefined ? undefined : await modules.readAsset(entryId)
          if (asset === undefined) {
            await send({ kind: 'response', id: request.id, error: 'desktop client asset was not found' })
          } else {
            await send({
              kind: 'response',
              id: request.id,
              result: {
                contentType: asset.contentType,
                body: Buffer.from(asset.body).toString('base64'),
              },
            })
          }
        } catch (error) {
          await send({ kind: 'response', id: request.id, error: error instanceof Error ? error.message : String(error) })
        } finally {
          active.delete(request.id)
        }
        return
      }
      if (request.op === 'game-asset-read') {
        try {
          const games = runtime.ctx.get('games')
          const asset = games?.readAsset(request.asset as GameAssetId, request.path)
          if (asset === undefined) {
            await send({ kind: 'response', id: request.id, error: 'desktop game asset was not found' })
          } else {
            await send({
              kind: 'response',
              id: request.id,
              result: {
                contentType: asset.contentType,
                body: Buffer.from(asset.body).toString('base64'),
              },
            })
          }
        } catch (error) {
          await send({ kind: 'response', id: request.id, error: error instanceof Error ? error.message : String(error) })
        } finally {
          active.delete(request.id)
        }
        return
      }
      await send({ kind: 'response', id: request.id, result: { opened: true } })
      void pumpStream(api, request, controller.signal, send).finally(() => {
        active.delete(request.id)
      })
    })().catch((error: unknown) => { void fail(error) })
  })

  input.once('close', () => {
    if (stopping) return
    void fail(new Error('desktop supervisor closed the private protocol pipe'))
  })
  await send({ kind: 'ready', manifest })
  await new Promise<void>(resolve => input.once('close', resolve))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop native operation was aborted')
}

async function pumpStream(
  api: ApiProxy,
  request: StreamOpenRequest,
  signal: AbortSignal,
  send: (frame: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  try {
    const frames = request.stream === 'mux'
      ? api.events.mux({ rpcId: RpcId(randomUUID()), payload: request.payload as Parameters<ApiProxy['events']['mux']>[0]['payload'] }, signal)
      : api.events.host({ rpcId: RpcId(randomUUID()), payload: request.payload as Parameters<ApiProxy['events']['host']>[0]['payload'] }, signal)
    for await (const frame of frames) {
      await send({ kind: 'stream-frame', id: request.id, message: fullFrame(frame) })
    }
    await send({ kind: 'stream-end', id: request.id })
  } catch (error) {
    if (signal.aborted) {
      await send({ kind: 'stream-end', id: request.id })
      return
    }
    await send({ kind: 'stream-end', id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}

function fullFrame(frame: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error('desktop sidecar request id must be 1-128 URL-safe ASCII characters')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}

function validateStreamPayload(stream: StreamName, payload: Record<string, unknown>): void {
  if (stream === 'host') {
    if (Object.keys(payload).length !== 0) throw new Error('desktop sidecar host stream payload must be empty')
    return
  }
  if (Object.keys(payload).some(key => key !== 'since')) {
    throw new Error('desktop sidecar mux stream payload may carry only since')
  }
  if (payload.since === undefined) return
  if (!isRecord(payload.since)
    || Object.entries(payload.since).some(([sessionId, seq]) =>
      sessionId.length === 0 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)) {
    throw new Error('desktop sidecar mux since must map non-empty session ids to non-negative integers')
  }
}
