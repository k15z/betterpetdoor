# Connect an agent

Better Pet Door exposes a remote MCP server at:

```text
https://your-host.example/mcp
```

Replace `your-host.example` with your deployment. During OAuth, Better Pet Door asks for the same admin password used by the web app. It grants one `mcp` permission covering both status and control; there is no separate read-only permission.

The MCP server provides five tools:

- `list_pet_doors`
- `get_pet_door_status`
- `open_pet_door`
- `close_pet_door`
- `open_and_close_pet_door`

## 1. ChatGPT and Codex

### ChatGPT

1. Open **Settings → Security and login** and enable **Developer mode**.
2. Open **ChatGPT Plugins**, select the plus button, and add a server in developer mode.
3. Enter `https://your-host.example/mcp` as the server URL.
4. Complete OAuth with your Better Pet Door admin password.

These steps follow the [official OpenAI remote MCP instructions](https://developers.openai.com/api/docs/mcp/#connect-in-chatgpt).

### Codex app

1. Open **Settings → MCP servers**.
2. Select **Add server**.
3. Choose **Streamable HTTP** and enter `https://your-host.example/mcp`.
4. Save, restart, and complete OAuth when prompted.

### Codex CLI

```sh
codex mcp add betterpetdoor --url https://your-host.example/mcp
codex mcp login betterpetdoor
```

The login command opens Better Pet Door in your browser. Enter the admin password. See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) for other Codex surfaces.

## 2. Claude

### Claude.ai

1. Open **Settings → Connectors**.
2. Add a custom connector.
3. Enter `https://your-host.example/mcp`.
4. Complete OAuth with your Better Pet Door admin password.

### Claude Code

```sh
claude mcp add --transport http betterpetdoor https://your-host.example/mcp
```

Start Claude Code and run `/mcp` if it does not begin OAuth automatically. Complete OAuth in the browser.

## 3. Muse by Meta

Muse does not currently support MCP. Give it the OpenAPI document instead:

```text
https://your-host.example/openapi.json
```

Then tell Muse:

```text
Use this OpenAPI document to control my pet doors. Authenticate every API request with this HTTP header:

Authorization: Bearer <my Better Pet Door admin password>
```

The admin password grants full REST API access, including connecting and removing doors. Only provide it to an agent and conversation you trust. Never put it in source control or a URL.
