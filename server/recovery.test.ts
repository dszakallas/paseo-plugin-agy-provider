import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeServer from "../index.server.ts";
import {
  applyConfigEventSnapshot,
  applyConfigureChanges,
  formatConnectionLostMessage,
  isConnectionLostErrorMessage,
  isRecoverableTurnFailureMessage,
} from "./recovery.ts";

function isolateGeminiHome(t: { after(fn: () => void): void }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-recovery-"));
  const prevHome = process.env.GEMINI_HOME;
  const prevSteer = process.env.PASEO_AGY_STEER_DIR;
  process.env.GEMINI_HOME = dir;
  process.env.PASEO_AGY_STEER_DIR = path.join(dir, "steer");
  t.after(() => {
    if (prevHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevHome;
    if (prevSteer === undefined) delete process.env.PASEO_AGY_STEER_DIR;
    else process.env.PASEO_AGY_STEER_DIR = prevSteer;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("isConnectionLostErrorMessage and isRecoverableTurnFailureMessage detect connection and rebuild errors", () => {
  const raw =
    "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)";
  assert.equal(isConnectionLostErrorMessage(raw), true);
  assert.equal(formatConnectionLostMessage(`  ${raw}\n`), raw);
  assert.equal(isConnectionLostErrorMessage("Normal assistant reply"), false);
  assert.equal(isConnectionLostErrorMessage(""), false);
  assert.equal(isConnectionLostErrorMessage(null), false);

  assert.equal(isRecoverableTurnFailureMessage("Session not found: 60ea57ec"), true);
  assert.equal(
    isRecoverableTurnFailureMessage("Failed to rebuild agent: received 1000 (OK)"),
    true,
  );
  assert.equal(isRecoverableTurnFailureMessage("Internal error"), true);
  assert.equal(isRecoverableTurnFailureMessage("Permission denied"), false);
});

test("applyConfigureChanges and applyConfigEventSnapshot preserve active session config", () => {
  const initial = {
    openInput: {
      type: "session.open",
      requestId: "req-1",
      sessionId: "sess-1",
      config: {
        cwd: "/tmp/proj",
        env: {},
        mcpServers: {},
        model: "gemini-3.1-pro-high",
        mode: "default",
        settings: { a: true },
        persist: true,
      },
      history: "replay",
    },
    persistence: { version: 1, data: { sessionId: "native-1" } },
  };

  const afterConfigure = applyConfigureChanges(initial, {
    model: "gemini-4-argon",
    thinkingOption: "high",
    settings: { b: "fast" },
  });
  assert.equal(afterConfigure.openInput.config.model, "gemini-4-argon");
  assert.equal(afterConfigure.openInput.config.thinkingOption, "high");
  assert.deepEqual(afterConfigure.openInput.config.settings, { a: true, b: "fast" });

  const afterSnapshot = applyConfigEventSnapshot(afterConfigure, {
    model: "gemini-4-argon",
    mode: "yolo",
  });
  assert.equal(afterSnapshot.openInput.config.mode, "yolo");
});

test("contributeServer transparently rebuilds the ACP session and replays the turn on connection loss", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const sentInputs: any[] = [];
  let promptAttempt = 0;

  const connection = {
    capabilities: ["prompt.message", "session.persistence", "session.configure"],
    send: async (input: any) => {
      sentInputs.push(input);
      if (input.type === "session.open") {
        eventCallback!({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["prompt.message", "session.persistence", "session.configure"],
          restoration: "core",
          persistence: input.persistence ?? {
            version: 1,
            data: { sessionId: "native-60ea57ec" },
          },
          cwd: input.config.cwd,
        });
        eventCallback!({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
        return;
      }
      if (input.type === "session.close") {
        eventCallback!({
          type: "session.closed",
          sessionId: input.sessionId,
        });
        eventCallback!({
          type: "request.completed",
          requestId: input.requestId,
        });
        return;
      }
      if (input.type === "session.configure") {
        eventCallback!({
          type: "request.completed",
          requestId: input.requestId,
        });
        return;
      }
      if (input.type === "session.prompt") {
        promptAttempt++;
        const turnId = `acp:${input.prompt.clientMessageId}`;
        eventCallback!({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: {
            type: "user_message",
            id: input.prompt.clientMessageId,
            text: "hey",
            clientMessageId: input.prompt.clientMessageId,
          },
        });
        eventCallback!({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId },
        });
        eventCallback!({
          type: "session.turn",
          sessionId: input.sessionId,
          turnId,
          state: "started",
        });

        if (promptAttempt === 1) {
          // First attempt: agy_acp_server.par fails _rebuild_session_agent with 1000 (OK)
          eventCallback!({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: {
              type: "assistant_message",
              id: "agent_message_chunk:1",
              text: "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)",
            },
          });
          eventCallback!({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId,
            state: "completed",
          });
        } else {
          // Second attempt after automatic session.close + session.open: succeeds!
          eventCallback!({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: {
              type: "assistant_message",
              id: "agent_message_chunk:2",
              text: "Recovered and completed review.",
            },
          });
          eventCallback!({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId,
            state: "completed",
          });
        }
      }
    },
    onEvent: (cb: (event: unknown) => void) => {
      eventCallback = cb;
      return () => {};
    },
    close: async () => {},
  };

  let registered: any;
  contributeServer(
    {
      registerProvider: (p: any) => void (registered = p),
      before: () => () => {},
      handle: () => {},
      registerUsageSource: () => {},
    } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  const received: any[] = [];
  conn.onEvent((event: any) => received.push(event));

  // Open session and switch model to gemini-4-argon
  await conn.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "sess-argon",
    config: {
      cwd: "/tmp",
      env: {},
      mcpServers: {},
      model: "gemini-3.1-pro-high",
      settings: {},
      persist: true,
    },
    history: "replay",
  });
  await conn.send({
    type: "session.configure",
    requestId: "cfg-1",
    sessionId: "sess-argon",
    changes: { model: "gemini-4-argon" },
  });

  received.length = 0;

  // Send prompt that hits connection loss on attempt 1 and recovers on attempt 2
  await conn.send({
    type: "session.prompt",
    sessionId: "sess-argon",
    prompt: {
      clientMessageId: "msg-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hey" }] },
    },
  });

  // Wait for async recovery microtasks/macrotasks to finish
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(promptAttempt, 2, "Prompt should be replayed once after rebuilding session");

  // Verify the internal reopen used the updated model ("gemini-4-argon") and native persistence
  const reopenInput = sentInputs.find(
    (item) => item.type === "session.open" && item.requestId !== "open-1",
  );
  assert.ok(reopenInput, "Should have sent an internal session.open");
  assert.equal(reopenInput.config.model, "gemini-4-argon");
  assert.equal(reopenInput.history, "skip");
  assert.deepEqual(reopenInput.persistence, {
    version: 1,
    data: { sessionId: "native-60ea57ec" },
  });

  // Verify Paseo received a single clean turn without the connection-lost error or duplicate turn start
  assert.deepEqual(
    received.map((e) =>
      e.type === "timeline.item"
        ? `${e.type}:${e.item.type}:${e.item.text}`
        : `${e.type}:${e.state ?? e.result?.type ?? ""}`,
    ),
    [
      "timeline.item:user_message:hey",
      "session.prompt_result:turn",
      "session.turn:started",
      "timeline.item:assistant_message:Recovered and completed review.",
      "session.turn:completed",
    ],
  );
});

test("contributeServer fails the turn with connection_lost if recovery also fails", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;

  const connection = {
    capabilities: ["prompt.message"],
    send: async () => {},
    onEvent: (cb: (event: unknown) => void) => {
      eventCallback = cb;
      return () => {};
    },
    close: async () => {},
  };

  let registered: any;
  contributeServer(
    {
      registerProvider: (p: any) => void (registered = p),
      before: () => () => {},
      handle: () => {},
      registerUsageSource: () => {},
    } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  const received: any[] = [];
  conn.onEvent((event: any) => received.push(event));

  // Session without persistence: cannot be reopened, so turn must fail with connection_lost
  eventCallback!({
    type: "session.turn",
    sessionId: "sess-no-persist",
    turnId: "turn-1",
    state: "started",
  });
  eventCallback!({
    type: "timeline.item",
    sessionId: "sess-no-persist",
    item: {
      type: "assistant_message",
      id: "agent_message_chunk:1",
      text: "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)",
    },
  });
  eventCallback!({
    type: "session.turn",
    sessionId: "sess-no-persist",
    turnId: "turn-1",
    state: "completed",
  });

  assert.equal(received.length, 2);
  assert.deepEqual(received[1], {
    type: "session.turn",
    sessionId: "sess-no-persist",
    turnId: "turn-1",
    state: "failed",
    error: {
      message:
        "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)",
      code: "connection_lost",
    },
  });
});
