import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  balanceToneFromRemaining,
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
} from "@getpaseo/plugin/server/usage";
import type {
  UsageAccount,
  UsageBalance,
  UsageReport,
  UsageScope,
  UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { agyCommand } from "./command.ts";

const execFileAsync = promisify(execFile);

const FIVE_HOURS_SECONDS = 18_000;
const WEEKLY_SECONDS = 604_800;
const MONTHLY_SECONDS = 2_592_000;
const USAGE_PROBE_TIMEOUT_MS = 30_000;
const CREDITS_PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;

const inputSchema = z.object({ geminiHome: z.string().min(1) }).strict();

const TIMEZONE_OFFSETS: Record<string, string> = {
  UTC: "Z",
  GMT: "Z",
  Z: "Z",
  WET: "+00:00",
  WEST: "+01:00",
  BST: "+01:00",
  CET: "+01:00",
  CEST: "+02:00",
  EET: "+02:00",
  EEST: "+03:00",
  IST: "+05:30",
  JST: "+09:00",
  EST: "-05:00",
  EDT: "-04:00",
  CST: "-06:00",
  CDT: "-05:00",
  MST: "-07:00",
  MDT: "-06:00",
  PST: "-08:00",
  PDT: "-07:00",
};

export interface UsageCliRunner {
  (args: string[], options: { geminiHome: string; timeoutMs: number }): Promise<string>;
}

interface CacheEntry {
  fetchedAt: number;
  report: UsageReport;
}

function defaultGeminiHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");
}

function readAccountEmail(geminiHome: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(geminiHome, "google_accounts.json"), "utf8");
    const parsed = JSON.parse(raw) as { active?: unknown };
    if (typeof parsed?.active === "string" && parsed.active.trim() !== "") {
      return parsed.active.trim();
    }
  } catch {
    // Not present or malformed; fall back below.
  }
  return null;
}

export function agyUsageAccount(geminiHome: string): UsageAccount | null {
  const email = readAccountEmail(geminiHome);
  if (email) {
    return {
      key: hashAccountKey(email),
      label: email,
      harness: "Antigravity",
      input: { geminiHome },
    };
  }
  if (fs.existsSync(path.join(geminiHome, "antigravity-cli"))) {
    return {
      key: hashAccountKey(geminiHome),
      label: "Antigravity",
      harness: "Antigravity",
      input: { geminiHome },
    };
  }
  return null;
}

function normalizeIdentifier(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function deduplicateId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  let suffix = 2;
  while (taken.has(`${candidate}_${suffix}`)) suffix += 1;
  return `${candidate}_${suffix}`;
}

export function parseResetTimestamp(rawReset: string | undefined | null, now = Date.now()): string | null {
  const trimmed = rawReset?.trim();
  if (!trimmed) return null;

  const dateTzMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s+([A-Za-z]{1,6}|[+-]\d{2}:?\d{2}))?$/.exec(
    trimmed,
  );
  if (dateTzMatch) {
    const datePart = dateTzMatch[1]!;
    const timePart = dateTzMatch[2]!.length === 5 ? `${dateTzMatch[2]}:00` : dateTzMatch[2]!;
    const tz = dateTzMatch[3]?.toUpperCase();
    if (tz) {
      const mapped = TIMEZONE_OFFSETS[tz];
      if (mapped) {
        const parsed = Date.parse(`${datePart}T${timePart}${mapped}`);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
      }
      if (/^[+-]\d{2}:?\d{2}$/.test(tz)) {
        const normalizedOffset = tz.includes(":") ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`;
        const parsed = Date.parse(`${datePart}T${timePart}${normalizedOffset}`);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
      }
    }
    const direct = Date.parse(trimmed);
    if (!Number.isNaN(direct)) return new Date(direct).toISOString();
    const local = Date.parse(`${datePart}T${timePart}`);
    if (!Number.isNaN(local)) return new Date(local).toISOString();
  }

  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();

  const relMatch =
    /^(?:in\s+)?(?:(\d+)\s*d(?:ays?)?)?[,\s]*(?:(\d+)\s*h(?:ours?|rs?)?)?[,\s]*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i.exec(
      trimmed,
    );
  if (relMatch && (relMatch[1] || relMatch[2] || relMatch[3])) {
    const days = Number.parseInt(relMatch[1] ?? "0", 10);
    const hours = Number.parseInt(relMatch[2] ?? "0", 10);
    const mins = Number.parseInt(relMatch[3] ?? "0", 10);
    const totalMs = ((days * 24 + hours) * 60 + mins) * 60_000;
    if (totalMs > 0) return new Date(now + totalMs).toISOString();
  }

  return null;
}

function classifyDurationSeconds(limitLabel: string): number | undefined {
  if (/five\s*hour|5\s*-?\s*h(our)?/i.test(limitLabel)) return FIVE_HOURS_SECONDS;
  if (/weekly/i.test(limitLabel)) return WEEKLY_SECONDS;
  if (/monthly/i.test(limitLabel)) return MONTHLY_SECONDS;
  return undefined;
}

function durationSortOffset(durationSeconds: number | undefined): number {
  if (durationSeconds === FIVE_HOURS_SECONDS) return 1;
  if (durationSeconds === WEEKLY_SECONDS) return 2;
  if (durationSeconds === MONTHLY_SECONDS) return 3;
  return 4;
}

function classifyQuotaScope(
  group: string,
  limitLabel: string,
): { id: string; label: string; isPrimaryGemini: boolean; rankBase: number } {
  const cleanGroup = group.replace(/\s+models$/i, "").trim();
  if (/^gemini(\s+models)?$/i.test(group.trim())) {
    return {
      id: "antigravity",
      label: "Antigravity",
      isPrimaryGemini: true,
      rankBase: 0,
    };
  }
  const scopeSlug = normalizeIdentifier(cleanGroup || limitLabel) || "other";
  return {
    id: `antigravity_${scopeSlug}`,
    label: cleanGroup || limitLabel || "Other",
    isPrimaryGemini: false,
    rankBase: 10,
  };
}

export function parseAntigravityUsageWindows(output: string, now = Date.now()): UsageWindow[] {
  const rows: Array<{ window: UsageWindow; sortRank: number }> = [];
  const takenIds = new Set<string>();
  let currentGroup = "";

  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^quota:?$/i.test(line)) continue;

    let group = currentGroup;
    let limitLabel = "";
    let remainingPct: number | null = null;
    let resetsAt: string | null = null;

    const tableMatch = /^(.*?)\s{2,}(.*?)\s+(\d+)%(?:\s+(.*))?$/i.exec(line);
    if (tableMatch) {
      group = tableMatch[1]!.trim();
      limitLabel = tableMatch[2]!.trim();
      remainingPct = Number.parseInt(tableMatch[3]!, 10);
      resetsAt = parseResetTimestamp(tableMatch[4], now);
    } else {
      const parts = line.split(/\t+|\s{2,}/).map((part) => part.trim());
      if (parts.length >= 3) {
        group = parts[0]!;
        limitLabel = parts[1]!;
        const pctMatch = /(\d+)%/.exec(parts[2]!);
        if (pctMatch) remainingPct = Number.parseInt(pctMatch[1]!, 10);
        resetsAt = parseResetTimestamp(parts[3], now);
      } else if (line.endsWith(":") && !line.includes("%")) {
        currentGroup = line.slice(0, -1).trim();
        continue;
      }
    }

    if (remainingPct === null || !Number.isFinite(remainingPct)) continue;

    const usedPct = Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(100, remainingPct))));
    const scopeInfo = classifyQuotaScope(group, limitLabel);
    const durationSeconds = classifyDurationSeconds(limitLabel);
    const cleanLimit = limitLabel.replace(/\s+Limit(\s+Remaining)?$/i, "").trim();

    const built = windowFromReportedDuration({
      durationSeconds: durationSeconds ?? null,
      scope: { id: scopeInfo.id, label: scopeInfo.label },
      unknown: {
        id: normalizeIdentifier(cleanLimit) || "limit",
        label: cleanLimit || "Limit",
        shortLabel: "",
      },
      utilizationPct: usedPct,
      resetsAt,
      summary: scopeInfo.isPrimaryGemini,
      tone: toneFromUsedPct(usedPct),
    });

    const uniqueId = deduplicateId(built.id, takenIds);
    takenIds.add(uniqueId);
    rows.push({
      window: uniqueId === built.id ? built : { ...built, id: uniqueId },
      sortRank: scopeInfo.rankBase + durationSortOffset(durationSeconds),
    });
  }

  rows.sort((a, b) => a.sortRank - b.sortRank);
  const windows = rows.map((entry) => entry.window);
  if (windows.length > 0 && !windows.some((window) => window.summary)) {
    windows[0] = { ...windows[0]!, summary: true };
  }
  return windows;
}

export function parseAntigravityCredits(output: string): UsageBalance[] {
  const match = /Remaining\s+credits\s+([\d.]+)/i.exec(output);
  const remaining = match ? Number.parseFloat(match[1]!) : Number.NaN;
  if (!Number.isFinite(remaining)) return [];
  return [
    {
      id: "antigravity:credits",
      label: "Credits",
      remaining,
      unit: "credits",
      tone: balanceToneFromRemaining(remaining),
    },
  ];
}

function isAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /not\s+logged\s+in|auth(?:entication)?\s+required|unauthorized|\b401\b|please\s+log\s*in/i.test(msg);
}

async function runAgyCli(args: string[], options: { geminiHome: string; timeoutMs: number }): Promise<string> {
  const [command] = agyCommand();
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (options.geminiHome) {
    env.GEMINI_HOME = options.geminiHome;
  }
  const { stdout } = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    env,
    encoding: "utf8",
  });
  return stdout;
}

export function createUsageFetcher(runner: UsageCliRunner = runAgyCli, cacheTtlMs = CACHE_TTL_MS) {
  const cache = new Map<string, CacheEntry>();

  return async function fetchUsageReport(geminiHome: string): Promise<UsageReport> {
    const now = Date.now();
    const cached = cache.get(geminiHome);
    if (cached && now - cached.fetchedAt < cacheTtlMs) {
      return cached.report;
    }

    const [usageResult, creditsResult] = await Promise.allSettled([
      runner(["--print-timeout", "24h", "--print", "/usage"], {
        geminiHome,
        timeoutMs: USAGE_PROBE_TIMEOUT_MS,
      }),
      runner(["--print-timeout", "24h", "--print", "/credits"], {
        geminiHome,
        timeoutMs: CREDITS_PROBE_TIMEOUT_MS,
      }),
    ]);

    if (usageResult.status === "rejected") {
      console.warn(
        `[agy-provider] Usage probe failed: ${usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason)}`,
      );
      if (isAuthError(usageResult.reason)) {
        return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
      }
      if (cached) return cached.report;
      return {
        status: "error",
        error: usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason),
      };
    }

    const windows = parseAntigravityUsageWindows(usageResult.value, now);
    const balances = creditsResult.status === "fulfilled" ? parseAntigravityCredits(creditsResult.value) : [];
    if (windows.length === 0 && balances.length === 0) {
      if (cached) return cached.report;
      return unavailable({ kind: "no_quota", detail: "No Antigravity usage quota reported" });
    }

    const report: UsageReport = {
      status: "available",
      windows,
      ...(balances.length > 0 ? { balances } : {}),
    };
    cache.set(geminiHome, { fetchedAt: now, report });
    return report;
  };
}

export default function registerAgyUsageSource(
  server: PluginServerContext,
  runner: UsageCliRunner = runAgyCli,
): void {
  if (typeof server.registerUsageSource !== "function") return;
  const fetchUsage = createUsageFetcher(runner);

  server.registerUsageSource({
    id: "agy",
    label: "Antigravity",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope: UsageScope): Promise<UsageAccount[]> {
      if (scope.kind === "global") {
        const account = agyUsageAccount(defaultGeminiHome({}));
        return account ? [account] : [];
      }
      if (scope.provider !== "agy") return [];
      const account = agyUsageAccount(defaultGeminiHome(scope.env));
      return account ? [account] : [];
    },
    async fetch(value): Promise<UsageReport> {
      const { geminiHome } = inputSchema.parse(value);
      return fetchUsage(geminiHome);
    },
  });
}
