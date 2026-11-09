import fs from "node:fs";
import path from "node:path";
import { hooksConfigPath, steerRootDir } from "./steer.ts";

/**
 * Guard against `manage_task(Action: "kill")`.
 *
 * Cancelling a backgrounded `run_command` via `manage_task` with `Action: "kill"`
 * stalls the Go `localharness` turn and leaves its loopback WebSocket closed
 * with code 1000 (OK). When `agy_acp_server.par` then attempts to rebuild the
 * session agent, `LocalConnection.disconnect()` sends `session_end_request` over
 * the already-closed WebSocket, raising `received 1000 (OK); then sent 1000 (OK)`
 * and dropping the session from `self._sessions`.
 *
 * This `PreToolUse` hook intercepts `manage_task` calls in Paseo-launched
 * Antigravity sessions (`PASEO_AGY_PROGRESS=1`) and denies `Action: "kill"`,
 * instructing the agent to leave the background task running or stop specific
 * processes via `run_command` instead. Other `manage_task` actions (`list`,
 * `status`, `send_input`) are allowed.
 */
const HOOK_NAME = "paseo-agy-task-guard";
const ENV_FLAG = "PASEO_AGY_PROGRESS";

export const TASK_KILL_DENY_REASON =
  "Cancelling background tasks with manage_task(Action: 'kill') is disabled in Paseo sessions because it stalls the Antigravity localharness and drops the ACP session. Leave the background task running, or terminate the specific process via run_command (for example with kill or pkill) instead.";

const HOOK_SCRIPT = `#!/usr/bin/env node
// Blocks manage_task(Action: "kill") in Paseo-launched Antigravity sessions.
const denyReason = ${JSON.stringify(TASK_KILL_DENY_REASON)};
const emit = (value) => process.stdout.write(JSON.stringify(value));

if (process.env.${ENV_FLAG} !== "1") {
  emit({});
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let args;
try {
  const parsed = JSON.parse(input);
  args = parsed?.toolCall?.args;
} catch {
  emit({});
  process.exit(0);
}

const rawAction =
  args && typeof args === "object" ? (args.Action ?? args.action) : undefined;
const normalizedAction =
  typeof rawAction === "string"
    ? rawAction.replace(/^["']+|["']+$/g, "").trim().toLowerCase()
    : "";

if (normalizedAction === "kill") {
  emit({ decision: "deny", reason: denyReason });
} else {
  emit({});
}
`;

function hookScriptPath(): string {
  return path.join(steerRootDir(), "task-guard-hook.mjs");
}

/** Writes the task-guard hook script and returns its path. */
export function taskGuardHookScriptPath(): string {
  const file = hookScriptPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== HOOK_SCRIPT) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, HOOK_SCRIPT, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }
  return file;
}

export function taskGuardHookCommand(): string {
  return `env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(taskGuardHookScriptPath())}`;
}

export type HookInstallResult = { path: string; changed: boolean };

/** Adds or refreshes the PreToolUse hook for `manage_task`, preserving other hooks. */
export function installTaskGuardHook(options: { hooksPath?: string } = {}): HookInstallResult {
  const file = options.hooksPath ?? hooksConfigPath();
  const command = taskGuardHookCommand();

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
    PreToolUse: [
      {
        matcher: "manage_task",
        hooks: [{ type: "command", command, timeout: 5 }],
      },
    ],
  };
  if (config[HOOK_NAME] && JSON.stringify(config[HOOK_NAME]) === JSON.stringify(desired)) {
    return { path: file, changed: false };
  }
  config[HOOK_NAME] = desired;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { path: file, changed: true };
}

/** Removes the task-guard hook, leaving the rest of the file intact. */
export function removeTaskGuardHook(options: { hooksPath?: string } = {}): boolean {
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
