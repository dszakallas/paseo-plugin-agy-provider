import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import registerAgyUsageSource, {
  agyUsageAccount,
  createUsageFetcher,
  parseAntigravityCredits,
  parseAntigravityUsageWindows,
  parseResetTimestamp,
} from "./usage.ts";

const SAMPLE_USAGE_OUTPUT = `Quota:
Gemini Models          Weekly Limit Remaining       87%       2026-11-21 21:41 CET
Gemini Models          Five Hour Limit Remaining    99%       2026-11-17 22:04 CET
Claude and GPT models  Weekly Limit Remaining       0%        2026-11-17 18:25 CET
Claude and GPT models  Five Hour Limit Remaining    disabled  
Gemini 4 Argon         Gemini 4 Argon Weekly Limit  99%       2026-11-23 00:12 CET
`;

const SAMPLE_CREDITS_OUTPUT = `Model credits
Remaining credits  17
Upgrade            https://antigravity.google/g1-upgrade
`;

test("parseResetTimestamp parses CET, CEST, ISO, and relative timestamps", () => {
  assert.equal(parseResetTimestamp("2026-11-21 21:41 CET"), "2026-11-21T20:41:00.000Z");
  assert.equal(parseResetTimestamp("2026-07-21 21:41 CEST"), "2026-07-21T19:41:00.000Z");
  assert.equal(parseResetTimestamp("2026-11-21T20:41:00.000Z"), "2026-11-21T20:41:00.000Z");
  assert.equal(
    parseResetTimestamp("in 2h 30m", Date.UTC(2026, 10, 17, 10, 0, 0)),
    "2026-11-17T12:30:00.000Z",
  );
  assert.equal(parseResetTimestamp(""), null);
});

test("parseAntigravityUsageWindows parses all groups, skips disabled, and sorts primary 5h/weekly first", () => {
  const windows = parseAntigravityUsageWindows(SAMPLE_USAGE_OUTPUT);
  assert.equal(windows.length, 4);

  assert.equal(windows[0]!.label, "Antigravity · 5-hour");
  assert.equal(windows[0]!.shortLabel, "Antigravity 5h");
  assert.equal(windows[0]!.usedPct, 1);
  assert.equal(windows[0]!.summary, true);
  assert.equal(windows[0]!.resetsAt, "2026-11-17T21:04:00.000Z");

  assert.equal(windows[1]!.label, "Antigravity · Weekly");
  assert.equal(windows[1]!.shortLabel, "Antigravity wk");
  assert.equal(windows[1]!.usedPct, 13);
  assert.equal(windows[1]!.summary, true);
  assert.equal(windows[1]!.resetsAt, "2026-11-21T20:41:00.000Z");

  assert.equal(windows[2]!.usedPct, 100);
  assert.equal(windows[2]!.summary, undefined);
  assert.equal(windows[3]!.usedPct, 1);
  assert.equal(windows[3]!.summary, undefined);
});

test("parseAntigravityCredits parses remaining credits", () => {
  const balances = parseAntigravityCredits(SAMPLE_CREDITS_OUTPUT);
  assert.equal(balances.length, 1);
  assert.equal(balances[0]!.id, "antigravity:credits");
  assert.equal(balances[0]!.remaining, 17);
  assert.equal(balances[0]!.unit, "credits");

  assert.deepEqual(parseAntigravityCredits("No credits info"), []);
});

test("agyUsageAccount reads google_accounts.json and falls back to antigravity-cli dir", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-acct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(agyUsageAccount(dir), null);

  fs.mkdirSync(path.join(dir, "antigravity-cli"));
  const fallback = agyUsageAccount(dir);
  assert.ok(fallback);
  assert.equal(fallback.label, "Antigravity");

  fs.writeFileSync(path.join(dir, "google_accounts.json"), JSON.stringify({ active: "user@example.com" }));
  const emailAcct = agyUsageAccount(dir);
  assert.ok(emailAcct);
  assert.equal(emailAcct.label, "user@example.com");
  assert.deepEqual(emailAcct.input, { geminiHome: dir });
});

test("createUsageFetcher caches results, falls back on transient error, and maps auth errors", async () => {
  let calls = 0;
  let mode: "ok" | "transient" | "auth" = "ok";

  const fetcher = createUsageFetcher(async (args) => {
    calls += 1;
    if (mode === "auth") throw new Error("Not logged in (401 Unauthorized)");
    if (mode === "transient") throw new Error("ETIMEDOUT");
    return args.includes("/usage") ? SAMPLE_USAGE_OUTPUT : SAMPLE_CREDITS_OUTPUT;
  }, 60_000);

  const first = await fetcher("/tmp/gem-a");
  assert.equal(first.status, "available");
  if (first.status === "available") {
    assert.equal(first.windows.length, 4);
    assert.equal(first.balances?.[0]?.remaining, 17);
  }
  assert.equal(calls, 2);

  // Cached hit
  await fetcher("/tmp/gem-a");
  assert.equal(calls, 2);

  // Transient failure on fresh cache key returns error
  mode = "transient";
  const errReport = await fetcher("/tmp/gem-b");
  assert.equal(errReport.status, "error");

  // Auth error maps to unavailable rejected
  mode = "auth";
  const authReport = await fetcher("/tmp/gem-c");
  assert.equal(authReport.status, "unavailable");
  if (authReport.status === "unavailable") {
    assert.equal(authReport.problem.kind, "rejected");
  }
});

test("registerAgyUsageSource discovers global/session accounts and fetches via CLI runner", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-reg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "google_accounts.json"), JSON.stringify({ active: "dev@example.com" }));

  let registration: UsageSourceRegistration | undefined;
  const fakeServer = {
    registerUsageSource(reg: UsageSourceRegistration) {
      registration = reg;
    },
  } as unknown as PluginServerContext;

  registerAgyUsageSource(fakeServer, async (args) =>
    args.includes("/usage") ? SAMPLE_USAGE_OUTPUT : SAMPLE_CREDITS_OUTPUT,
  );
  assert.ok(registration);

  const otherSession = await registration.discover({
    kind: "session",
    provider: "claude",
    env: { GEMINI_HOME: dir },
  });
  assert.deepEqual(otherSession, []);

  const agySession = await registration.discover({
    kind: "session",
    provider: "agy",
    env: { GEMINI_HOME: dir },
  });
  assert.equal(agySession.length, 1);
  assert.equal(agySession[0]!.label, "dev@example.com");

  const report = await registration.fetch(agySession[0]!.input);
  assert.equal(report.status, "available");
});
