import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { agyCommand } from "./server/command.ts";
import {
  filterViableMcpServers,
  isMcpInitializationErrorMessage,
  resolveMcpServers,
  stripAnsi,
} from "./server/mcp.ts";
import {
  formatQuotaExceededMessage,
  isQuotaExceededErrorMessage,
} from "./server/quota.ts";
import { enrichToolCall } from "./server/tools.ts";

// `ProviderInput` is not exported from the package root; session.open is the only shape used here.
type ProviderInput = { type: string; config?: { cwd?: string; mcpServers?: Record<string, unknown> } };

// Adds the MCP servers agy-cli would load and preflight-checks them so unviable servers
// never brick the ACP session executor. A failure here must never block the session.
export async function withMcpServers<T>(input: T): Promise<T> {
  const open = input as unknown as ProviderInput;
  if (open?.type !== "session.open" || !open.config) return input;
  try {
    const existingNames = new Set(Object.keys(open.config.mcpServers ?? {}));
    const resolved = resolveMcpServers(open.config.cwd || process.cwd(), open.config.mcpServers);
    const mcpServers = await filterViableMcpServers(
      resolved,
      open.config.cwd || process.cwd(),
      {
        existingServerNames: existingNames,
        warn: (msg) => console.warn(`[agy-provider] ${msg}`),
      },
    );
    return { ...input, config: { ...open.config, mcpServers } };
  } catch (error) {
    console.warn(`[agy-provider] Failed to resolve MCP servers: ${(error as Error).message}`);
    return input;
  }
}

export default function contribute(
  server: PluginServerContext,
  createProvider: typeof runAcpProvider = runAcpProvider,
) {
  const provider = createProvider({
    id: "agy",
    label: "Antigravity (ACP)",
    description: "Google's Antigravity coding agent through its official ACP server",
    icon: "icon.svg",
    command: agyCommand(),
  });

  server.registerProvider({
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      return {
        ...connection,
        async send(input: any) {
          if ((input?.type === "catalog" || input?.type === "sessions") && (!input.cwd || input.cwd === "/")) {
            input = { ...input, cwd: homedir() };
          }
          return connection.send(await withMcpServers(input));
        },
        onEvent(listener: any) {
          const pendingQuotaErrors = new Map<string, string>();
          const pendingMcpErrors = new Map<string, string>();
          return connection.onEvent((event: any) => {
            if (event.type === "session.turn") {
              if (event.state === "started") {
                pendingQuotaErrors.delete(event.sessionId);
                pendingMcpErrors.delete(event.sessionId);
              } else if (event.state === "completed" || event.state === "canceled") {
                const pendingQuota = pendingQuotaErrors.get(event.sessionId);
                if (pendingQuota) {
                  pendingQuotaErrors.delete(event.sessionId);
                  listener({
                    ...event,
                    state: "failed",
                    error: {
                      message: pendingQuota,
                      code: "quota_exhausted",
                    },
                  });
                  return;
                }
                const pendingMcp = pendingMcpErrors.get(event.sessionId);
                if (pendingMcp) {
                  pendingMcpErrors.delete(event.sessionId);
                  listener({
                    ...event,
                    state: "failed",
                    error: {
                      message: pendingMcp,
                      code: "mcp_initialization_failed",
                    },
                  });
                  return;
                }
              } else if (event.state === "failed") {
                const pendingQuota = pendingQuotaErrors.get(event.sessionId);
                pendingQuotaErrors.delete(event.sessionId);
                if (pendingQuota) {
                  listener({
                    ...event,
                    error: {
                      message: pendingQuota,
                      code: "quota_exhausted",
                      diagnostic: event.error?.diagnostic,
                    },
                  });
                  return;
                }
                const pendingMcp = pendingMcpErrors.get(event.sessionId);
                pendingMcpErrors.delete(event.sessionId);
                if (pendingMcp) {
                  listener({
                    ...event,
                    error: {
                      message: pendingMcp,
                      code: "mcp_initialization_failed",
                      diagnostic: event.error?.diagnostic,
                    },
                  });
                  return;
                }
              }
            } else if (event.type === "session.closed") {
              pendingQuotaErrors.delete(event.sessionId);
              pendingMcpErrors.delete(event.sessionId);
            } else if (event.type === "timeline.item") {
              if (event.item?.type === "tool_call") {
                event = {
                  ...event,
                  item: enrichToolCall(event.item),
                };
              } else if (
                event.item?.type === "assistant_message" ||
                event.item?.type === "reasoning"
              ) {
                if (isQuotaExceededErrorMessage(event.item?.text)) {
                  const cleanMessage = formatQuotaExceededMessage(event.item.text);
                  console.warn(`[agy-provider] Quota exceeded: ${cleanMessage}`);
                  pendingQuotaErrors.set(event.sessionId, cleanMessage);
                  return;
                }
                if (isMcpInitializationErrorMessage(event.item?.text)) {
                  const cleanMessage = stripAnsi(event.item.text);
                  console.warn(
                    `[agy-provider] MCP initialization failure: ${cleanMessage}`,
                  );
                  const existing = pendingMcpErrors.get(event.sessionId);
                  if (!existing || cleanMessage.length > existing.length) {
                    pendingMcpErrors.set(event.sessionId, cleanMessage);
                  }
                  return;
                }
              }
            }
            listener(event);
          });
        },
      };
    },
  });

  return () => {};
}
