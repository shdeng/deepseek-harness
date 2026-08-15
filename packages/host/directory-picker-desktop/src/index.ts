/**
 * Desktop Provider of `ctx.directoryPicker`: adapts the Rust-backed
 * `ctx.desktopNative` Service to the existing native directory capability.
 * @module @deepseek-ai/dsh-host-directory-picker-desktop
 */

import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type {} from '@deepseek-ai/dsh-host-desktop-native'

/** The desktop directory picker backed by the Rust shell's native chooser. */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  /** Required Rust-backed desktop Host service. */
  static inject = ['desktopNative']

  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => this.ctx.desktopNative.pickDirectory(signal),
  }

  /**
   * Return the stable native chooser capability.
   * @returns the Rust-backed native capability.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
