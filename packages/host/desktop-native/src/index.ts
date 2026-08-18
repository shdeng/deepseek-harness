/**
 * Service Definition for native desktop operations owned by the supervised
 * Rust shell. Host Consumers call this service; the WebView never receives a
 * Tauri command for these operations.
 * @module @deepseek-ai/dsh-host-desktop-native
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'

/** Metadata read from the signed desktop application package. */
export interface DesktopApplicationMetadata {
  /** User-visible product name. */
  name: string
  /** Installed application version. */
  version: string
  /** Platform registration identifier. */
  identifier: string
}

/** Bounded operating-system notification content. */
export interface DesktopNotification {
  /** Notification heading. */
  title: string
  /** Plain-text notification detail. */
  body: string
}

/** Desired state of the Tauri-owned Bilibili companion window. */
export interface DesktopMediaCompanion {
  /** Initial Bilibili page; later in-window navigation remains operator-owned. */
  url: string
  /** Whether Rust shows/focuses/plays (`true`) or pauses/hides (`false`) the window. */
  active: boolean
}

/** Complete desired state of the isolated Desktop game window. */
export interface DesktopGameCompanion {
  /** Content-addressed `dsh-game` entry URL minted by the game registry. */
  url: string
  /** Bounded title of the selected local game. */
  title: string
  /** Hidden, human-playable, or attention-blocked presentation state. */
  mode: 'hidden' | 'playable' | 'attention'
  /** Current aggregate count displayed by the game while play is enabled. */
  activeAgentCount: number
  /** Why an attention overlay blocks play. */
  reason?: 'work-complete' | 'approval'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The Rust shell accepted a registered application deep link.
     * @mode emit
     * @param sessionId - opaque session selected by the deep link.
     */
    'desktopNative/deep-link'(sessionId: string): void
  }
  interface Context {
    desktopNative: DesktopNative
  }
}

/** Native desktop operations that the Rust shell provides to the Node Host. */
export abstract class DesktopNative extends Service {
  constructor(ctx: Context) {
    super(ctx, 'desktopNative')
  }

  /**
   * Open the operating system directory chooser.
   * @param signal - caller lifetime; an aborted call discards any later chooser result.
   * @returns the selected absolute path, or null when the operator cancels.
   */
  abstract pickDirectory(signal: AbortSignal): Promise<string | null>

  /**
   * Prompt outside the WebView for a credential and store it in the operating system vault.
   * @param ref - opaque credential handle used as the vault account name.
   * @param signal - caller lifetime; abort discards any later prompt result.
   * @returns true when a value was stored, or false when the operator cancels.
   */
  abstract captureCredential(ref: CredentialRef, signal: AbortSignal): Promise<boolean>

  /**
   * Open one operator-visible web URL after Rust applies the desktop URL policy.
   * @param url - absolute http or https URL without embedded credentials.
   * @param signal - caller lifetime.
   */
  abstract openExternal(url: string, signal: AbortSignal): Promise<void>

  /**
   * Send one native operating-system notification.
   * @param notification - bounded plain-text title and body.
   * @param signal - caller lifetime.
   */
  abstract notify(notification: DesktopNotification, signal: AbortSignal): Promise<void>

  /**
   * Reconcile the isolated Bilibili WebView window with one activity state.
   * @param companion - configured Bilibili URL and the complete desired visibility/playback state.
   * @param signal - caller lifetime; abort discards any later completion.
   */
  abstract setMediaCompanion(companion: DesktopMediaCompanion, signal: AbortSignal): Promise<void>

  /**
   * Reconcile the isolated local-game WebView with one complete presentation intent.
   * @param companion - content-addressed game entry and complete desired UI state.
   * @param signal - caller lifetime; abort discards any later completion.
   */
  abstract setGameCompanion(companion: DesktopGameCompanion, signal: AbortSignal): Promise<void>

  /**
   * Read metadata from the running desktop package.
   * @param signal - caller lifetime.
   * @returns metadata owned by the Rust application package.
   */
  abstract metadata(signal: AbortSignal): Promise<DesktopApplicationMetadata>
}

export default DesktopNative
