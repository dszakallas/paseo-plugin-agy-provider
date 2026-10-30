import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PROGRESS_INSTRUCTION,
  installProgressHook,
  progressHookScriptPath,
  removeProgressHook,
} from "./progress.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-progress-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(script: string, env: Record<string, string>): Promise<string> {
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
    child.stdin?.end(JSON.stringify({ conversationId: "conv-1" }));
  });
}

test("installProgressHook adds a SessionStart hook and preserves other hooks", (t) => {
  const hooksPath = path.join(tmp(t), "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({ "other-hook": { Stop: [{ command: "./stop.sh" }] } }));

  const first = installProgressHook({ hooksPath });
  assert.equal(first.changed, true);
  const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.ok(config["other-hook"]);
  const handler = config["paseo-agy-progress"].SessionStart[0];
  assert.equal(handler.type, "command");
  assert.match(handler.command, /progress-hook\.mjs/);

  assert.equal(installProgressHook({ hooksPath }).changed, false);
  assert.equal(removeProgressHook({ hooksPath }), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(hooksPath, "utf8"))), ["other-hook"]);
});

test("the progress hook injects the instruction only for Paseo sessions", async (t) => {
  process.env.PASEO_AGY_STEER_DIR = tmp(t);
  t.after(() => delete process.env.PASEO_AGY_STEER_DIR);
  const script = progressHookScriptPath();

  const disabled = JSON.parse(await runHook(script, {}));
  assert.deepEqual(disabled, {});

  const enabled = JSON.parse(await runHook(script, { PASEO_AGY_PROGRESS: "1" }));
  assert.deepEqual(enabled, {
    injectSteps: [{ systemMessage: { systemMessage: PROGRESS_INSTRUCTION } }],
  });
});
