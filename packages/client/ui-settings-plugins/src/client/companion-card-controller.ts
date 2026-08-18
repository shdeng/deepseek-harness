/** Companion card form over the `companion` settings namespace. */
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Host settings namespace for the exclusive Desktop companion. */
export const COMPANION_NS = 'companion'
/** Companion fields edited by this card. */
export interface CompanionSettings { mode?: 'off' | 'bilibili' | 'game' }
/** Render state for the companion card. */
export interface CompanionCardState extends CardShell { mode: CardFieldState }
/** Slot injection face for the companion card. */
export interface CompanionCardFace extends CardActions { hooks: { companionCard: SnapshotStore<CompanionCardState> } }

/** Bridges the companion settings scope onto a staged card form. */
export class CompanionCardController {
  private readonly form: CardForm<CompanionSettings>
  private readonly store: SnapshotStore<CompanionCardState>
  constructor(scope: SettingsScope<CompanionSettings>) {
    this.form = new CardForm(scope, [textField('mode')])
    this.store = this.form.bind(() => ({ ...this.form.shell(), mode: this.form.field('mode') }))
  }
  /**
   * Build the injection face consumed by the card renderer.
   * @returns the card snapshot and staged form actions.
   */
  inject(): CompanionCardFace { return { hooks: { companionCard: this.store }, ...this.form.actions() } }
}
