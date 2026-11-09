import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  TASK_KILL_DENY_REASON,
  installTaskGuardHook,
  removeTaskGuardHook,
  taskGuardHookScriptPath,
} from "./task-guard.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-task-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(
  script: string,
  stdinPayload: unknown,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [script],
      { env: { ...process.env, PASEO_AGY_PROGRESS: "", ...env } },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    child.stdin?.end(JSON.stringify(stdinPayload));
  });
}

test("installTaskGuardHook adds a PreToolUse manage_task hook and preserves other hooks", (t) => {
  const hooksPath = path.join(tmp(t), "hooks.json");
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({ "other-hook": { Stop: [{ command: "./stop.sh" }] } }),
  );

  const first = installTaskGuardHook({ hooksPath });
  assert.equal(first.changed, true);
  const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.ok(config["other-hook"]);
  const group = config["paseo-agy-task-guard"].PreToolUse[0];
  assert.equal(group.matcher, "manage_task");
  assert.equal(group.hooks[0].type, "command");
  assert.match(group.hooks[0].command, /task-guard-hook\.mjs/);

  assert.equal(installTaskGuardHook({ hooksPath }).changed, false);
  assert.equal(removeTaskGuardHook({ hooksPath }), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(hooksPath, "utf8"))), ["other-hook"]);
});

test("task-guard hook denies manage_task kill in Paseo sessions and allows other actions", async (t) => {
  process.env.PASEO_AGY_STEER_DIR = tmp(t);
  t.after(() => delete process.env.PASEO_AGY_STEER_DIR);
  const script = taskGuardHookScriptPath();

  const killPayload = {
    toolCall: {
      name: "manage_task",
      args: { Action: "kill", TaskId: "conv-1/task-42" },
    },
  };

  // Outside Paseo sessions, do not interfere.
  assert.deepEqual(JSON.parse(await runHook(script, killPayload, {})), {});

  // Inside Paseo sessions, deny Action: "kill" (including quoted wire values).
  assert.deepEqual(
    JSON.parse(await runHook(script, killPayload, { PASEO_AGY_PROGRESS: "1" })),
    { decision: "deny", reason: TASK_KILL_DENY_REASON },
  );
  assert.deepEqual(
    JSON.parse(
      await runHook(
        script,
        { toolCall: { name: "manage_task", args: { action: '"KILL"' } } },
        { PASEO_AGY_PROGRESS: "1" },
      ),
    ),
    { decision: "deny", reason: TASK_KILL_DENY_REASON },
  );

  // Other manage_task actions are allowed.
  for (const action of ["list", "status", "send_input"]) {
    assert.deepEqual(
      JSON.parse(
        await runHook(
          script,
          { toolCall: { name: "manage_task", args: { Action: action } } },
          { PASEO_AGY_PROGRESS: "1" },
        ),
      ),
      {},
    );
  }
});
