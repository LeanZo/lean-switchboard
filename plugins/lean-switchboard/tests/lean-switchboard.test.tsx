import { expect, test } from 'claude-code/testing'

const SERVERS = {
  servers: [
    { name: 'Notion', id: 'c80463d8-5624-4658-aa34-b4e6a35d0872', kind: 'connector', status: 'connected', tool_count: 44 },
    { name: 'Claude Docs', id: '1a59c906-04da-521d-bda7-7f71b9f9e01c', kind: 'connector', status: 'disabled' },
    { name: 'scheduled-tasks', kind: 'other', status: 'connected', tool_count: 6 },
  ],
}

const SETTINGS = {
  model: 'opus',
  enabledPlugins: { 'i-have-adhd@i-have-adhd': false, 'marketing@synced': true },
  skillOverrides: { 'find-skills': 'off' },
}

const FOOTER = {
  component: 'SessionMode',
  props: { modes: ['focus'] },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'lean-switchboard',
  props: {
    title: 'Lean Switchboard',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

// The engine may hand paths back with either slash.
const isSettings = (path: string) => path.replaceAll('\\', '/').endsWith('/Users/me/.claude/settings.json')

const NOTION = 'toggle:connector:c80463d8-5624-4658-aa34-b4e6a35d0872'

for (const surface of ['desktop', 'terminal'] as const) {
  test(`opens, lists, filters and toggles on ${surface}`, async ($, on) => {
    const sets: unknown[] = []
    let settingsText = JSON.stringify(SETTINGS)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))
    on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
    on('settings.read', () => ({ value: JSON.parse(settingsText) }))
    on('fs.exists', ($, e) => ({ value: isSettings(e.path) }))
    on('fs.read', ($, e) =>
      isSettings(e.path) ? { value: settingsText } : { deny: 'ENOENT' },
    )
    on('fs.write', ($, e) => {
      if (isSettings(e.path)) {
        settingsText = e.text
      }

      return { value: undefined }
    })
    on('tool.call', async ($, e, next) => {
      if (e.tool === 'mcp__ccd_connectors__session_connectors_status') {
        return { result: SERVERS, text: JSON.stringify(SERVERS) }
      }
      if (e.tool === 'mcp__ccd_connectors__set_session_connector_enabled') {
        sets.push({ connector: e.connector, enabled: e.enabled })

        return { result: { ok: true }, text: 'ok' }
      }

      return next(e)
    })

    const band = await $.ui.mount({ plugin: 'lean-switchboard', surface, ...FOOTER })
    await band.press({ key: 'switchboard-open' })

    const pane = await $.ui.mount({ plugin: 'lean-switchboard', surface, ...PANE })
    const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.some(text => text.startsWith('Could not'))).toBe(false)
    expect(texts).toContain('Notion')
    expect(texts).toContain('find-skills')
    expect(texts).toContain('marketing')
    expect((await pane.find({ key: NOTION }))?.text).toContain('On')
    // scheduled-tasks is managed elsewhere: no toggle button
    expect(await pane.find({ key: 'toggle:connector:scheduled-tasks' })).toBeUndefined()

    // Connector: goes through the Claude app's own switch
    await pane.press({ key: NOTION })
    expect(sets).toEqual([{ connector: 'c80463d8-5624-4658-aa34-b4e6a35d0872', enabled: false }])
    expect((await pane.find({ key: NOTION }))?.text).toContain('Off')

    // Skill: turning it on removes its override and keeps the other settings
    expect((await pane.find({ key: 'toggle:skill:find-skills' }))?.text).toContain('Off')
    await pane.press({ key: 'toggle:skill:find-skills' })
    expect(JSON.parse(settingsText)).toEqual({ model: 'opus', enabledPlugins: SETTINGS.enabledPlugins })
    expect((await pane.find({ key: 'toggle:skill:find-skills' }))?.text).toContain('On')

    // Plugin: no claude command in the test, so it writes enabledPlugins itself
    await pane.press({ key: 'toggle:plugin:marketing@synced' })
    expect(JSON.parse(settingsText).enabledPlugins['marketing@synced']).toBe(false)

    // Filters
    await pane.press({ key: 'origin:default' })
    let shown = (await pane.findAll({ type: 'Text' })).map(found => found.text)
    expect(shown).not.toContain('Notion')
    expect(shown).toContain('Claude Docs')
    await pane.press({ key: 'origin:all' })
    await pane.press({ key: 'kind:skill' })
    shown = (await pane.findAll({ type: 'Text' })).map(found => found.text)
    expect(shown).not.toContain('Notion')
    expect(shown).toContain('find-skills')
    await pane.input({ key: 'search', text: 'nothing-matches' })
    expect(await pane.find({ type: 'Text', text: 'find-skills' })).toBeUndefined()

    await pane.unmount()
    await band.unmount()
  })
}
