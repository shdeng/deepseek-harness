/** Private framed-stdio adapter used only by the Tauri desktop supervisor. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy, MuxFrame, HostFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-client-connection'
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

type DesktopRequest = FetchRequest | StreamOpenRequest

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

type InboundFrame = RequestFrame | CancelFrame | ShutdownFrame

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
  throw new Error(`desktop sidecar received unsupported request operation ${JSON.stringify(request.op)}`)
}

/**
 * Run the private desktop adapter until the supervisor requests shutdown.
 * @param runtime - booted Host context and its bounded shutdown controller.
 */
export async function runDesktopSidecar(
  runtime: { ctx: Context; shutdown: ProcessShutdown },
): Promise<void> {
  const connection = runtime.ctx.get('connection')
  const api = runtime.ctx.get('apiProxy')
  if (connection === undefined || api === undefined) {
    throw new Error('desktop sidecar requires the Connection and API Proxy services')
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
    input.close()
    await runtime.shutdown.shutdown(1)
  }

  input.on('line', (line) => {
    void (async () => {
      const frame = parseDesktopFrame(line)
      if (frame.kind === 'cancel') {
        active.get(frame.id)?.abort()
        return
      }
      if (frame.kind === 'shutdown') {
        if (stopping) return
        stopping = true
        for (const controller of active.values()) controller.abort()
        active.clear()
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
  await send({ kind: 'ready' })
  await new Promise<void>(resolve => input.once('close', resolve))
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
