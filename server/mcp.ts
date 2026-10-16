import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type McpStdioServer = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpRemoteServer = {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = (McpStdioServer | McpRemoteServer) & { alwaysLoad?: boolean };

/** A parsed config entry. `server: null` means the entry is explicitly disabled. */
type McpEntry = { server: McpServerConfig | null; oauth: boolean };

export type McpWarn = (message: string) => void;

export interface McpResolveOptions {
  /** Directory that replaces `~/.gemini`. Defaults to `$GEMINI_HOME`, then `~/.gemini`. */
  geminiDir?: string;
  warn?: McpWarn;
}

const LOG_PREFIX = "[agy-provider]";
const WORKSPACE_DIRS = [".agents", ".agent", "_agents", "_agent"];
// Fields agy-cli understands that cannot be expressed in Paseo's MCP server schema.
const UNSUPPORTED_FIELDS = ["cwd", "authProviderType", "disabledTools"];

const defaultWarn: McpWarn = (message) => console.warn(`${LOG_PREFIX} ${message}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

/**
 * Parses one `mcpServers` entry. Returns `null` for invalid entries, an entry with
 * `server: null` for disabled ones.
 */
export function parseMcpServer(raw: unknown, name = "server", warn: McpWarn = defaultWarn): McpEntry | null {
  if (!isRecord(raw)) {
    warn(`MCP server '${name}' ignored: expected an object.`);
    return null;
  }
  if (raw.disabled === true) return { server: null, oauth: false };

  const url = [raw.serverUrl, raw.url].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command : undefined;
  const explicitType = typeof raw.type === "string" ? raw.type : undefined;
  const type = explicitType ?? (command ? "stdio" : url ? "http" : undefined);

  for (const field of UNSUPPORTED_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) {
      warn(`MCP server '${name}': '${field}' is not supported through Paseo and was ignored.`);
    }
  }

  let server: McpServerConfig;
  if (type === "stdio") {
    if (!command) {
      warn(`MCP server '${name}' ignored: stdio server requires 'command'.`);
      return null;
    }
    server = { type: "stdio", command };
    if (Array.isArray(raw.args)) server.args = raw.args.filter((a): a is string => typeof a === "string");
    const env = stringRecord(raw.env);
    if (env) server.env = env;
  } else if (type === "http" || type === "sse") {
    if (!url) {
      warn(`MCP server '${name}' ignored: remote server requires 'serverUrl'.`);
      return null;
    }
    server = { type, url };
    const headers = stringRecord(raw.headers);
    if (headers) server.headers = headers;
  } else {
    warn(`MCP server '${name}' ignored: needs either 'command' or 'serverUrl'.`);
    return null;
  }
  if (typeof raw.alwaysLoad === "boolean") server.alwaysLoad = raw.alwaysLoad;
  return { server, oauth: isRecord(raw.oauth) };
}

function loadEntries(filePath: string, warn: McpWarn): Record<string, McpEntry> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`Cannot read MCP config ${filePath}: ${(error as Error).message}`);
    }
    return {};
  }
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(`Ignoring MCP config ${filePath}: invalid JSON (${(error as Error).message}).`);
    return {};
  }
  const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
  if (!isRecord(servers)) return {};

  const entries: Record<string, McpEntry> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const entry = parseMcpServer(raw, name, warn);
    if (entry) entries[name] = entry;
  }
  return entries;
}

/** Loads the enabled servers of one `mcp_config.json`. Never throws. */
export function loadMcpConfigFile(filePath: string, warn: McpWarn = defaultWarn): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(loadEntries(filePath, warn))) {
    if (entry.server) result[name] = entry.server;
  }
  return result;
}

export function getGeminiDir(options: McpResolveOptions = {}): string {
  return options.geminiDir ?? process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");
}

export function getGlobalMcpConfigPaths(options: McpResolveOptions = {}): string[] {
  const geminiDir = getGeminiDir(options);
  const candidates = [
    path.join(geminiDir, "config", "mcp_config.json"),
    path.join(geminiDir, "antigravity-cli", "mcp_config.json"),
    path.join(geminiDir, "antigravity", "mcp_config.json"),
  ];
  const existing: string[] = [];
  for (const c of candidates) {
    if (fs.existsSync(c) && !existing.includes(c)) existing.push(c);
  }
  return existing;
}

export function getGlobalMcpConfigPath(options: McpResolveOptions = {}): string {
  const paths = getGlobalMcpConfigPaths(options);
  return paths[0] ?? path.join(getGeminiDir(options), "config", "mcp_config.json");
}

export function getOAuthTokensPath(options: McpResolveOptions = {}): string {
  const geminiDir = getGeminiDir(options);
  const cliPath = path.join(geminiDir, "antigravity-cli", "mcp_oauth_tokens.json");
  if (fs.existsSync(cliPath)) return cliPath;
  return path.join(geminiDir, "antigravity", "mcp_oauth_tokens.json");
}

/**
 * Strips ANSI color / style escape sequences and normalizes horizontal whitespace for clean display.
 */
export function stripAnsi(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

/**
 * Detects whether a message text corresponds to an ACP MCP server initialization failure.
 * When an MCP server fails to start (e.g. command not found, crash on startup, broken binary, etc.),
 * Google's ACP server emits an agent message chunk with a formatted error instead of failing gracefully.
 */
export function isMcpInitializationErrorMessage(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return (
    /The MCP server '[^']+' failed to initialize/i.test(text) ||
    text.includes("Fix the MCP server, or remove it from your configuration and start a new session")
  );
}

/**
 * Workspace config files from the repository root down to `cwd`, so later entries are
 * closer to `cwd` and win. Without a repository root only `cwd` is considered.
 */
export function findWorkspaceMcpConfigPaths(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  let rootFound = false;
  for (;;) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) {
      rootFound = true;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const chain = rootFound ? dirs.reverse() : [path.resolve(cwd)];

  const files: string[] = [];
  for (const d of chain) {
    // Within one directory `.agents` has the highest priority, so list it last.
    for (const name of [...WORKSPACE_DIRS].reverse()) {
      const file = path.join(d, name, "mcp_config.json");
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

function warnMissingOAuthTokens(
  entries: Record<string, McpEntry>,
  options: McpResolveOptions,
  warn: McpWarn,
): void {
  const pending = Object.entries(entries).filter(([, e]) => e.oauth && e.server && e.server.type !== "stdio");
  if (pending.length === 0) return;

  const tokensPath = getOAuthTokensPath(options);
  let tokens = "";
  try {
    tokens = fs.readFileSync(tokensPath, "utf8");
  } catch {
    // No token file: every OAuth server is unauthenticated.
  }
  for (const [name, entry] of pending) {
    const url = (entry.server as McpRemoteServer).url;
    if (tokens.includes(url) || tokens.includes(name)) continue;
    warn(
      `MCP server '${name}' is configured for OAuth but no token was found in ${tokensPath}. ` +
        `Authenticate with the 'agy' CLI or Antigravity IDE, or set an Authorization header.`,
    );
  }
}

/**
 * Merges MCP servers with the same precedence as agy-cli, lowest first:
 * global config < servers already on the session < workspace configs (nearest to `cwd` wins).
 * A workspace entry with `"disabled": true` removes a server from lower layers.
 */
export function resolveMcpServers(
  cwd: string,
  existing: Readonly<Record<string, unknown>> = {},
  options: McpResolveOptions = {},
): Record<string, McpServerConfig> {
  const warn = options.warn ?? defaultWarn;
  const merged: Record<string, McpEntry> = {};

  const globalPaths = getGlobalMcpConfigPaths(options);
  const globalFiles = globalPaths.length > 0 ? globalPaths : [getGlobalMcpConfigPath(options)];
  for (const file of globalFiles) {
    for (const [name, entry] of Object.entries(loadEntries(file, warn))) {
      merged[name] = entry;
    }
  }
  for (const [name, server] of Object.entries(existing)) {
    merged[name] = { server: server as McpServerConfig, oauth: false };
  }
  for (const file of findWorkspaceMcpConfigPaths(cwd)) {
    for (const [name, entry] of Object.entries(loadEntries(file, warn))) {
      merged[name] = entry;
    }
  }

  warnMissingOAuthTokens(merged, options, warn);

  const result: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (entry.server) result[name] = entry.server;
  }
  return result;
}
