import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Steering for Antigravity conversations.
 *
 * Antigravity reads input only between turns, so a message sent while the agent
 * is working cannot be written to its stdin. What it does support is lifecycle
 * hooks: `PreInvocation` handlers run before every model call and may return
 * `injectSteps: [{ userMessage }]`. An injected user message joins the running
 * conversation and the agent sees it on the next invocation, which is exactly
 * the mid-turn steering behavior we want.
 *
 * The pipeline:
 *
 * 1. The provider advertises `prompt.steer` and intercepts steer prompts while a
 *    turn is active (see `index.server.ts`). Nothing is forwarded to the ACP
 *    session, so the turn keeps running instead of being interrupted.
 * 2. The message text is appended to a per-conversation queue directory.
 * 3. Antigravity calls the installed `PreInvocation` hook before its next model
 *    invocation. The hook drains one queued message for that conversation and
 *    prints it as an injected step.
 *
 * The hook file and its command are generated here rather than shipped, so the
 * absolute paths to the queue and the Node binary are baked in and nothing
 * depends on how the plugin is packaged or where the daemon runs from.
 *
 * Hook cost matters because the handler runs on every model invocation, not just
 * when steering: `steer-gate.sh` checks for a pending message with a shell glob
 * (~10 ms) and only starts Node when there is something to deliver. Empty
 * invocations therefore stay cheap.
 *
 * A queued message that is never consumed (the turn finished first) expires
 * after `MAX_AGE_MS` so it cannot surface in an unrelated later turn.
 */
const HOOK_NAME = "paseo-agy-steer";
const MAX_AGE_MS = 10 * 60_000;

function cacheBaseDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

/** Stable per-user directory for the hook script and the steer queue. */
export function steerRootDir(): string {
  return process.env.PASEO_AGY_STEER_DIR ?? path.join(cacheBaseDir(), "paseo-agy-provider", "steer");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function queueDir(conversationId: string): string {
  return path.join(steerRootDir(), "queue", safeId(conversationId));
}

/**
 * Monotonic per-process sequence, so messages queued within the same
 * millisecond still drain in the order the user sent them.
 */
let enqueueSequence = 0;

/** Queues a steer message for the given Antigravity conversation. */
export function enqueueSteer(conversationId: string, text: string): void {
  const dir = queueDir(conversationId);
  fs.mkdirSync(dir, { recursive: true });
  pruneStale(dir);
  const sequence = String(enqueueSequence++).padStart(6, "0");
  const name = `${Date.now()}-${sequence}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  // The hook emits this string verbatim inside {"userMessage": ...}.
  fs.writeFileSync(tmp, JSON.stringify(text), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

function pruneStale(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Another process drained it.
    }
  }
}

export function hooksConfigPath(geminiHome = process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini")): string {
  return path.join(geminiHome, "config", "hooks.json");
}

/** Path of the Node script the hook runs; written on demand. */
export function steerHookScriptPath(): string {
  const file = path.join(steerRootDir(), "steer-hook.mjs");
  const content = HOOK_SCRIPT.replaceAll("__ROOT__", steerRootDir());
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }
  return file;
}

const GATE_SCRIPT = `#!/bin/sh
# Skip the Node startup entirely while no steer message is queued.
root='__ROOT__'
set -- "$root"/queue/*/*.json
[ -e "$1" ] || { printf '{}'; exit 0; }
exec '__NODE__' '__HOOK__'
`;

function hookGatePath(): string {
  return path.join(steerRootDir(), "steer-gate.sh");
}

function ensureHookGate(): string {
  const file = hookGatePath();
  const content = GATE_SCRIPT.replaceAll("__ROOT__", steerRootDir())
    .replaceAll("__NODE__", process.execPath)
    .replaceAll("__HOOK__", steerHookScriptPath());
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, file);
  }
  return file;
}

const HOOK_SCRIPT = `#!/usr/bin/env node
// Drains one queued Paseo steer message for the conversation Antigravity is invoking.
import fs from "node:fs";
import path from "node:path";

const root = '__ROOT__';
const emit = (value) => process.stdout.write(JSON.stringify(value));

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let conversationId;
try {
  conversationId = JSON.parse(input).conversationId;
} catch {
  emit({});
  process.exit(0);
}
if (typeof conversationId !== "string" || conversationId === "") {
  emit({});
  process.exit(0);
}

const dir = path.join(root, "queue", conversationId.replace(/[^A-Za-z0-9._-]/g, "_"));
let files = [];
try {
  files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
} catch {
  emit({});
  process.exit(0);
}
if (files.length === 0) {
  emit({});
  process.exit(0);
}

const claimed = path.join(dir, files[0] + ".claimed");
let text = null;
try {
  fs.renameSync(path.join(dir, files[0]), claimed);
  text = JSON.parse(fs.readFileSync(claimed, "utf8"));
} catch {}
try {
  fs.unlinkSync(claimed);
} catch {}

emit(typeof text === "string" && text !== "" ? { injectSteps: [{ userMessage: text }] } : {});
`;

export function steerHookCommand(): string {
  // Windows runs hook commands through cmd; skip the POSIX gate there.
  if (process.platform === "win32") {
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(steerHookScriptPath())}`;
  }
  return `sh ${JSON.stringify(ensureHookGate())}`;
}

export type HookInstallResult = { path: string; changed: boolean };

/**
 * Adds (or refreshes) the PreInvocation hook that delivers queued steer
 * messages, merging it into the user's global hooks file so steering works in
 * every workspace. Existing named hooks are preserved verbatim; a file that
 * cannot be parsed is left untouched rather than overwritten.
 */
export function installSteerHook(options: { hooksPath?: string } = {}): HookInstallResult {
  const file = options.hooksPath ?? hooksConfigPath();
  const command = steerHookCommand();

  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Leave a malformed file untouched rather than clobbering user hooks.
      return { path: file, changed: false };
    }
  }

  const desired = {
    PreInvocation: [{ type: "command", command, timeout: 5 }],
  };
  const existing = config[HOOK_NAME];
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return { path: file, changed: false };
  }
  config[HOOK_NAME] = desired;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { path: file, changed: true };
}

/** Removes the steering hook, leaving the rest of the file intact. */
export function removeSteerHook(options: { hooksPath?: string } = {}): boolean {
  const file = options.hooksPath ?? hooksConfigPath();
  if (!fs.existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const config = parsed as Record<string, unknown>;
    if (!(HOOK_NAME in config)) return false;
    delete config[HOOK_NAME];
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
