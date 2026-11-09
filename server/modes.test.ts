import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contributeServer from "../index.server.ts";
import {
  DANGEROUSLY_SKIP_PERMISSIONS_MODE,
  DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID,
  NATIVE_AUTO_APPROVE_BASE_MODE,
  YOLO_MODE_ID,
  enrichCatalogModes,
  enrichConfigModes,
  findAllowPermissionAction,
  isDangerouslySkipPermissionsMode,
} from "./modes.ts";

function isolateGeminiHome(t: { after(fn: () => void): void }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-modes-"));
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

test("modes helper functions correctly identify and enrich modes", () => {
  assert.equal(isDangerouslySkipPermissionsMode("dangerously-skip-permissions"), true);
  assert.equal(isDangerouslySkipPermissionsMode("yolo"), true);
  assert.equal(isDangerouslySkipPermissionsMode("default"), false);
  assert.equal(isDangerouslySkipPermissionsMode("accept-edits"), false);
  assert.equal(isDangerouslySkipPermissionsMode("plan"), false);
  assert.equal(isDangerouslySkipPermissionsMode(undefined), false);
  assert.equal(isDangerouslySkipPermissionsMode(null), false);
  assert.equal(isDangerouslySkipPermissionsMode(""), false);

  assert.equal(DANGEROUSLY_SKIP_PERMISSIONS_MODE.isUnattended, true);
  assert.equal(DANGEROUSLY_SKIP_PERMISSIONS_MODE.colorTier, "dangerous");
  assert.equal(DANGEROUSLY_SKIP_PERMISSIONS_MODE.icon, "ShieldOff");

  const baseCatalog = {
    models: [],
    modes: [
      { id: "default", label: "Default" },
      { id: "accept-edits", label: "Accept edits" },
    ],
  };
  const enrichedCatalog = enrichCatalogModes(baseCatalog);
  assert.equal(enrichedCatalog.modes.length, 3);
  assert.equal(enrichedCatalog.modes[2].id, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);

  // Does not duplicate if already present
  const alreadyEnriched = enrichCatalogModes(enrichedCatalog);
  assert.equal(alreadyEnriched.modes.length, 3);

  const baseConfig = {
    models: [],
    modes: [{ id: "default", label: "Default" }],
    thinkingOptions: [],
    settings: [],
    mode: "default",
  };
  const enrichedConfigDefault = enrichConfigModes(baseConfig, "default");
  assert.equal(enrichedConfigDefault.mode, "default");
  assert.equal(enrichedConfigDefault.modes.length, 2);

  const enrichedConfigDangerous = enrichConfigModes(baseConfig, "dangerously-skip-permissions");
  assert.equal(enrichedConfigDangerous.mode, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);
  assert.equal(enrichedConfigDangerous.modes.length, 2);

  const enrichedConfigYolo = enrichConfigModes(baseConfig, "yolo");
  assert.equal(enrichedConfigYolo.mode, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);

  const actions = [
    { id: "deny", label: "Deny", behavior: "deny" },
    { id: "allow_always", label: "Always allow", behavior: "allow" },
  ];
  assert.deepEqual(findAllowPermissionAction(actions), {
    id: "allow_always",
    label: "Always allow",
    behavior: "allow",
  });
  assert.equal(findAllowPermissionAction([]), undefined);
  assert.equal(findAllowPermissionAction(undefined), undefined);
});

test("contributeServer advertises dangerously-skip-permissions mode in catalog", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const connection = {
    capabilities: ["session.configure"],
    send: async (input: any) => {
      if (input.type === "catalog") {
        eventCallback!({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: [{ id: "argon", label: "Argon" }],
            modes: [
              { id: "default", label: "Default" },
              { id: "accept-edits", label: "Accept edits" },
              { id: "plan", label: "Plan" },
            ],
          },
        });
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

  await conn.send({ type: "catalog", requestId: "cat-1", cwd: "/tmp" });
  assert.equal(received.length, 1);
  const catalogEvent = received[0];
  assert.equal(catalogEvent.type, "catalog");
  assert.equal(catalogEvent.catalog.modes.length, 4);
  assert.equal(
    catalogEvent.catalog.modes.some((m: any) => m.id === DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID),
    true,
  );
});

test("session open in dangerously-skip-permissions mode rewrites to accept-edits and auto-approves permissions", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const sentInputs: any[] = [];

  const connection = {
    capabilities: ["session.configure", "session.persistence"],
    send: async (input: any) => {
      sentInputs.push(input);
      if (input.type === "session.open") {
        eventCallback!({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["session.configure", "session.persistence"],
          persistence: { version: 1, data: { sessionId: "native-123" } },
          cwd: input.config.cwd,
        });
        eventCallback!({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            mode: input.config.mode,
            modes: [
              { id: "default", label: "Default" },
              { id: "accept-edits", label: "Accept edits" },
              { id: "plan", label: "Plan" },
            ],
            models: [],
            thinkingOptions: [],
            settings: [],
          },
        });
        eventCallback!({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
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

  // Open with dangerously-skip-permissions
  await conn.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "sess-yolo",
    config: {
      cwd: "/tmp",
      env: {},
      mcpServers: {},
      mode: "dangerously-skip-permissions",
      settings: {},
      persist: true,
    },
    history: "replay",
  });

  // Check what was sent to underlying ACP: mode should have been rewritten to accept-edits!
  const openInputSent = sentInputs.find((i) => i.type === "session.open");
  assert.equal(openInputSent.config.mode, NATIVE_AUTO_APPROVE_BASE_MODE);

  // Check event emitted to Paseo UI: session.config should report dangerously-skip-permissions!
  const configEvent = received.find((e) => e.type === "session.config");
  assert.equal(configEvent.config.mode, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);
  assert.equal(
    configEvent.config.modes.some((m: any) => m.id === DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID),
    true,
  );

  // Now simulate a permission request from ACP
  const permissionEvent = {
    type: "session.permission",
    sessionId: "sess-yolo",
    request: {
      id: "permission:tool-1",
      name: "run_command",
      kind: "tool",
      title: "Run command",
      input: { command: "npm test" },
      actions: [
        { id: "allow_once", label: "Allow once", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny" },
      ],
    },
  };
  eventCallback!(permissionEvent);

  // In dangerously-skip-permissions mode:
  // 1. The permission event should NOT be forwarded to the Paseo UI listener
  assert.equal(received.some((e) => e.type === "session.permission"), false);

  // 2. An auto-approval response should be sent to the underlying connection immediately!
  const permResponseSent = sentInputs.find((i) => i.type === "session.permission");
  assert.deepEqual(permResponseSent, {
    type: "session.permission",
    sessionId: "sess-yolo",
    permissionId: "permission:tool-1",
    response: {
      behavior: "allow",
      selectedActionId: "allow_once",
    },
  });

  // 3. Subsequent session.permission_resolved should be suppressed from Paseo UI
  eventCallback!({
    type: "session.permission_resolved",
    sessionId: "sess-yolo",
    permissionId: "permission:tool-1",
  });
  assert.equal(received.some((e) => e.type === "session.permission_resolved"), false);
});

test("session in default mode prompts for permissions without auto-approving", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const sentInputs: any[] = [];

  const connection = {
    capabilities: ["session.configure"],
    send: async (input: any) => {
      sentInputs.push(input);
      if (input.type === "session.open") {
        eventCallback!({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["session.configure"],
          persistence: { version: 1, data: { sessionId: "native-456" } },
          cwd: input.config.cwd,
        });
        eventCallback!({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            mode: "default",
            modes: [
              { id: "default", label: "Default" },
              { id: "accept-edits", label: "Accept edits" },
            ],
            models: [],
            thinkingOptions: [],
            settings: [],
          },
        });
        eventCallback!({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
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

  await conn.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "sess-default",
    config: {
      cwd: "/tmp",
      env: {},
      mcpServers: {},
      mode: "default",
      settings: {},
      persist: true,
    },
    history: "replay",
  });

  const configEvent = received.find((e) => e.type === "session.config");
  assert.equal(configEvent.config.mode, "default");

  // Send permission request
  const permissionEvent = {
    type: "session.permission",
    sessionId: "sess-default",
    request: {
      id: "permission:tool-2",
      name: "run_command",
      kind: "tool",
      title: "Run command",
      input: { command: "cat file.txt" },
      actions: [
        { id: "allow_once", label: "Allow once", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny" },
      ],
    },
  };
  eventCallback!(permissionEvent);

  // In default mode, permission MUST be forwarded to listener
  assert.equal(received.some((e) => e.type === "session.permission"), true);
  // And NO auto-approval should have been sent to connection
  assert.equal(sentInputs.some((i) => i.type === "session.permission"), false);
});

test("session.configure switches dynamically between default and dangerously-skip-permissions mode", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const sentInputs: any[] = [];

  const connection = {
    capabilities: ["session.configure"],
    send: async (input: any) => {
      sentInputs.push(input);
      if (input.type === "session.open") {
        eventCallback!({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["session.configure"],
          persistence: { version: 1, data: { sessionId: "native-789" } },
          cwd: input.config.cwd,
        });
        eventCallback!({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            mode: "default",
            modes: [
              { id: "default", label: "Default" },
              { id: "accept-edits", label: "Accept edits" },
            ],
            models: [],
            thinkingOptions: [],
            settings: [],
          },
        });
        eventCallback!({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
      }
      if (input.type === "session.configure") {
        eventCallback!({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            mode: input.changes.mode,
            modes: [
              { id: "default", label: "Default" },
              { id: "accept-edits", label: "Accept edits" },
            ],
            models: [],
            thinkingOptions: [],
            settings: [],
          },
        });
        eventCallback!({
          type: "request.completed",
          requestId: input.requestId,
        });
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

  // 1. Open in default mode
  await conn.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "sess-toggle",
    config: { cwd: "/tmp", env: {}, mcpServers: {}, mode: "default", settings: {}, persist: true },
    history: "replay",
  });

  // 2. Switch to dangerously-skip-permissions mode
  await conn.send({
    type: "session.configure",
    requestId: "cfg-1",
    sessionId: "sess-toggle",
    changes: { mode: "dangerously-skip-permissions" },
  });

  // Underlying ACP configure should receive accept-edits
  const cfgSent1 = sentInputs.find((i) => i.requestId === "cfg-1");
  assert.equal(cfgSent1.changes.mode, NATIVE_AUTO_APPROVE_BASE_MODE);

  // Emitted config should report dangerously-skip-permissions
  const latestConfig1 = received.filter((e) => e.type === "session.config").pop();
  assert.equal(latestConfig1.config.mode, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);

  // Permission should now be auto-approved
  eventCallback!({
    type: "session.permission",
    sessionId: "sess-toggle",
    request: {
      id: "permission:tool-3",
      actions: [{ id: "allow", behavior: "allow" }],
    },
  });
  const permSent1 = sentInputs.find((i) => i.permissionId === "permission:tool-3");
  assert.equal(permSent1?.response?.behavior, "allow");

  // 3. Switch back to default mode
  await conn.send({
    type: "session.configure",
    requestId: "cfg-2",
    sessionId: "sess-toggle",
    changes: { mode: "default" },
  });
  const cfgSent2 = sentInputs.find((i) => i.requestId === "cfg-2");
  assert.equal(cfgSent2.changes.mode, "default");

  const latestConfig2 = received.filter((e) => e.type === "session.config").pop();
  assert.equal(latestConfig2.config.mode, "default");

  // Permission should no longer be auto-approved
  const prevPermCount = sentInputs.filter((i) => i.type === "session.permission").length;
  eventCallback!({
    type: "session.permission",
    sessionId: "sess-toggle",
    request: {
      id: "permission:tool-4",
      actions: [{ id: "allow", behavior: "allow" }],
    },
  });
  const newPermCount = sentInputs.filter((i) => i.type === "session.permission").length;
  assert.equal(newPermCount, prevPermCount);
  assert.equal(received.some((e) => e.request?.id === "permission:tool-4"), true);
});

test("session recovery preserves dangerously-skip-permissions mode and sends accept-edits to ACP", async (t) => {
  isolateGeminiHome(t);
  let eventCallback: ((event: unknown) => void) | undefined;
  const sentInputs: any[] = [];
  let promptAttempt = 0;

  const connection = {
    capabilities: ["session.configure", "session.persistence"],
    send: async (input: any) => {
      sentInputs.push(input);
      if (input.type === "session.open") {
        eventCallback!({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: ["session.configure", "session.persistence"],
          persistence: { version: 1, data: { sessionId: "native-recover-1" } },
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
      if (input.type === "session.prompt") {
        promptAttempt++;
        const turnId = `turn-${promptAttempt}`;
        if (promptAttempt === 1) {
          // Failure triggering recovery
          eventCallback!({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId,
            state: "failed",
            error: {
              message: "Session not found: native-recover-1",
            },
          });
        } else {
          // Replayed attempt triggers a permission request
          eventCallback!({
            type: "session.permission",
            sessionId: input.sessionId,
            request: {
              id: "permission:replayed-tool",
              actions: [{ id: "allow", behavior: "allow" }],
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

  // Open with dangerously-skip-permissions
  await conn.send({
    type: "session.open",
    requestId: "open-initial",
    sessionId: "sess-recover-yolo",
    config: {
      cwd: "/tmp",
      env: {},
      mcpServers: {},
      mode: "dangerously-skip-permissions",
      settings: {},
      persist: true,
    },
    history: "replay",
  });

  // Send a prompt which triggers connection failure and transparent recovery
  await conn.send({
    type: "session.prompt",
    requestId: "prompt-1",
    sessionId: "sess-recover-yolo",
    prompt: {
      clientMessageId: "client-1",
      delivery: "auto",
      input: {
        type: "message",
        content: [{ type: "text", text: "Run something" }],
      },
    },
  });

  // Wait for async recovery microtasks/macrotasks to finish
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Verify that the reopen input sent to connection had mode: accept-edits (not unknown mode)
  const openInputs = sentInputs.filter((i) => i.type === "session.open");
  assert.equal(openInputs.length, 2);
  assert.equal(openInputs[1].config.mode, NATIVE_AUTO_APPROVE_BASE_MODE);

  // Verify that the replayed permission request was auto-approved!
  const permApproved = sentInputs.find((i) => i.permissionId === "permission:replayed-tool");
  assert.equal(permApproved?.response?.behavior, "allow");
});
