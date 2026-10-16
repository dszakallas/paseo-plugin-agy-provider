import { stripAnsi } from "./mcp.ts";

/**
 * Returns true if the message indicates that the user or agent has exhausted
 * their API usage quota.
 */
export function isQuotaExceededErrorMessage(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const clean = text.trim();
  if (/^Usage Limit Reached/i.test(clean)) return true;
  if (/You have reached your current quota/i.test(clean)) return true;
  if (/\b(?:RESOURCE|QUOTA)_EXHAUSTED\b/i.test(clean)) return true;
  if (/Individual quota reached/i.test(clean)) return true;
  if (/quota.*exceeded/i.test(clean) && /(?:Error\s*429|429)/i.test(clean)) return true;
  return false;
}

/**
 * Formats a quota exceeded message into clean, human-readable text for error display.
 */
export function formatQuotaExceededMessage(text: string): string {
  const clean = stripAnsi(text).trim();

  // Pattern 1: agy formatted CCPA message:
  // "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 17 hours."
  if (/^Usage Limit Reached/i.test(clean)) {
    const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bodyLines = lines.filter((l) => !/^Usage Limit Reached$/i.test(l));
    if (bodyLines.length > 0) {
      return bodyLines.join(" ");
    }
    return "Usage limit reached: you have reached your current quota for this period.";
  }

  // Pattern 2: Raw error containing "Individual quota reached... Resets in ..."
  const indMatch = clean.match(/Individual quota reached\b[\s\S]*?(?=(?:,\s*Status:|$))/i);
  if (indMatch) {
    return indMatch[0].trim();
  }

  return clean.replace(/\s+/g, " ");
}
