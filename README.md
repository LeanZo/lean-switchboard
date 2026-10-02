# Lean Switchboard

A [Claude Code](https://code.claude.com) mod that puts **every plugin, connector and skill in one list**, each with an on/off switch. Your changes apply to every new session.

No more digging through settings files, the `/plugin` menu, the connectors menu and `skillOverrides` to turn one thing off.

## What it does

- **One list** of everything Claude Code can load:
  - **Plugins**: installed from marketplaces, synced from claude.ai, or loaded from a local folder.
  - **Connectors**: your claude.ai connectors (Notion, Google Drive, …) and the Claude app's own servers.
  - **Skills**: built-in, synced from claude.ai, your own, and those that come with plugins.
- **A switch on every row.** Press it to turn the item on or off for new sessions.
- **Filters**:
  - by type: All, Plugins, Connectors or Skills.
  - by source: **Claude defaults** (made by Anthropic) or **External** (everything else).
  - by name, with a search box.
- **Clear labels**: each row says where the item comes from, marks what you changed this session, and explains anything that can't be switched from here.

## Install

In Claude Code, run:

```
/plugin marketplace add LeanZo/lean-switchboard
/plugin install lean-switchboard@lean-switchboard
```

Or from a terminal:

```bash
claude plugin marketplace add LeanZo/lean-switchboard
claude plugin install lean-switchboard@lean-switchboard
```

Start a new session afterwards, or run `/reload-plugins` in the current one.

## Use it

Open the list either way:

- Click **Lean Switchboard**, the small link at the right edge of the message box footer.
- Or type `/lean-switchboard`.

Then press **● On** or **○ Off** on any row. Close the list with **Close**, the link again, or Esc.

## How each switch works

| Item | What the switch changes |
| --- | --- |
| Plugin | Runs `claude plugin enable` or `claude plugin disable` for it (user scope). If that command isn't available, it sets `enabledPlugins` in `~/.claude/settings.json` directly. |
| Skill | Sets `skillOverrides` in `~/.claude/settings.json`: `"off"` to turn it off, and removes the entry to turn it back on. |
| Connector | Uses the Claude desktop app's own connector switch, the same one as **+ → Connectors** in the message box. It also becomes the default for new sessions. |

Your other settings are left as they are.

## What can't be switched here

Some rows show **locked** with the reason underneath:

- **Skills that come with a plugin.** Claude Code ignores per-skill settings for plugin skills. Turn the plugin off instead.
- **Things the Claude app loads by itself**, such as the `anthropic-skills` plugin or the app's built-in servers (for example `scheduled-tasks`).
- **Servers from a plugin, a project's `.mcp.json`, or `/mcp`.** They are managed in their own settings.
- **Anything set by your organization's managed settings.**

## Claude defaults vs External

- **Claude defaults**: plugins from Anthropic's marketplaces, skills built into Claude Code or published by Anthropic on claude.ai, and connectors that ship with the Claude app.
- **External**: everything else, such as third-party marketplaces, your own skills and plugins, and connectors to other services.

## Requirements

- Claude Code with mods (function-hook plugins) available. Mods are an early-access feature, so their API may change between releases. Tested on Claude Code **2.1.286**.
- Connector switches work in the **Claude desktop app** (Code tab). In the terminal, connectors are listed but locked: use `/mcp` there.

## Uninstall

```
/plugin uninstall lean-switchboard@lean-switchboard
/plugin marketplace remove lean-switchboard
```

## Development

```
plugins/lean-switchboard/
├── .claude-plugin/plugin.json   the plugin manifest
├── hooks/hooks.json             points to the hooks module
├── hooks/register.tsx           the mod: data loading, switches and the drawn list
├── types/index.d.ts             the mod's state contract
└── tests/                       tests run with `claude plugin test`
```

Useful commands:

```bash
claude plugin validate plugins/lean-switchboard
claude plugin test plugins/lean-switchboard
claude --plugin-dir plugins/lean-switchboard
```

`--plugin-dir` loads your local copy for that session and reloads it as you save. In an editor, run `/plugin-types` once to get type checking for the mod API.

## License

[MIT](LICENSE)
