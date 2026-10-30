import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import contributeServer from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  filterViableMcpServers,
  findWorkspaceMcpConfigPaths,
  getGlobalMcpConfigPath,
  isMcpInitializationErrorMessage,
  loadMcpConfigFile,
  parseMcpServer,
  probeHttpServer,
  probeStdioServer,
  resolveMcpServers,
  stripAnsi,
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
  const { messages: sseWarn, warn: sseCollector } = collector();
  assert.deepEqual(parseMcpServer({ type: "sse", url: "https://x/sse" }, "r", sseCollector)?.server, {
    type: "http",
    url: "https://x/sse",
  });
  assert.equal(sseWarn.length, 1);
  assert.match(sseWarn[0], /legacy HTTP\+SSE/);
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

test("parseMcpServer warns that alwaysLoad is a settings key, not a config field", () => {
  const { messages, warn } = collector();
  const entry = parseMcpServer({ command: "x", alwaysLoad: true }, "s", warn);
  assert.deepEqual(entry?.server, { type: "stdio", command: "x" });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /'alwaysLoad' is an Antigravity settings key/);
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
  write(path.join(cwd, ".agents", "mcp_config.json"), {
    mcpServers: {
      local: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"],
      },
    },
  });

  const sent: any[] = [];
  const connection = { send: async (input: any) => void sent.push(input), onEvent: () => () => {}, close: async () => {} };
  let registered: any;
  contributeServer(
    { registerProvider: (p: any) => void (registered = p), handle: () => {}, registerUsageSource: () => {}, before: () => () => {} } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  await conn.send({ type: "session.open", sessionId: "s", config: { cwd, mcpServers: { paseo: { type: "http", url: "http://p/mcp" } } } });
  await conn.send({ type: "session.interrupt", sessionId: "s" });

  assert.deepEqual(sent[0].config.mcpServers, {
    paseo: { type: "http", url: "http://p/mcp" },
    local: {
      type: "stdio",
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"],
    },
  });
  assert.deepEqual(sent[1], { type: "session.interrupt", sessionId: "s" });
});

test("provider connection supplies fallback cwd for catalog and sessions when omitted or root", async () => {
  const sent: any[] = [];
  const connection = { send: async (input: any) => void sent.push(input), onEvent: () => () => {}, close: async () => {} };
  let registered: any;
  contributeServer(
    { registerProvider: (p: any) => void (registered = p), handle: () => {}, registerUsageSource: () => {}, before: () => () => {} } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  await conn.send({ type: "catalog", requestId: "req-1" });
  await conn.send({ type: "catalog", requestId: "req-2", cwd: "/" });
  await conn.send({ type: "catalog", requestId: "req-3", cwd: "/custom/path" });
  await conn.send({ type: "sessions", requestId: "req-4" });

  assert.equal(sent[0].cwd, os.homedir());
  assert.equal(sent[1].cwd, os.homedir());
  assert.equal(sent[2].cwd, "/custom/path");
  assert.equal(sent[3].cwd, os.homedir());
});

test("isMcpInitializationErrorMessage identifies ACP MCP initialization failure text", () => {
  const sample =
    "The MCP server 'myserver' failed to initialize:  \x1b[31m× \x1b[0m File not found. " +
    "To get started, run:  \x1b[31m  \x1b[0m  \x1b[31m  \x1b[0m $ init: connection closed: calling " +
    '"initialize": client is closing: EOF. Fix the MCP server, or remove it from your configuration and start ' +
    "a new session, to continue.";
  assert.equal(isMcpInitializationErrorMessage(sample), true);
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

test("stripAnsi removes ANSI escape sequences and normalizes whitespace", () => {
  assert.equal(
    stripAnsi("The MCP server 'tool' failed: \x1b[31m×\x1b[0m \x1b[1mnot found\x1b[0m"),
    "The MCP server 'tool' failed: × not found",
  );
  assert.equal(stripAnsi("  line with   multiple   spaces  "), "line with multiple spaces");
  assert.equal(stripAnsi(null as any), "");
  assert.equal(stripAnsi(undefined as any), "");
});

test("probeStdioServer detects missing commands and startup failures", async () => {
  const missing = await probeStdioServer({ type: "stdio", command: "nonexistent-cmd-xyz" }, process.cwd(), 500);
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /spawn.*ENOENT/i);

  const crash = await probeStdioServer(
    { type: "stdio", command: "sh", args: ["-c", "exit 2"] },
    process.cwd(),
    500,
  );
  assert.equal(crash.ok, false);
  assert.match((crash as { reason: string }).reason, /exited with code 2/);

  const working = await probeStdioServer(
    {
      type: "stdio",
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"],
    },
    process.cwd(),
    1500,
  );
  assert.equal(working.ok, true);

  const rejectsDiscover = await probeStdioServer(
    {
      type: "stdio",
      command: process.execPath,
      args: [
        "-e",
        "let d = ''; process.stdin.on('data', c => { d += c; if (d.includes('server/discover')) { process.exit(1); } });",
      ],
    },
    process.cwd(),
    1500,
  );
  assert.equal(rejectsDiscover.ok, false);
  assert.match((rejectsDiscover as { reason: string }).reason, /exited with code 1/);
});

test("filterViableMcpServers filters out failing servers and preserves viable and existing ones", async () => {
  const { messages, warn } = collector();
  const input = {
    paseo: { type: "http" as const, url: "http://127.0.0.1:1/unreachable" },
    working: {
      type: "stdio" as const,
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"],
    },
    broken: { type: "stdio" as const, command: "nonexistent-cmd-12345" },
  };

  const filtered = await filterViableMcpServers(input, process.cwd(), {
    existingServerNames: new Set(["paseo"]),
    warn,
    timeoutMs: 500,
  });

  assert.deepEqual(Object.keys(filtered).sort(), ["paseo", "working"]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /MCP server 'broken' skipped: failed initialization probe/);
});

test("probeHttpServer returns ok: false on connection error or 401", async () => {
  const result = await probeHttpServer({ type: "http", url: "http://127.0.0.1:1/unreachable" }, 200);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /connection failed|fetch failed|ECONNREFUSED/i);
});

test("contributeServer suppresses MCP initialization errors but preserves normal assistant messages across sessions", async () => {
  let eventCallback: ((event: any) => void) | undefined;
  const connection = {
    send: async () => {},
    onEvent: (cb: (event: any) => void) => {
      eventCallback = cb;
      return () => {};
    },
    close: async () => {},
  };
  let registered: any;
  contributeServer(
    { registerProvider: (p: any) => void (registered = p), handle: () => {}, registerUsageSource: () => {}, before: () => () => {} } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  const received: any[] = [];
  conn.onEvent((event: any) => received.push(event));

  // 1. MCP initialization error event should be suppressed
  const mcpErrorEvent = {
    type: "timeline.item",
    sessionId: "session-1",
    item: {
      type: "assistant_message",
      id: "agent_message_chunk:1",
      text: "The MCP server 'broken' failed to initialize: file not found. Fix the MCP server, or remove it from your configuration and start a new session, to continue.",
    },
  };
  eventCallback!(mcpErrorEvent);
  assert.equal(received.length, 0, "MCP error event should be suppressed");

  // 2. Completed turn in session-1 must be converted to failed turn with mcp_initialization_failed
  eventCallback!({
    type: "session.turn",
    sessionId: "session-1",
    turnId: "turn-1",
    state: "completed",
  });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    type: "session.turn",
    sessionId: "session-1",
    turnId: "turn-1",
    state: "failed",
    error: {
      message:
        "The MCP server 'broken' failed to initialize: file not found. Fix the MCP server, or remove it from your configuration and start a new session, to continue.",
      code: "mcp_initialization_failed",
    },
  });

  // 3. Normal assistant message with identical sequence ID in subsequent session must NOT be suppressed
  const normalEvent1 = {
    type: "timeline.item",
    sessionId: "session-2",
    item: {
      type: "assistant_message",
      id: "agent_message_chunk:1",
      text: "Here is the current state of the workspace:",
    },
  };
  eventCallback!(normalEvent1);
  assert.equal(received.length, 2, "Normal message should be delivered");
  assert.equal(received[1].item.text, "Here is the current state of the workspace:");

  // 4. Normal reasoning chunk with another sequence ID must also be delivered
  const normalEvent2 = {
    type: "timeline.item",
    sessionId: "session-2",
    item: {
      type: "reasoning",
      id: "agent_thought_chunk:1",
      text: "Thinking about the workspace...",
    },
  };
  eventCallback!(normalEvent2);
  assert.equal(received.length, 3, "Reasoning message should be delivered");
  assert.equal(received[2].item.text, "Thinking about the workspace...");
});


