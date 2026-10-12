---
name: plugin-creator
description: Create or edit a plugin for Spacron, Claude Code and Codex. Use when the user asks to make, build, scaffold or change a plugin, or to package MCP servers or skills so others can install them.
---

# Plugin Creator

A plugin is a folder that bundles MCP servers and skills so they can be
installed in one step. Spacron gives a plugin's MCP servers to every agent and
its chat, and its skills to Claude Code and Codex.

## Layout

```
<plugin-name>/
├── .claude-plugin/plugin.json   required manifest
├── .mcp.json                    MCP servers (optional)
├── skills/<skill-name>/SKILL.md one folder per skill (optional)
└── README.md                    what it does and how to set it up
```

Use lowercase-hyphenated names. Never put secrets in any file.

## .claude-plugin/plugin.json

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "0.1.0",
  "description": "One sentence: what it lets an agent do.",
  "author": { "name": "..." },
  "homepage": "https://...",
  "mcpServers": "./.mcp.json",
  "skills": "./skills/"
}
```

## .mcp.json

```json
{
  "mcpServers": {
    "hosted-example": { "type": "http", "url": "https://mcp.example.com/mcp" },
    "token-example": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${EXAMPLE_API_KEY}" }
    },
    "local-example": {
      "command": "npx",
      "args": ["-y", "some-mcp-server@1.2.3"],
      "env": { "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}" }
    }
  }
}
```

- Prefer the vendor's official hosted server URL. Find it in the vendor's docs;
  never guess a URL.
- Hosted servers that sign in with OAuth need no headers: Spacron signs the
  user in when the plugin is installed.
- Put anything secret in a `${VARIABLE}` placeholder. Spacron asks the user
  for each one at install time. `${NAME:-default}` supplies a default.
- `${CLAUDE_PLUGIN_ROOT}` is the plugin's own folder, for scripts it ships.
- Pin local packages to a version.

## skills/<skill-name>/SKILL.md

```markdown
---
name: skill-name
description: What it does and exactly when to use it (the agent reads this to decide).
---

# Title

Short, concrete, numbered steps. Name the MCP tools to call and in what order.
Say how to check the result. Keep it under about 300 lines.
```

## Steps

1. Ask what the plugin should let an agent do, and which services it touches,
   if the request does not say.
2. Create the folder and the manifest.
3. Add the MCP servers, from official sources only.
4. Write one skill per distinct job.
5. Write the README: what it does, which variables it needs, where to get them.
6. Check: plugin.json and .mcp.json parse as JSON; every skill has front matter
   with name and description; no secrets are written anywhere.
7. Tell the user to install it from Spacron: Settings > MCP & plugins > Add > Upload
   plugin archive, then choose the plugin folder (or a .zip of it). To share
   it, publish the folder in a GitHub repo with
   `.claude-plugin/marketplace.json`:

```json
{
  "name": "my-marketplace",
  "owner": { "name": "..." },
  "plugins": [
    { "name": "my-plugin", "description": "...", "source": "./plugins/my-plugin" }
  ]
}
```
