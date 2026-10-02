import { atom, read, update } from 'claude-code'
import type { CommandInfo, ContextMcpTool, ContextSkill, EngineInterface, Register, Settings } from 'claude-code'

import type { SwitchItem, SwitchKind, SwitchOrigin } from '../types'

type Engine = EngineInterface
type Json = Record<string, unknown>

const PANE = 'lean-switchboard'
const TITLE = 'Lean Switchboard'
const COMMAND = 'lean-switchboard'

const items = atom({ plugin: 'lean-switchboard', key: 'items' } as const, [])
const kindFilter = atom({ plugin: 'lean-switchboard', key: 'kind' } as const, 'all')
const originFilter = atom({ plugin: 'lean-switchboard', key: 'origin' } as const, 'all')
const query = atom({ plugin: 'lean-switchboard', key: 'query' } as const, '')
const note = atom({ plugin: 'lean-switchboard', key: 'note' } as const, null)
const busy = atom({ plugin: 'lean-switchboard', key: 'busy' } as const, [])
const changed = atom({ plugin: 'lean-switchboard', key: 'changed' } as const, [])
const isOpen = atom({ plugin: 'lean-switchboard', key: 'isOpen' } as const, false)
const isLoading = atom({ plugin: 'lean-switchboard', key: 'isLoading' } as const, false)

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'connector', label: 'Connectors' },
  { value: 'skill', label: 'Skills' },
] as const

const ORIGINS = [
  { value: 'all', label: 'Any source' },
  { value: 'default', label: 'Claude defaults' },
  { value: 'external', label: 'External' },
] as const

const SECTION: Record<SwitchKind, string> = {
  plugin: 'Plugins',
  connector: 'Connectors',
  skill: 'Skills',
}

// Marketplaces run by Anthropic: their plugins count as Claude defaults.
const ANTHROPIC_MARKETPLACES = new Set([
  'claude-plugins-official',
  'knowledge-work-plugins',
  'anthropic-plugin-directory',
  'anthropic-agent-skills',
])

// Connectors the Claude app ships itself, by lowercase name.
const CLAUDE_CONNECTORS = new Set([
  'claude docs',
  'visualize',
  'scheduled-tasks',
  'claude in chrome',
  'claude preview',
  'computer-use',
  'mcp-registry',
])

// Tools the Claude desktop app gives every Code session for its connectors.
const STATUS_TOOL = 'mcp__ccd_connectors__session_connectors_status'
const SET_TOOL = 'mcp__ccd_connectors__set_session_connector_enabled'

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function configDir($: Engine) {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) {
    return custom
  }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

  return `${home}/.claude`
}

async function readJson($: Engine, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

async function claude($: Engine, args: string[]) {
  try {
    return await $.process.run(['claude', ...args], { timeoutMs: 30_000 })
  } catch {
    return await $.process.run(['claude.exe', ...args], { timeoutMs: 30_000 })
  }
}

// Reads ~/.claude/settings.json, applies `change`, writes it back.
async function editUserSettings($: Engine, change: (settings: Json) => Json) {
  const path = `${await configDir($)}/settings.json`
  let current: Json = {}
  if (await $.fs.exists(path)) {
    const parsed = await readJson($, path)
    if (!isRecord(parsed)) {
      return 'settings.json is not valid JSON, so it was left alone'
    }
    current = parsed
  }
  await $.fs.write(path, `${JSON.stringify(change(current), null, 2)}\n`)

  return undefined
}

// Reads `<root>/<bucket>/manifest.json` for each synced bucket and collects one list from each.
async function syncedManifests($: Engine, root: string, field: 'plugins' | 'skills') {
  const rows: Json[] = []
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) {
      continue
    }
    const manifest = await readJson($, `${root}/${entry.name}/manifest.json`)
    const list = isRecord(manifest) ? manifest[field] : undefined
    if (Array.isArray(list)) {
      rows.push(...list.filter(isRecord))
    }
  }

  return rows
}

// ---------- Plugins ----------

type PluginRow = { id: string; scope?: string; enabled?: boolean; installPath?: string }

async function listPluginsWithCli($: Engine): Promise<PluginRow[] | undefined> {
  try {
    const run = await claude($, ['plugin', 'list', '--json'])
    if (run.exitCode !== 0) {
      return undefined
    }
    const parsed: unknown = JSON.parse(run.stdout)
    if (!Array.isArray(parsed)) {
      return undefined
    }

    return parsed.filter(isRecord).flatMap(row =>
      typeof row.id === 'string'
        ? [{
            id: row.id,
            scope: typeof row.scope === 'string' ? row.scope : undefined,
            enabled: row.enabled === true,
            installPath: typeof row.installPath === 'string' ? row.installPath : undefined,
          }]
        : [],
    )
  } catch {
    return undefined
  }
}

async function loadPlugins($: Engine, dir: string, user: Settings): Promise<SwitchItem[]> {
  const enabledPlugins = isRecord(user.enabledPlugins) ? user.enabledPlugins : {}
  const rows =
    (await listPluginsWithCli($)) ??
    Object.keys(enabledPlugins).map(id => ({ id, enabled: enabledPlugins[id] === true }) as PluginRow)

  const syncedMarketplace = new Map<string, string>()
  for (const row of await syncedManifests($, `${dir}/plugins/synced`, 'plugins')) {
    if (typeof row.name === 'string') {
      syncedMarketplace.set(row.name, String(row.marketplaceName ?? ''))
    }
  }

  return Promise.all(
    rows.map(async row => {
      const at = row.id.lastIndexOf('@')
      const name = at > 0 ? row.id.slice(0, at) : row.id
      const marketplace = at > 0 ? row.id.slice(at + 1) : ''
      const realMarketplace = marketplace === 'synced' ? (syncedMarketplace.get(name) ?? '') : marketplace
      const isAnthropic = ANTHROPIC_MARKETPLACES.has(realMarketplace) || realMarketplace.startsWith('anthropic')
      const manifest = row.installPath ? await readJson($, `${row.installPath}/.claude-plugin/plugin.json`) : undefined
      // Loaded with --plugin-dir or CLAUDE_CODE_PLUGIN_DIRS (`name@inline`, or `inline[n]` when its folder is gone):
      // no setting turns these off.
      const isLocalFolder = row.scope === 'session' || marketplace === 'inline' || row.id.startsWith('inline')
      const source =
        marketplace === 'synced'
          ? isAnthropic ? 'From claude.ai (Anthropic)' : 'From claude.ai (your uploads)'
          : isLocalFolder
            ? 'Local folder'
            : realMarketplace === 'claude-plugins-official'
              ? 'Anthropic marketplace'
              : `Marketplace: ${realMarketplace || 'unknown'}`
      const isManaged = row.scope === 'managed' || row.scope === 'policy'
      const item: SwitchItem = {
        id: `plugin:${row.id}`,
        kind: 'plugin',
        key: row.id,
        name,
        description: isRecord(manifest) && typeof manifest.description === 'string' ? manifest.description : '',
        origin: isAnthropic ? 'default' : 'external',
        source,
        isOn: row.enabled === true,
        scope: row.scope,
        hint: name === $.plugin.name ? 'This is Lean Switchboard itself. Turned off, new sessions lose this list.' : undefined,
        lockReason: isManaged
          ? 'Set by your organization.'
          : isLocalFolder
            ? 'Loaded from a local folder (--plugin-dir or CLAUDE_CODE_PLUGIN_DIRS). Remove it there to turn it off.'
            : undefined,
      }

      return item
    }),
  )
}

async function setPlugin($: Engine, item: SwitchItem, turnOn: boolean) {
  const scope = item.scope === 'project' || item.scope === 'local' ? item.scope : 'user'
  try {
    const run = await claude($, ['plugin', turnOn ? 'enable' : 'disable', item.key, '--scope', scope, '--json'])
    const line = run.stdout.split('\n').find(text => text.trim().startsWith('{'))
    const result: unknown = line ? JSON.parse(line) : undefined
    if (run.exitCode === 0 || (isRecord(result) && result.alreadyInGoalState === true)) {
      return undefined
    }
    if (scope !== 'user') {
      return isRecord(result) && typeof result.message === 'string' ? result.message : 'the claude command failed'
    }
  } catch (error) {
    if (scope !== 'user') {
      return errorText(error)
    }
  }

  // The CLI could not do it: write the user setting it would have written.
  return editUserSettings($, settings => ({
    ...settings,
    enabledPlugins: { ...(isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}), [item.key]: turnOn },
  }))
}

// ---------- Skills ----------

const SKILL_SOURCE: Record<string, string> = {
  'built-in': 'Built into Claude Code',
  bundled: 'Built into Claude Code',
  builtin: 'Built into Claude Code',
  userSettings: 'Your skills folder',
  projectSettings: 'This project',
  localSettings: 'This project',
  policySettings: 'Your organization',
  mcp: 'From a connector',
}

async function loadSkills(
  $: Engine,
  dir: string,
  user: Settings,
  commands: readonly CommandInfo[],
  listed: readonly ContextSkill[],
  plugins: readonly SwitchItem[],
) {
  const overrides = isRecord(user.skillOverrides) ? user.skillOverrides : {}
  const creators = new Map<string, string>()
  for (const row of await syncedManifests($, `${dir}/skills/synced`, 'skills')) {
    if (typeof row.name === 'string') {
      creators.set(row.name, String(row.creatorType ?? ''))
    }
  }
  const command = new Map(commands.map(one => [one.name, one]))
  const pluginByName = new Map(plugins.map(one => [one.name, one]))
  const extraPlugins = new Map<string, SwitchItem>()

  const toItem = (name: string, rawSource: string, pluginName?: string): SwitchItem => {
    const bare = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
    const overrideKey = name in overrides ? name : bare !== name && bare in overrides ? bare : undefined
    const mode = overrideKey ? String(overrides[overrideKey]) : 'on'
    let origin: SwitchOrigin = 'external'
    let source = SKILL_SOURCE[rawSource] ?? rawSource
    let lockReason: string | undefined

    if (rawSource === 'built-in' || rawSource === 'bundled' || rawSource === 'builtin') {
      origin = 'default'
    } else if (rawSource === 'syncedSkills') {
      const creator = creators.get(bare)
      const isAnthropic = creator ? creator === 'anthropic' : name.startsWith('anthropic-skills:')
      origin = isAnthropic ? 'default' : 'external'
      source = isAnthropic ? 'From claude.ai (Anthropic)' : 'From claude.ai (yours)'
    } else if (rawSource === 'plugin') {
      const owner = pluginName ?? (name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined)
      const plugin = owner ? pluginByName.get(owner) : undefined
      origin = plugin?.origin ?? (owner?.startsWith('anthropic') ? 'default' : 'external')
      source = owner ? `Plugin: ${owner}` : 'A plugin'
      lockReason = owner
        ? `Comes with the "${owner}" plugin. Turn the plugin off instead.`
        : 'Comes with a plugin. Turn the plugin off instead.'
      if (owner && !plugin && !extraPlugins.has(owner)) {
        extraPlugins.set(owner, {
          id: `plugin:${owner}`,
          kind: 'plugin',
          key: owner,
          name: owner,
          description: '',
          origin,
          source: 'Loaded by the Claude app',
          isOn: true,
          lockReason: 'The Claude app loads this plugin itself. It cannot be turned off here.',
        })
      }
    } else if (rawSource === 'policySettings') {
      lockReason = 'Set by your organization.'
    } else if (rawSource === 'mcp') {
      lockReason = 'Comes from a connector. Turn the connector off instead.'
    }

    return {
      id: `skill:${name}`,
      kind: 'skill',
      key: name,
      name,
      description: command.get(name)?.description ?? '',
      origin,
      source,
      isOn: mode !== 'off',
      mode: mode === 'on' || mode === 'off' ? undefined : mode,
      overrideKey,
      lockReason,
    }
  }

  const seen = new Set<string>()
  const skills: SwitchItem[] = []
  for (const skill of listed) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name)
      skills.push(toItem(skill.name, skill.source, skill.pluginName))
    }
  }
  // Skills that are off or hidden from the model are missing from the listing: add them back.
  for (const name of Object.keys(overrides)) {
    if (seen.has(name)) {
      continue
    }
    seen.add(name)
    const info = command.get(name)
    const rawSource =
      info?.source === 'builtin' ? 'built-in' : info?.source === 'plugin' ? 'plugin' : info?.source === 'mcp' ? 'mcp' : 'userSettings'
    skills.push(toItem(name, rawSource, info?.plugin))
  }
  // A plugin the Claude app loads even though the settings say off.
  const loadedPlugins = new Set(listed.flatMap(skill => (skill.pluginName ? [skill.pluginName] : [])))
  const hinted = plugins.map(plugin =>
    !plugin.isOn && loadedPlugins.has(plugin.name)
      ? { ...plugin, hint: 'The Claude app still loads it in its own sessions.' }
      : plugin,
  )

  return { skills, plugins: [...hinted, ...extraPlugins.values()] }
}

async function setSkill($: Engine, item: SwitchItem, turnOn: boolean) {
  return editUserSettings($, settings => {
    const overrides = { ...(isRecord(settings.skillOverrides) ? settings.skillOverrides : {}) }
    if (turnOn) {
      delete overrides[item.overrideKey ?? item.key]
      delete overrides[item.key]
    } else {
      overrides[item.key] = 'off'
    }
    const next: Json = { ...settings, skillOverrides: overrides }
    if (Object.keys(overrides).length === 0) {
      delete next.skillOverrides
    }

    return next
  })
}

// ---------- Connectors ----------

type ConnectorRow = { name: string; id?: string; kind?: string; status?: string; tool_count?: number }

const STATUS_TEXT: Record<string, string> = {
  connected: 'Connected',
  needs_auth: 'Needs sign-in',
  failed: 'Failed to connect',
  pending: 'Connecting',
  disabled: 'Off',
}

const isClaudeConnector = (row: ConnectorRow) =>
  CLAUDE_CONNECTORS.has(row.name.toLowerCase()) ||
  // The app's own connectors carry name-based (version 5) ids; installed ones carry random ids.
  (row.id !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/i.test(row.id))

async function loadConnectors($: Engine, mcpTools: readonly ContextMcpTool[]): Promise<SwitchItem[]> {
  try {
    const ran = await $.tool.call({ tool: STATUS_TOOL })
    const parsed: unknown = ran.deny === undefined && !ran.isError && ran.text ? JSON.parse(ran.text) : undefined
    const servers = isRecord(parsed) && Array.isArray(parsed.servers) ? parsed.servers.filter(isRecord) : undefined
    if (servers) {
      return servers.flatMap(server => {
        if (typeof server.name !== 'string') {
          return []
        }
        const row = server as ConnectorRow
        const isConnector = row.kind === 'connector'
        const status = STATUS_TEXT[row.status ?? ''] ?? row.status ?? ''
        const tools = row.tool_count ? ` · ${row.tool_count} tools` : ''
        const item: SwitchItem = {
          id: `connector:${row.id ?? row.name}`,
          kind: 'connector',
          key: row.id ?? row.name,
          name: row.name,
          description: `${status}${tools}`,
          origin: isClaudeConnector(row) || (!isConnector && row.kind === 'other') ? 'default' : 'external',
          source: isConnector ? 'claude.ai connector' : row.kind === 'other' ? 'Built into the Claude app' : `${row.kind ?? 'MCP'} server`,
          isOn: row.status !== 'disabled',
          lockReason: isConnector ? undefined : 'Managed in its own settings (its plugin, .mcp.json or /mcp).',
        }

        return [item]
      })
    }
  } catch {
    // Not in the Claude desktop app: fall back to what this session has connected.
  }

  const names = [...new Set(mcpTools.map(tool => tool.serverName))]

  return names.map(name => ({
    id: `connector:${name}`,
    kind: 'connector',
    key: name,
    name,
    description: 'Connected in this session',
    origin: isClaudeConnector({ name }) ? 'default' : 'external',
    source: 'MCP server',
    isOn: true,
    lockReason: 'Connectors can be switched here only in the Claude desktop app. Use /mcp instead.',
  }))
}

async function setConnector($: Engine, item: SwitchItem, turnOn: boolean) {
  try {
    const ran = await $.tool.call({ tool: SET_TOOL, connector: item.key, enabled: turnOn })
    if (ran.deny !== undefined) {
      return ran.deny
    }
    if (ran.isError) {
      return ran.text ?? 'the Claude app refused the change'
    }

    return undefined
  } catch (error) {
    return errorText(error)
  }
}

// ---------- Loading and toggling ----------

async function load($: Engine) {
  if (await read($, isLoading)) {
    return
  }
  await update($, isLoading, () => true)
  // Each part loads on its own, so one failure does not empty the whole list.
  const failures: string[] = []
  const safely = async <T,>(what: string, work: () => Promise<T>, fallback: T) => {
    try {
      return await work()
    } catch (error) {
      failures.push(`${what} (${errorText(error)})`)

      return fallback
    }
  }
  try {
    const dir = await safely('config folder', () => configDir($), '')
    const user: Settings = await safely('settings', () => $.settings.read({ source: 'user' }), {})
    const commands = await $.command.list().catch(() => [])
    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
    const breakdown = usage?.context.breakdown
    const plugins = await safely('plugins', () => loadPlugins($, dir, user), [])
    const skills = await safely(
      'skills',
      () => loadSkills($, dir, user, commands, breakdown?.skills?.skillFrontmatter ?? [], plugins),
      { skills: [], plugins },
    )
    const connectors = await safely('connectors', () => loadConnectors($, breakdown?.mcpTools ?? []), [])
    const byName = (a: SwitchItem, b: SwitchItem) => a.name.localeCompare(b.name)
    await update($, items, () => [
      ...skills.plugins.sort(byName),
      ...connectors.sort(byName),
      ...skills.skills.sort(byName),
    ])
    await update($, note, () => (failures.length > 0 ? `Could not load: ${failures.join('; ')}` : null))
  } finally {
    await update($, isLoading, () => false)
  }
}

async function toggle($: Engine, item: SwitchItem) {
  if (item.lockReason) {
    await update($, note, () => `"${item.name}": ${item.lockReason}`)

    return
  }
  if ((await read($, busy)).includes(item.id)) {
    return
  }
  await update($, busy, list => [...list, item.id])
  const turnOn = !item.isOn
  try {
    const error =
      item.kind === 'plugin'
        ? await setPlugin($, item, turnOn)
        : item.kind === 'skill'
          ? await setSkill($, item, turnOn)
          : await setConnector($, item, turnOn)
    if (error) {
      await update($, note, () => `Could not change "${item.name}": ${error}`)

      return
    }
    await update($, items, list =>
      list.map(one => (one.id === item.id ? { ...one, isOn: turnOn, mode: undefined, overrideKey: undefined } : one)),
    )
    await update($, changed, list => (list.includes(item.id) ? list.filter(id => id !== item.id) : [...list, item.id]))
    await update($, note, () => `"${item.name}" is now ${turnOn ? 'on' : 'off'} for new sessions.`)
  } catch (error) {
    await update($, note, () => `Could not change "${item.name}": ${errorText(error)}`)
  } finally {
    await update($, busy, list => list.filter(id => id !== item.id))
  }
}

async function openPane($: Engine) {
  const opened = await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
  if (!opened.isPlaced) {
    $.ui.toast('Widen the window to see the list.')
  }
  await update($, isOpen, () => true)
  void load($)
}

async function closePane($: Engine) {
  await $.ui.close({ id: PANE })
  await update($, isOpen, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // State survives a reload; work in flight does not.
    await update($, isLoading, () => false)
    await update($, busy, () => [])
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    await update($, isOpen, () => isUp)
    await $.command.register({
      name: COMMAND,
      description: 'Lean Switchboard: turn plugins, connectors and skills on or off for new sessions',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)

    return { text: 'Opened Lean Switchboard.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpen, () => false)
    }

    return next(e)
  })

  // A small dim link in the prompt footer, beside the engine's own mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = await read($, isOpen)
    const modes = e.props.modes.join(' & ')

    return (
      <Box flexDirection="row" gap={1}>
        {modes !== '' && <Text dimColor>{modes} ·</Text>}
        <Button
          key="switchboard-open"
          plain
          dimColor
          label={TITLE}
          onPress={() => (open ? closePane($) : openPane($))}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Input = 'Input' in table ? table.Input : undefined

    const all = await read($, items)
    const kind = await read($, kindFilter)
    const origin = await read($, originFilter)
    const search = (await read($, query)).trim().toLowerCase()
    const message = await read($, note)
    const working = await read($, busy)
    const touched = await read($, changed)
    const loading = await read($, isLoading)

    const visible = all.filter(
      item =>
        (kind === 'all' || item.kind === kind) &&
        (origin === 'all' || item.origin === origin) &&
        (search === '' || `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(search)),
    )
    const offCount = visible.filter(item => !item.isOn).length

    const chip = (key: string, label: string, isSelected: boolean, onPress: () => void) => (
      <Button key={key} label={label} {...(isSelected ? { variant: 'primary' as const } : { dimColor: true })} onPress={onPress} />
    )

    const row = (item: SwitchItem) => {
      const isBusy = working.includes(item.id)
      const meta = [
        item.origin === 'default' ? 'Claude default' : 'External',
        item.source,
        item.mode ? `mode: ${item.mode}` : '',
        touched.includes(item.id) ? 'changed, applies to new sessions' : '',
      ]
        .filter(Boolean)
        .join(' · ')

      // The switch sits first, in a column of its own, so long text can never push it out of view.
      return (
        <Box key={`row:${item.id}`} flexDirection="row" alignItems="flex-start" gap={2}>
          <Box flexDirection="column" minWidth={9} flexShrink={0}>
            {item.lockReason !== undefined ? (
              <Box flexDirection="column">
                <Text dimColor>{item.isOn ? 'On' : 'Off'}</Text>
                <Text dimColor italic>locked</Text>
              </Box>
            ) : (
              <Button
                key={`toggle:${item.id}`}
                label={isBusy ? '…' : item.isOn ? '● On' : '○ Off'}
                {...(item.isOn ? { variant: 'primary' as const } : {})}
                onPress={() => toggle($, item)}
              />
            )}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text bold wrap="truncate-end">{item.name}</Text>
            <Text dimColor wrap="truncate-end">{meta}</Text>
            {item.description !== '' && <Text dimColor wrap="truncate-end">{item.description}</Text>}
            {item.hint !== undefined && <Text dimColor italic wrap="wrap">{item.hint}</Text>}
            {item.lockReason !== undefined && <Text dimColor italic wrap="wrap">{item.lockReason}</Text>}
          </Box>
        </Box>
      )
    }

    const sections = (kind === 'all' ? (['plugin', 'connector', 'skill'] as const) : [kind]).map(section => {
      const list = visible.filter(item => item.kind === section)
      if (list.length === 0) {
        return null
      }

      return (
        <Box key={`section:${section}`} flexDirection="column" gap={1}>
          <Text bold>
            {SECTION[section]} ({list.length})
          </Text>
          {list.map(row)}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text dimColor wrap="wrap">
            Turn things on or off. Changes apply to new sessions.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="refresh" dimColor label={loading ? 'Loading…' : 'Refresh'} onPress={() => load($)} />
            <Button key="close" role="dismiss" label="Close" onPress={() => closePane($)} />
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {KINDS.map(option =>
            chip(`kind:${option.value}`, option.label, kind === option.value, () => update($, kindFilter, () => option.value)),
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {ORIGINS.map(option =>
            chip(`origin:${option.value}`, option.label, origin === option.value, () =>
              update($, originFilter, () => option.value),
            ),
          )}
        </Box>
        {Input !== undefined && (
          <Input
            key="search"
            placeholder="Search by name"
            value={search}
            submitLabel="search"
            onInput={value => update($, query, () => value)}
            onSubmit={value => update($, query, () => value)}
          />
        )}
        {message !== null && <Text>{message}</Text>}
        <Text dimColor>
          {loading && all.length === 0 ? 'Loading…' : `${visible.length} shown · ${offCount} off`}
        </Text>
        {sections}
      </Box>
    )
  })
}
