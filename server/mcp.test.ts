import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import contributeServer from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  findWorkspaceMcpConfigPaths,
  getGlobalMcpConfigPath,
  isDevenvAvailable,
  isMcpInitializationErrorMessage,
  loadMcpConfigFile,
  parseMcpServer,
  resolveMcpServers,
} from "./mcp.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function collector() {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
}

test("parseMcpServer infers transport and maps serverUrl to url", () => {
  const { warn } = collector();
  assert.deepEqual(parseMcpServer({ command: "node", args: ["a", 1, null], env: { A: "1", B: 2 } }, "s", warn), {
    server: { type: "stdio", command: "node", args: ["a"], env: { A: "1" } },
    oauth: false,
  });
  assert.deepEqual(parseMcpServer({ serverUrl: "https://x/mcp", headers: { Authorization: "Bearer t" } }, "r", warn), {
    server: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
    oauth: false,
  });
  assert.deepEqual(parseMcpServer({ type: "sse", url: "https://x/sse" }, "r", warn)?.server, {
    type: "sse",
    url: "https://x/sse",
  });
});

test("parseMcpServer rejects invalid entries with a warning and keeps disabled ones", () => {
  const { messages, warn } = collector();
  assert.equal(parseMcpServer(null, "a", warn), null);
  assert.equal(parseMcpServer({}, "b", warn), null);
  assert.equal(parseMcpServer({ type: "stdio" }, "c", warn), null);
  assert.equal(parseMcpServer({ type: "http" }, "d", warn), null);
  assert.equal(messages.length, 4);
  assert.deepEqual(parseMcpServer({ command: "x", disabled: true }, "e", warn), { server: null, oauth: false });
  assert.equal(messages.length, 4);
});

test("parseMcpServer warns about fields Paseo cannot forward", () => {
  const { messages, warn } = collector();
  const entry = parseMcpServer({ command: "x", cwd: "/w", authProviderType: "google_credentials", disabledTools: ["t"] }, "s", warn);
  assert.deepEqual(entry?.server, { type: "stdio", command: "x" });
  assert.equal(messages.length, 3);
  assert.match(messages[0], /'cwd' is not supported/);
});

test("loadMcpConfigFile survives missing, empty and malformed files", (t) => {
  const dir = tmp(t);
  const { messages, warn } = collector();
  assert.deepEqual(loadMcpConfigFile(path.join(dir, "missing.json"), warn), {});
  write(path.join(dir, "empty.json"), "  ");
  assert.deepEqual(loadMcpConfigFile(path.join(dir, "empty.json"), warn), {});
  assert.equal(messages.length, 0);
  write(path.join(dir, "bad.json"), "{ not json");
  assert.deepEqual(loadMcpConfigFile(path.join(dir, "bad.json"), warn), {});
  assert.match(messages[0], /invalid JSON/);
  write(path.join(dir, "mixed.json"), { mcpServers: { good: { command: "ok" }, bad: { type: "http" }, off: { command: "x", disabled: true } } });
  assert.deepEqual(Object.keys(loadMcpConfigFile(path.join(dir, "mixed.json"), warn)), ["good"]);
});

test("global config path honors geminiDir", () => {
  assert.equal(getGlobalMcpConfigPath({ geminiDir: "/g" }), path.join("/g", "config", "mcp_config.json"));
});

test("workspace discovery walks up to the repository root, nearest last", (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, ".git"));
  const nested = path.join(root, "a", "b");
  write(path.join(root, ".agents", "mcp_config.json"), {});
  write(path.join(root, "a", ".agent", "mcp_config.json"), {});
  write(path.join(nested, ".agents", "mcp_config.json"), {});
  assert.deepEqual(findWorkspaceMcpConfigPaths(nested), [
    path.join(root, ".agents", "mcp_config.json"),
    path.join(root, "a", ".agent", "mcp_config.json"),
    path.join(nested, ".agents", "mcp_config.json"),
  ]);
});

test("workspace discovery without a repository only checks cwd", (t) => {
  const root = tmp(t);
  write(path.join(root, ".agents", "mcp_config.json"), {});
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested);
  assert.deepEqual(findWorkspaceMcpConfigPaths(nested), []);
  assert.deepEqual(findWorkspaceMcpConfigPaths(root), [path.join(root, ".agents", "mcp_config.json")]);
});

test("resolveMcpServers precedence: global < existing < workspace, nearest wins, disabled removes", (t) => {
  const home = tmp(t);
  const repo = tmp(t);
  fs.mkdirSync(path.join(repo, ".git"));
  const cwd = path.join(repo, "pkg");
  fs.mkdirSync(cwd);
  const { messages, warn } = collector();

  write(path.join(home, "config", "mcp_config.json"), {
    mcpServers: {
      onlyGlobal: { command: "g" },
      shared: { command: "global" },
      overriddenByExisting: { command: "global" },
      removed: { command: "global" },
    },
  });
  write(path.join(repo, ".agents", "mcp_config.json"), { mcpServers: { shared: { command: "repo" }, deep: { command: "repo" } } });
  write(path.join(cwd, ".agents", "mcp_config.json"), {
    mcpServers: { deep: { command: "pkg" }, removed: { command: "x", disabled: true }, paseo: { serverUrl: "https://local/mcp" } },
  });

  const result = resolveMcpServers(
    cwd,
    {
      overriddenByExisting: { type: "stdio", command: "existing" },
      paseo: { type: "http", url: "http://127.0.0.1:1/mcp" },
    },
    { geminiDir: home, warn },
  );

  assert.deepEqual(result, {
    onlyGlobal: { type: "stdio", command: "g" },
    shared: { type: "stdio", command: "repo" },
    overriddenByExisting: { type: "stdio", command: "existing" },
    deep: { type: "stdio", command: "pkg" },
    paseo: { type: "http", url: "https://local/mcp" },
  });
  assert.deepEqual(messages, []);
});

test("resolveMcpServers keeps existing servers when no config exists", (t) => {
  const home = tmp(t);
  const cwd = tmp(t);
  const existing = { paseo: { type: "http", url: "http://127.0.0.1:1/mcp" } };
  assert.deepEqual(resolveMcpServers(cwd, existing, { geminiDir: home }), existing);
});

test("resolveMcpServers warns when an OAuth server has no cached token", (t) => {
  const home = tmp(t);
  const cwd = tmp(t);
  const { messages, warn } = collector();
  write(path.join(cwd, ".agents", "mcp_config.json"), {
    mcpServers: {
      secured: { serverUrl: "https://api.example.com/mcp", oauth: { clientId: "id", clientSecret: "s" } },
      plain: { serverUrl: "https://plain.example.com/mcp" },
    },
  });

  const result = resolveMcpServers(cwd, {}, { geminiDir: home, warn });
  assert.deepEqual(Object.keys(result).sort(), ["plain", "secured"]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /'secured' is configured for OAuth/);

  write(path.join(home, "antigravity", "mcp_oauth_tokens.json"), { "https://api.example.com/mcp": { accessToken: "t" } });
  messages.length = 0;
  resolveMcpServers(cwd, {}, { geminiDir: home, warn });
  assert.deepEqual(messages, []);
});

test("provider connection injects MCP servers into session.open only", async (t) => {
  const home = tmp(t);
  const cwd = tmp(t);
  const previous = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previous;
  });
  write(path.join(cwd, ".agents", "mcp_config.json"), { mcpServers: { local: { command: "tool" } } });

  const sent: any[] = [];
  const connection = { send: async (input: any) => void sent.push(input), onEvent: () => () => {}, close: async () => {} };
  let registered: any;
  contributeServer(
    { registerProvider: (p: any) => void (registered = p) } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  await conn.send({ type: "session.open", sessionId: "s", config: { cwd, mcpServers: { paseo: { type: "http", url: "http://p/mcp" } } } });
  await conn.send({ type: "session.interrupt", sessionId: "s" });

  assert.deepEqual(sent[0].config.mcpServers, {
    paseo: { type: "http", url: "http://p/mcp" },
    local: { type: "stdio", command: "tool" },
  });
  assert.deepEqual(sent[1], { type: "session.interrupt", sessionId: "s" });
});

test("isMcpInitializationErrorMessage identifies ACP MCP initialization failure text", () => {
  const userReported =
    "The MCP server 'devenv' failed to initialize:  \x1b[31m× \x1b[0m File devenv.nix does not exist. " +
    "To get started, run:  \x1b[31m  \x1b[0m  \x1b[31m  \x1b[0m $ devenv init: connection closed: calling " +
    '"initialize": client is closing: EOF. Fix the MCP server, or remove it from your configuration and start ' +
    "a new session, to continue.";
  assert.equal(isMcpInitializationErrorMessage(userReported), true);
  assert.equal(
    isMcpInitializationErrorMessage(
      "The MCP server 'custom' failed to initialize. Fix the MCP server, or remove it from your configuration and start a new session, to continue.",
    ),
    true,
  );
  assert.equal(isMcpInitializationErrorMessage("The MCP server 'x' failed to initialize: timeout"), true);
  assert.equal(
    isMcpInitializationErrorMessage(
      "Fix the MCP server, or remove it from your configuration and start a new session, to continue.",
    ),
    true,
  );

  assert.equal(isMcpInitializationErrorMessage("Here is your answer to the prompt."), false);
  assert.equal(isMcpInitializationErrorMessage(""), false);
  assert.equal(isMcpInitializationErrorMessage(null), false);
  assert.equal(isMcpInitializationErrorMessage(undefined), false);
  assert.equal(isMcpInitializationErrorMessage(123), false);
});

test("isDevenvAvailable verifies presence of devenv.nix in workspace or DEVENV_ROOT", (t) => {
  const root = tmp(t);
  const cwd = path.join(root, "sub");
  fs.mkdirSync(cwd);

  // Non-devenv stdio server is always available
  assert.equal(isDevenvAvailable({ type: "stdio", command: "node" }, cwd), true);
  // Remote server is always available
  assert.equal(isDevenvAvailable({ type: "http", url: "http://localhost:3000" }, cwd), true);

  // Devenv without devenv.nix is unavailable
  assert.equal(isDevenvAvailable({ type: "stdio", command: "devenv" }, cwd), false);
  assert.equal(isDevenvAvailable({ type: "stdio", command: "/nix/store/pkg/bin/devenv" }, cwd), false);

  // Devenv with devenv.nix in cwd or ancestor
  write(path.join(root, "devenv.nix"), "");
  assert.equal(isDevenvAvailable({ type: "stdio", command: "devenv" }, cwd), true);

  // Devenv with DEVENV_ROOT env
  const otherDir = tmp(t);
  assert.equal(
    isDevenvAvailable({ type: "stdio", command: "devenv", env: { DEVENV_ROOT: otherDir } }, cwd),
    false,
  );
  write(path.join(otherDir, "devenv.local.nix"), "");
  assert.equal(
    isDevenvAvailable({ type: "stdio", command: "devenv", env: { DEVENV_ROOT: otherDir } }, cwd),
    true,
  );
});

test("resolveMcpServers filters devenv when devenv.nix is missing and preserves it when present", (t) => {
  const home = tmp(t);
  const repoWithoutDevenv = tmp(t);
  fs.mkdirSync(path.join(repoWithoutDevenv, ".git"));
  const { messages, warn } = collector();

  write(path.join(repoWithoutDevenv, ".agents", "mcp_config.json"), {
    mcpServers: {
      devenv: { command: "devenv", args: ["mcp"] },
      tool: { command: "tool" },
    },
  });

  const filtered = resolveMcpServers(repoWithoutDevenv, {}, { geminiDir: home, warn });
  assert.deepEqual(filtered, {
    tool: { type: "stdio", command: "tool" },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /MCP server 'devenv' skipped: 'devenv.nix' does not exist/);

  // When devenv.nix exists, devenv is included
  const repoWithDevenv = tmp(t);
  fs.mkdirSync(path.join(repoWithDevenv, ".git"));
  write(path.join(repoWithDevenv, "devenv.nix"), "");
  write(path.join(repoWithDevenv, ".agents", "mcp_config.json"), {
    mcpServers: {
      devenv: { command: "devenv", args: ["mcp"] },
    },
  });
  messages.length = 0;
  const preserved = resolveMcpServers(repoWithDevenv, {}, { geminiDir: home, warn });
  assert.deepEqual(preserved, {
    devenv: { type: "stdio", command: "devenv", args: ["mcp"] },
  });
  assert.equal(messages.length, 0);
});
