import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enqueueSteer, installSteerHook, removeSteerHook, steerHookScriptPath, steerRootDir } from "./steer.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-steer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(script: string, payload: unknown, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { env: { ...process.env, ...env } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

test("installSteerHook adds a PreInvocation command hook and preserves other hooks", (t) => {
  const dir = tmp(t);
  const hooksPath = path.join(dir, "hooks.json");
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({ "lint-checker": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } }),
  );

  const first = installSteerHook({ hooksPath });
  assert.equal(first.changed, true);
  const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.ok(config["lint-checker"]);
  const hook = config["paseo-agy-steer"].PreInvocation[0];
  assert.equal(hook.type, "command");
  assert.match(hook.command, /steer-gate\.sh|steer-hook\.mjs/);
  assert.equal(hook.timeout, 5);

  const second = installSteerHook({ hooksPath });
  assert.equal(second.changed, false);

  assert.equal(removeSteerHook({ hooksPath }), true);
  const cleaned = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.deepEqual(Object.keys(cleaned), ["lint-checker"]);
});

test("installSteerHook leaves a malformed hooks file untouched", (t) => {
  const dir = tmp(t);
  const hooksPath = path.join(dir, "hooks.json");
  fs.writeFileSync(hooksPath, "{ not json");
  const result = installSteerHook({ hooksPath });
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), "{ not json");
});

test("the hook drains one queued steer message per invocation", async (t) => {
  const root = tmp(t);
  process.env.PASEO_AGY_STEER_DIR = root;
  t.after(() => delete process.env.PASEO_AGY_STEER_DIR);
  const scripts = installSteerHook({ hooksPath: path.join(root, "hooks.json") });
  assert.equal(scripts.changed, true);
  const script = steerHookScriptPath();
  const env = { PASEO_AGY_STEER_DIR: root };

  enqueueSteer("conv-1", "make it beta");
  enqueueSteer("conv-1", "also add tests");

  const first = JSON.parse(await runHook(script, { conversationId: "conv-1" }, env));
  assert.deepEqual(first, { injectSteps: [{ userMessage: "make it beta" }] });

  const second = JSON.parse(await runHook(script, { conversationId: "conv-1" }, env));
  assert.deepEqual(second, { injectSteps: [{ userMessage: "also add tests" }] });

  const third = JSON.parse(await runHook(script, { conversationId: "conv-1" }, env));
  assert.deepEqual(third, {});

  const other = JSON.parse(await runHook(script, { conversationId: "conv-2" }, env));
  assert.deepEqual(other, {});
});

test("messages are queued per conversation under the steer root", (t) => {
  const root = tmp(t);
  process.env.PASEO_AGY_STEER_DIR = root;
  t.after(() => delete process.env.PASEO_AGY_STEER_DIR);
  assert.equal(steerRootDir(), root);
  enqueueSteer("conv-9", "hi");
  const files = fs.readdirSync(path.join(root, "queue", "conv-9"));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "queue", "conv-9", files[0]), "utf8")), "hi");
});
