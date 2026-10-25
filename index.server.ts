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
import { enqueueSteer, installSteerHook, removeSteerHook } from "./server/steer.ts";
import { installProgressHook, removeProgressHook } from "./server/progress.ts";

// `ProviderInput` is not exported from the package root; session.open is the only shape used here.
type ProviderInput = {
  type: string;
  sessionId?: string;
  config?: { cwd?: string; systemPrompt?: string; mcpServers?: Record<string, unknown> };
};

/** Concatenates the text parts of a prompt. */
function promptText(prompt: { input?: { type?: string; content?: unknown } }): string {
  if (prompt.input?.type !== "message" || !Array.isArray(prompt.input.content)) return "";
  return prompt.input.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as { type?: string }).type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

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

  // Steering needs a PreInvocation hook and progress narration a SessionStart
  // hook in Antigravity's global config.
  try {
    const steerHook = installSteerHook();
    if (steerHook.changed) {
      console.log(`[agy-provider] Installed steering hook in ${steerHook.path}`);
    }
    const progressHook = installProgressHook();
    if (progressHook.changed) {
      console.log(`[agy-provider] Installed progress hook in ${progressHook.path}`);
    }
  } catch (error) {
    console.warn(`[agy-provider] Could not install hooks: ${(error as Error).message}`);
  }

  // Marks sessions launched here, so the progress hook speaks only for them.
  server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "agy" || request.env.PASEO_AGY_PROGRESS === "1") return;
    return { ...request, env: { ...request.env, PASEO_AGY_PROGRESS: "1" } };
  });
  server.registerProvider({
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: any) => void>();
      const pendingQuotaErrors = new Map<string, string>();
      const pendingMcpErrors = new Map<string, string>();
      const activeTurns = new Map<string, string>();
      const conversationIds = new Map<string, string>();
      const pendingSystemPrompts = new Map<string, string>();
      const prependedSystemPrompts = new Map<string, string>();

      const emit = (event: any) => {
        for (const listener of listeners) listener(event);
      };

      connection.onEvent((event: any) => {
        if (event.type === "session.opened") {
          const nativeSessionId = event.persistence?.data?.sessionId;
          if (typeof nativeSessionId === "string" && nativeSessionId !== "") {
            conversationIds.set(event.sessionId, nativeSessionId);
          }
          if (Array.isArray(event.capabilities) && !event.capabilities.includes("prompt.steer")) {
            event = { ...event, capabilities: [...event.capabilities, "prompt.steer"] };
          }
        } else if (event.type === "session.turn") {
          if (event.state === "started") {
            activeTurns.set(event.sessionId, event.turnId);
            pendingQuotaErrors.delete(event.sessionId);
            pendingMcpErrors.delete(event.sessionId);
          } else {
            activeTurns.delete(event.sessionId);
            if (event.state === "completed" || event.state === "canceled") {
              const pendingQuota = pendingQuotaErrors.get(event.sessionId);
              if (pendingQuota) {
                pendingQuotaErrors.delete(event.sessionId);
                emit({
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
                emit({
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
                emit({
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
                emit({
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
          }
        } else if (event.type === "session.closed") {
          pendingQuotaErrors.delete(event.sessionId);
          pendingMcpErrors.delete(event.sessionId);
          activeTurns.delete(event.sessionId);
          conversationIds.delete(event.sessionId);
          pendingSystemPrompts.delete(event.sessionId);
          prependedSystemPrompts.delete(event.sessionId);
        } else if (event.type === "timeline.item") {
          if (event.item?.type === "tool_call") {
            event = {
              ...event,
              item: enrichToolCall(event.item),
            };
          } else if (event.item?.type === "user_message") {
            const prepended = prependedSystemPrompts.get(event.sessionId);
            if (prepended && typeof event.item.text === "string") {
              const prefix = `${prepended}\n\n`;
              if (event.item.text.startsWith(prefix)) {
                prependedSystemPrompts.delete(event.sessionId);
                event = {
                  ...event,
                  item: {
                    ...event.item,
                    text: event.item.text.slice(prefix.length),
                  },
                };
              } else if (event.item.text === prepended) {
                prependedSystemPrompts.delete(event.sessionId);
                event = {
                  ...event,
                  item: {
                    ...event.item,
                    text: "",
                  },
                };
              }
            }
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
        emit(event);
      });

      const baseCapabilities = Array.isArray(connection.capabilities) ? connection.capabilities : [];
      const capabilities = baseCapabilities.includes("prompt.steer")
        ? [...baseCapabilities]
        : [...baseCapabilities, "prompt.steer"];

      return {
        ...connection,
        capabilities,
        async send(input: any) {
          if (input?.type === "session.open") {
            const systemPrompt = input.config?.systemPrompt;
            if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
              pendingSystemPrompts.set(input.sessionId, systemPrompt.trim());
            }
          }
          if (input?.type === "session.prompt" && input.prompt?.delivery === "steer") {
            const turnId = activeTurns.get(input.sessionId);
            const text = promptText(input.prompt);
            if (turnId && text !== "") {
              // Steering path: Antigravity only reads input between turns, so the
              // message is queued for the PreInvocation hook (see server/steer.ts)
              // rather than forwarded as another ACP prompt. Forwarding it would
              // make the ACP adapter interrupt the active turn and start a new one.
              enqueueSteer(conversationIds.get(input.sessionId) ?? input.sessionId, text);
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                item: {
                  type: "user_message",
                  id: input.prompt.clientMessageId,
                  text,
                  clientMessageId: input.prompt.clientMessageId,
                },
              });
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "steer", turnId },
              });
              return;
            }
            // No active turn (the steer arrived too late) or no text to inject:
            // degrade to a normal prompt so the message is never dropped.
            input = { ...input, prompt: { ...input.prompt, delivery: "auto" } };
          }
          if (input?.type === "session.prompt") {
            const systemPrompt = pendingSystemPrompts.get(input.sessionId);
            if (systemPrompt) {
              pendingSystemPrompts.delete(input.sessionId);
              prependedSystemPrompts.set(input.sessionId, systemPrompt);
              if (input.prompt?.input?.type === "message" && Array.isArray(input.prompt.input.content)) {
                const content = input.prompt.input.content;
                const firstTextIndex = content.findIndex(
                  (part: any) => part && typeof part === "object" && part.type === "text",
                );
                if (firstTextIndex >= 0) {
                  input = {
                    ...input,
                    prompt: {
                      ...input.prompt,
                      input: {
                        ...input.prompt.input,
                        content: content.map((part: any, i: number) =>
                          i === firstTextIndex
                            ? { ...part, text: `${systemPrompt}\n\n${part.text}` }
                            : part,
                        ),
                      },
                    },
                  };
                } else {
                  input = {
                    ...input,
                    prompt: {
                      ...input.prompt,
                      input: {
                        ...input.prompt.input,
                        content: [{ type: "text", text: systemPrompt }, ...content],
                      },
                    },
                  };
                }
              }
            }
          }
          if ((input?.type === "catalog" || input?.type === "sessions") && (!input.cwd || input.cwd === "/")) {
            input = { ...input, cwd: homedir() };
          }
          return connection.send(await withMcpServers(input));
        },
        onEvent(listener: any) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async close() {
          listeners.clear();
          return connection.close();
        },
      };
    },
  });

  return () => {
    // Leaving the hook installed would spawn a process on every model call for
    // a plugin that no longer queues anything.
    try {
      removeSteerHook();
      removeProgressHook();
    } catch {
      // Best effort.
    }
  };
}
