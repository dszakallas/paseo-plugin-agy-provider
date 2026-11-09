# agy-provider

Use Google's official **Antigravity ACP server** in [Paseo](https://paseo.sh/docs/plugins/providers). This is a community-maintained plugin.

> [!NOTE]
> **Paseo 0.11 and later include native Antigravity support.** This repo is a maintained fork of
> [3ae3ae/paseo-plugin-agy-provider](https://github.com/3ae3ae/paseo-plugin-agy-provider), and aims to
> provide an alternative that directly drives the official ACP binary with active-turn steering,
> multi-source MCP discovery, and system prompt
> injection. See [DESIGN.md](DESIGN.md) for architecture details.

## Installation

### 1. Install the Antigravity CLI

On the **Paseo daemon host**, install the official `agy` CLI (version 1.5.0 or later, which includes the built-in `agy acp` subcommand). The plugin selects the command for the daemon host on macOS, Linux, or Windows:

| Platform | Executable | Plugin-supplied arguments |
| --- | --- | --- |
| macOS / Linux | `agy` | `acp` |
| Windows | `agy.exe` | `acp` |

Ensure `agy` is on the daemon's PATH, or set `PASEO_AGY_ACP_BIN` to the `agy` executable's absolute path. For example:

```sh
export PASEO_AGY_ACP_BIN="/opt/homebrew/bin/agy"
```

Set this in the environment that starts the daemon; exporting it in another terminal does not change a running daemon. Restart the daemon after changing its environment. The login terminal also needs **Node.js 22.18+** and the same CLI configuration.

### 2. Install the plugin

```sh
paseo plugin add git:dszakallas/paseo-plugin-agy-provider
```

For an existing installation, run `paseo plugin update agy-provider`.

### 3. Log in

1. Run `agy login` or `agy acp --login` in a terminal, or open a workspace in Paseo and choose **Antigravity: Log in with Google** from the **Command Center** (`Cmd+K` on macOS).
2. Complete Google's browser sign-in.
3. If the model list still shows an earlier authentication error, reload `agy-provider` in Settings → Plugins.

**No separate clone or npm install is needed.** Existing `agy` CLI authentication is shared automatically with `agy acp`. If you override `GEMINI_HOME`, use the same value for the daemon and login terminal.

### Gemini API key instead of Google sign-in

Set `GEMINI_API_KEY` securely in the daemon's launch environment. Merge this into `~/.gemini/antigravity-cli/settings.json`, preserving other settings:

```json
{
  "auth": { "type": "gemini-api-key" }
}
```

Use the corresponding path under `GEMINI_HOME` if overridden, and restart the daemon to load the environment. Both the key and `auth.type` are required. This route needs no browser or login-helper invocation. See [Google's authentication options](https://antigravity.google/docs/ide/extensions/zed).

## Usage

Choose **Antigravity (ACP)** in the model picker, or run:

```sh
paseo run --provider agy "Explain this project's entry point."
```

Models and modes come from the official server and your account.

### Modes & permissions

In addition to Antigravity's standard modes (**Default**, **Accept edits**, **Plan**), the plugin provides a **Dangerously skip permissions** mode (also compatible with legacy `yolo` mode). When active, tool permission prompts (such as shell commands and terminal execution) are automatically approved without user interaction.

To enable `--dangerously-skip-permissions` for all sessions at the server process level, set `PASEO_AGY_DANGEROUSLY_SKIP_PERMISSIONS=1` in the daemon's launch environment.

```sh
paseo plugin update agy-provider
paseo plugin reload agy-provider
paseo plugin remove agy-provider
```

Update the official server separately. Removing the plugin leaves Google's server, credentials, and conversations intact.

## MCP servers

MCP servers are loaded the way the `agy` CLI loads them and added to the servers Paseo already passes to the session. Later sources override earlier ones with the same name:

1. `~/.gemini/config/mcp_config.json` (or `$GEMINI_HOME/config/mcp_config.json`)
2. Servers supplied by Paseo
3. `.agents/mcp_config.json` (also `.agent`, `_agents`, `_agent`) in each directory from the repository root down to the session's working directory, nearest last. Without a `.git` directory only the working directory is checked.

```json
{
  "mcpServers": {
    "sqlite": { "command": "node", "args": ["server.js"], "env": { "DB": "/data/app.db" } },
    "remote": { "serverUrl": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer TOKEN" } },
    "broken": { "command": "flaky", "disabled": true }
  }
}
```

`"disabled": true` removes a server defined at a lower level. Invalid entries and unreadable files are skipped with a warning in `paseo plugin logs agy-provider`. The official server opens the connections; a server that fails to start is the server's concern and does not stop the plugin. Set `"disabled": true` on a server that breaks session startup.

`cwd`, `authProviderType` and `disabledTools` cannot be passed through Paseo and are ignored with a warning. For OAuth servers, authenticate once with the `agy` CLI or Antigravity IDE so the token is stored in `~/.gemini/antigravity/mcp_oauth_tokens.json`, or set an `Authorization` header. The plugin logs a warning when a server with an `oauth` block has no stored token.

## Limitations

- Real-agent verification covers macOS ARM64 and personal Google OAuth. Linux/Windows sessions, API-key and enterprise authentication, and physical mobile devices are unverified.
- Structured output guarantees are not implemented.
- The current server/shim can display duplicate tool rows.
- The login action requires an open workspace and the default plugin ID `agy-provider`. For a remote daemon, authentication runs on that host; the helper does not relay OAuth callbacks to another machine.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Executable not found | Daemon PATH or `PASEO_AGY_ACP_BIN`. |
| `Internal error` opening a session | Keep the companion executable beside the server; extract the full archive. |
| `Authentication required` | Use the login action, or check API-key configuration. |
| Plugin rejected on Paseo 0.11 or earlier | Update to a plugin revision whose manifest requires `>=0.12.0 <1.0.0`; check the client and daemon versions. |
| Plugin rejected on Paseo 1 or later | This plugin requires `<1.0.0`. |
| No models after login | Reload the plugin; check `paseo provider diagnostic agy`. |

Plugin startup logs: `paseo plugin logs agy-provider`. Remove credentials, OAuth links, and private content before sharing logs.

## Development

```sh
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugin-agy-provider
```

[Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security reports](SECURITY.md)

## License

[MIT](LICENSE) covers this repository's code. Google's proprietary server is installed separately under [Google's terms](https://antigravity.google/terms).
