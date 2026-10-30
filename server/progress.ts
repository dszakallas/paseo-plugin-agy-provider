import fs from "node:fs";
import path from "node:path";
import { hooksConfigPath, steerRootDir } from "./steer.ts";

/**
 * Progress narration.
 *
 * Antigravity tends to stay silent while it works and only answer once the task
 * is done, which reads as a stall in a chat UI. Its `SessionStart` hook accepts
 * injected steps, including a `systemMessage` that persists in the conversation
 * trajectory across turns. Injecting one short instruction per session makes the
 * agent narrate what it is doing without touching model settings or the user's
 * global rules.
 *
 * The injection only happens for sessions this plugin launched: the provider
 * sets `PASEO_AGY_PROGRESS=1` in the agent's environment, and hook processes
 * inherit it. Running `agy` directly elsewhere is unaffected.
 */
const HOOK_NAME = "paseo-agy-progress";
const ENV_FLAG = "PASEO_AGY_PROGRESS";

export const PROGRESS_INSTRUCTION = [
  "Keep the user informed while you work. Before starting a meaningful step (a tool call or a short group of related calls), write one brief sentence saying what you are about to do.",
  "After a step produces a notable result or changes your plan, write one brief sentence about what you found or what changed.",
  "Keep each update under about 15 words, do not repeat an earlier update, and do not save all explanation for the final answer.",
].join(" ");

const HOOK_SCRIPT = `#!/usr/bin/env node
// Injects a progress-narration instruction into Paseo-launched Antigravity sessions.
const instruction = ${JSON.stringify(PROGRESS_INSTRUCTION)};

if (process.env.${ENV_FLAG} !== "1") {
  process.stdout.write("{}");
  process.exit(0);
}
process.stdout.write(
  JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: instruction } }] }),
);
`;

function hookScriptPath(): string {
  return path.join(steerRootDir(), "progress-hook.mjs");
}

/** Writes the hook script and returns its path. */
export function progressHookScriptPath(): string {
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

export function progressHookCommand(): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(progressHookScriptPath())}`;
}

export type HookInstallResult = { path: string; changed: boolean };

/** Adds or refreshes the SessionStart hook, preserving every other hook. */
export function installProgressHook(options: { hooksPath?: string } = {}): HookInstallResult {
  const file = options.hooksPath ?? hooksConfigPath();
  const command = progressHookCommand();

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
    SessionStart: [{ type: "command", command, timeout: 5 }],
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

/** Removes the progress hook, leaving the rest of the file intact. */
export function removeProgressHook(options: { hooksPath?: string } = {}): boolean {
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
