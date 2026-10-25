import assert from "node:assert/strict";
import { test } from "node:test";
import contributeServer from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { formatQuotaExceededMessage, isQuotaExceededErrorMessage } from "./quota.ts";

test("isQuotaExceededErrorMessage detects quota exceeded messages", () => {
  assert.equal(
    isQuotaExceededErrorMessage(
      "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.",
    ),
    true,
  );
  assert.equal(isQuotaExceededErrorMessage("Usage Limit Reached"), true);
  assert.equal(
    isQuotaExceededErrorMessage("You have reached your current quota for this period."),
    true,
  );
  assert.equal(
    isQuotaExceededErrorMessage(
      "agent executor error: Error 429, Message: Individual quota reached. Resets in 161h30m59s., Status: RESOURCE_EXHAUSTED",
    ),
    true,
  );
  assert.equal(
    isQuotaExceededErrorMessage(
      "Details: [map[metadata:map[model:gemini-4-argon-medium uiMessage:true] reason:QUOTA_EXHAUSTED]]",
    ),
    true,
  );
  assert.equal(isQuotaExceededErrorMessage("Error 429: quota exceeded for model"), true);

  // Negative cases
  assert.equal(isQuotaExceededErrorMessage("Here is your completed code"), false);
  assert.equal(isQuotaExceededErrorMessage("Quota calculation complete"), false);
  assert.equal(isQuotaExceededErrorMessage(""), false);
  assert.equal(isQuotaExceededErrorMessage(null), false);
  assert.equal(isQuotaExceededErrorMessage(undefined), false);
  assert.equal(isQuotaExceededErrorMessage(123), false);
});

test("formatQuotaExceededMessage formats messages cleanly", () => {
  assert.equal(
    formatQuotaExceededMessage(
      "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.",
    ),
    "You have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.",
  );

  assert.equal(
    formatQuotaExceededMessage("Usage Limit Reached"),
    "Usage limit reached: you have reached your current quota for this period.",
  );

  assert.equal(
    formatQuotaExceededMessage(
      "agent executor error: Error 429, Message: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 161h30m59s., Status: RESOURCE_EXHAUSTED",
    ),
    "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 161h30m59s.",
  );
});

test("contributeServer intercepts quota exceeded assistant message and fails session turn", async () => {
  let eventCallback: ((event: unknown) => void) | undefined;
  const connection = {
    send: async () => {},
    onEvent: (cb: (event: unknown) => void) => {
      eventCallback = cb;
      return () => {};
    },
    close: async () => {},
  };
  let registered: any;
  contributeServer(
    { registerProvider: (p: any) => void (registered = p), before: () => () => {} } as unknown as PluginServerContext,
    (() => ({ id: "agy", label: "x", connect: async () => connection })) as any,
  );

  const conn = await registered.connect({ versions: [1], capabilities: [] });
  const received: any[] = [];
  conn.onEvent((event: any) => received.push(event));

  // 1. Start turn
  eventCallback!({
    type: "session.turn",
    sessionId: "session-quota",
    turnId: "turn-1",
    state: "started",
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].state, "started");

  // 2. Assistant message indicating quota exceeded arrives -> must be suppressed
  const quotaMsg = {
    type: "timeline.item",
    sessionId: "session-quota",
    item: {
      type: "assistant_message",
      id: "agent_message_chunk:1",
      text: "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.",
    },
  };
  eventCallback!(quotaMsg);
  assert.equal(received.length, 1, "Quota assistant message should be suppressed from timeline");

  // 3. Provider emits turn completed -> must be transformed into turn failed with quota_exhausted code
  eventCallback!({
    type: "session.turn",
    sessionId: "session-quota",
    turnId: "turn-1",
    state: "completed",
  });
  assert.equal(received.length, 2, "Turn event should be emitted");
  assert.deepEqual(received[1], {
    type: "session.turn",
    sessionId: "session-quota",
    turnId: "turn-1",
    state: "failed",
    error: {
      message: "You have reached your current quota for this period. Your limit will reset in 6 days, 17 hours.",
      code: "quota_exhausted",
    },
  });

  // 4. Normal session turn in another session is unaffected
  eventCallback!({
    type: "session.turn",
    sessionId: "session-normal",
    turnId: "turn-2",
    state: "started",
  });
  eventCallback!({
    type: "timeline.item",
    sessionId: "session-normal",
    item: {
      type: "assistant_message",
      id: "agent_message_chunk:2",
      text: "Hello! How can I help you today?",
    },
  });
  eventCallback!({
    type: "session.turn",
    sessionId: "session-normal",
    turnId: "turn-2",
    state: "completed",
  });

  assert.equal(received.length, 5);
  assert.equal(received[2].state, "started");
  assert.equal(received[3].type, "timeline.item");
  assert.equal(received[3].item.text, "Hello! How can I help you today?");
  assert.equal(received[4].state, "completed");
});
