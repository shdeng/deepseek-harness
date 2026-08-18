/** Exclusive Desktop companion selector. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { CompanionCardFace } from './companion-card-controller.ts'
import type {} from './slot-contract.ts'

export type CompanionCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.plugins'> & InjectFace<CompanionCardFace>
export function CompanionCard(props: CompanionCardProps) {
  const state = props.useCompanionCard(snapshot => snapshot)
  return <PluginCard t={props.t} titleKey="companionTitle" descriptionKey="companionDescription" state={state}
    onSave={props.save} onDiscard={props.discard}>
    <SelectField id="plugin-config-companion-mode" label={props.t('companionMode')} hint={props.t('companionModeHint')}
      overriddenLabel={props.t('overridden')} resetLabel={props.t('reset')} invalidLabel="" disabled={!state.writable}
      {...state.mode} onEdit={(text) => { props.edit('mode', text) }} onReset={() => { props.resetField('mode') }}
      options={[
        { value: 'off', label: props.t('companionOff') },
        { value: 'bilibili', label: props.t('companionBilibili') },
        { value: 'game', label: props.t('companionGame') },
      ]} />
  </PluginCard>
}
