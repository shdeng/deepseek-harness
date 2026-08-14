import clsx from 'clsx'
import css from './AppLogo.module.css'

/** Display options for the shared application mark. */
export interface AppLogoProps {
  /** Square layout edge in px. */
  size?: number | undefined
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the DeepSeek Harness application mark.
 * @param props - display size and optional layout class.
 * @returns the decorative application mark.
 */
export function AppLogo({ size = 32, className }: AppLogoProps) {
  return (
    <span
      className={clsx(css.logo, className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}
