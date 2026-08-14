/** Tauri command/event carrier for the desktop WebView. */

import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { randomUuid } from './random-uuid.ts'

const STREAM_EVENT = 'dsh-ipc-stream'
const MAX_STREAM_INBOX = 1024

interface DesktopFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

interface DesktopStreamEvent {
  id: string
  message?: unknown
  end?: boolean
  error?: string
}

interface TauriEvent<T> {
  payload: T
}

interface DesktopTauri {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  }
  event: {
    listen<T>(event: string, handler: (event: TauriEvent<T>) => void): Promise<() => void>
  }
}

interface DesktopGlobal {
  __DSH_DESKTOP_IPC__?: boolean
  __TAURI__?: DesktopTauri
}

type StreamItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end'; error?: string }
type Parser<F> = { parse(value: unknown): F }

/**
 * Whether the current page was created by the desktop shell with Tauri IPC enabled.
 * @returns true only when both the shell marker and Tauri global API are present.
 */
export function hasDesktopIpc(): boolean {
  const global = globalThis as DesktopGlobal
  return global.__DSH_DESKTOP_IPC__ === true && global.__TAURI__ !== undefined
}

/**
 * Send one fetch-shaped request through WebView → Rust → Node.
 * @param input - logical Host URL; only its path and query cross IPC.
 * @param init - fetch request options supported by the desktop protocol.
 * @returns a browser Response reconstructed from the Node result.
 */
export async function desktopFetch(input: URL, init?: RequestInit): Promise<Response> {
  const tauri = requireTauri()
  const id = randomUuid()
  const signal = init?.signal ?? undefined
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  if (init?.body !== undefined && typeof init.body !== 'string') {
    throw new Error('desktop IPC supports string request bodies only')
  }
  const request = {
    op: 'fetch',
    id,
    path: `${input.pathname}${input.search}`,
    method: init?.method ?? 'GET',
    headers,
    ...init?.body === undefined ? {} : { body: init.body },
  }
  const cancel = (): void => {
    void tauri.core.invoke('desktop_ipc_cancel', { id }).catch(() => undefined)
  }
  signal?.throwIfAborted()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const pending = tauri.core.invoke<DesktopFetchResult>('desktop_ipc_request', { request })
    const result = signal === undefined ? await pending : await abortable(pending, signal)
    return new Response(result.body, { status: result.status, headers: result.headers })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** Desktop platform subclass: commands carry unary calls and events carry downstream streams. */
export class DesktopApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return desktopFetch(input, init)
  }

  protected override openMux(
    payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readDesktopStream('mux', payload, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readDesktopStream('host', payload, signal, hostFrameSchema, onOpen)
  }

  private async *readDesktopStream<F extends MuxFrame | HostFrame>(
    stream: 'mux' | 'host',
    payload: unknown,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const tauri = requireTauri()
    const id = randomUuid()
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: StreamItem<F>): void => {
      if (inbox.length >= MAX_STREAM_INBOX) {
        inbox.length = 0
        inbox.push({ kind: 'end', error: `desktop IPC stream exceeded its ${String(MAX_STREAM_INBOX)}-frame client queue` })
        wake?.()
        wake = undefined
        return
      }
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const unlisten = await tauri.event.listen<DesktopStreamEvent>(STREAM_EVENT, (event) => {
      if (event.payload.id !== id) return
      if (event.payload.end === true) {
        enqueue({ kind: 'end', ...event.payload.error === undefined ? {} : { error: event.payload.error } })
        return
      }
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(event.payload.message)
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed desktop IPC frame on ${stream}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    })
    const cancel = (): void => {
      void tauri.core.invoke('desktop_ipc_cancel', { id }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) {
        cancel()
        return
      }
      await tauri.core.invoke('desktop_ipc_request', {
        request: { op: 'stream-open', id, stream, payload },
      })
      onOpen?.()
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') {
            if (item.error !== undefined) throw new Error(item.error)
            return
          }
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      cancel()
      unlisten()
    }
  }
}

function requireTauri(): DesktopTauri {
  const tauri = (globalThis as DesktopGlobal).__TAURI__
  if (tauri === undefined) throw new Error('desktop IPC is unavailable in this WebView')
  return tauri
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const rejectAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('desktop IPC request was aborted'))
    }
    signal.addEventListener('abort', rejectAbort, { once: true })
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', rejectAbort)
    }).catch(() => undefined)
  })
}
