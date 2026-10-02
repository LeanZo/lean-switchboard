export type SwitchKind = 'plugin' | 'connector' | 'skill'

export type SwitchOrigin = 'default' | 'external'

export type SwitchItem = {
  /** Unique across kinds: `<kind>:<key>`. */
  id: string
  kind: SwitchKind
  /** What a toggle writes: the plugin id, the connector id, the skill name. */
  key: string
  name: string
  description: string
  /** `default`: made by Anthropic and shipped with Claude. `external`: anything else. */
  origin: SwitchOrigin
  /** Where it comes from, in words. */
  source: string
  isOn: boolean
  /** A skill override other than on or off (`name-only`, `user-invocable-only`). */
  mode?: string
  /** A plugin's install scope, passed to `claude plugin enable|disable`. */
  scope?: string
  /** The skillOverrides key that holds this skill's state, when it is not `key`. */
  overrideKey?: string
  /** Extra line shown under the name. */
  hint?: string
  /** Set when it cannot be turned on or off from here, saying why. */
  lockReason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'lean-switchboard': {
      items: SwitchItem[]
      kind: 'all' | SwitchKind
      origin: 'all' | SwitchOrigin
      query: string
      note: string | null
      busy: string[]
      changed: string[]
      isOpen: boolean
      isLoading: boolean
    }
  }
}
