import { stripAnsi } from "./mcp.ts";

/**
 * Detects turn failures caused by an ACP session disconnect or missing worker session
 * (e.g. `Session not found`, `Internal error`, transport closed) that can be recovered
 * by reloading the session from its trajectory persistence.
 */
const RECOVERABLE_TURN_FAILURE_PATTERNS: RegExp[] = [
  /Session not found/i,
  /^Internal error$/i,
  /transport closed/i,
];

export function isRecoverableTurnFailureMessage(text: unknown): text is string {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }
  const clean = stripAnsi(text).trim();
  return RECOVERABLE_TURN_FAILURE_PATTERNS.some((re) => re.test(clean));
}

export type SessionPersistence = {
  version: number;
  data: any;
};

export type SessionOpenSnapshot = {
  openInput: Record<string, any>;
  persistence?: SessionPersistence;
};

/**
 * Applies `session.configure` changes onto a saved `session.open` input so that
 * reopening the session preserves model, mode, thinkingOption, and settings.
 */
export function applyConfigureChanges(
  snapshot: SessionOpenSnapshot,
  changes: Record<string, any> | undefined,
): SessionOpenSnapshot {
  if (!changes || typeof changes !== "object") return snapshot;
  const prevConfig = snapshot.openInput.config ?? {};
  const nextConfig: Record<string, any> = { ...prevConfig };

  if ("model" in changes) {
    if (typeof changes.model === "string" && changes.model.length > 0) {
      nextConfig.model = changes.model;
    } else if (changes.model === null) {
      delete nextConfig.model;
    }
  }
  if ("mode" in changes) {
    if (typeof changes.mode === "string" && changes.mode.length > 0) {
      nextConfig.mode = changes.mode;
    } else if (changes.mode === null) {
      delete nextConfig.mode;
    }
  }
  if ("thinkingOption" in changes) {
    if (typeof changes.thinkingOption === "string" && changes.thinkingOption.length > 0) {
      nextConfig.thinkingOption = changes.thinkingOption;
    } else if (changes.thinkingOption === null) {
      delete nextConfig.thinkingOption;
    }
  }
  if (changes.settings && typeof changes.settings === "object" && !Array.isArray(changes.settings)) {
    nextConfig.settings = {
      ...(prevConfig.settings ?? {}),
      ...changes.settings,
    };
  }

  return {
    ...snapshot,
    openInput: {
      ...snapshot.openInput,
      config: nextConfig,
    },
  };
}

/**
 * Applies a `session.config` event snapshot (such as an automatic model replacement)
 * onto a saved `session.open` input.
 */
export function applyConfigEventSnapshot(
  snapshot: SessionOpenSnapshot,
  configEvent: Record<string, any> | undefined,
): SessionOpenSnapshot {
  if (!configEvent || typeof configEvent !== "object") return snapshot;
  const prevConfig = snapshot.openInput.config ?? {};
  const nextConfig: Record<string, any> = { ...prevConfig };

  if (typeof configEvent.model === "string" && configEvent.model.length > 0) {
    nextConfig.model = configEvent.model;
  }
  if (typeof configEvent.mode === "string" && configEvent.mode.length > 0) {
    nextConfig.mode = configEvent.mode;
  }
  if (typeof configEvent.thinkingOption === "string" && configEvent.thinkingOption.length > 0) {
    nextConfig.thinkingOption = configEvent.thinkingOption;
  }

  return {
    ...snapshot,
    openInput: {
      ...snapshot.openInput,
      config: nextConfig,
    },
  };
}
