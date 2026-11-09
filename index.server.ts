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
import {
  type SessionOpenSnapshot,
  applyConfigEventSnapshot,
  applyConfigureChanges,
  formatConnectionLostMessage,
  isConnectionLostErrorMessage,
  isRecoverableTurnFailureMessage,
} from "./server/recovery.ts";
import { enrichToolCall } from "./server/tools.ts";
import {
  DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID,
  NATIVE_AUTO_APPROVE_BASE_MODE,
  enrichCatalogModes,
  enrichConfigModes,
  findAllowPermissionAction,
  isDangerouslySkipPermissionsMode,
} from "./server/modes.ts";
import { enqueueSteer, installSteerHook, removeSteerHook } from "./server/steer.ts";
import { installProgressHook, removeProgressHook } from "./server/progress.ts";
import { installTaskGuardHook, removeTaskGuardHook } from "./server/task-guard.ts";

// `ProviderInput` is not exported from the package root; session.open is the only shape used here.
type ProviderInput = {
  type: string;
  sessionId?: string;
  config?: { cwd?: string; systemPrompt?: string; mcpServers?: Record<string, unknown> };
};

type RebuildState = {
  sessionId: string;
  phase: "closing" | "opening" | "replaying";
  closeRequestId: string;
  openRequestId: string;
  clientMessageId?: string;
  turnId?: string;
  fallbackError: string;
  onCloseSettled: () => void;
  onOpenReady: () => void;
  onOpenFailed: (message: string) => void;
};

let recoverySequence = 0;

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

  // Steering needs a PreInvocation hook, progress narration a SessionStart hook,
  // and task-guard a PreToolUse hook in Antigravity's global config.
  try {
    const steerHook = installSteerHook();
    if (steerHook.changed) {
      console.log(`[agy-provider] Installed steering hook in ${steerHook.path}`);
    }
    const progressHook = installProgressHook();
    if (progressHook.changed) {
      console.log(`[agy-provider] Installed progress hook in ${progressHook.path}`);
    }
    const taskGuardHook = installTaskGuardHook();
    if (taskGuardHook.changed) {
      console.log(`[agy-provider] Installed task-guard hook in ${taskGuardHook.path}`);
    }
  } catch (error) {
    console.warn(`[agy-provider] Could not install hooks: ${(error as Error).message}`);
  }

  // Marks sessions launched here, so the progress and task-guard hooks apply only to them.
  server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "agy" || request.env.PASEO_AGY_PROGRESS === "1") return;
    return { ...request, env: { ...request.env, PASEO_AGY_PROGRESS: "1" } };
  });
  server.registerProvider({
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: any) => void>();
      const sessionModes = new Map<string, string>();
      const pendingQuotaErrors = new Map<string, string>();
      const pendingMcpErrors = new Map<string, string>();
      const pendingConnectionErrors = new Map<string, string>();
      const activeTurns = new Map<string, string>();
      const conversationIds = new Map<string, string>();
      const pendingSystemPrompts = new Map<string, string>();
      const prependedSystemPrompts = new Map<string, string>();
      const sessionSnapshots = new Map<string, SessionOpenSnapshot>();
      const lastPrompts = new Map<string, { input: any; retried: boolean }>();
      const rebuildingSessions = new Map<string, RebuildState>();
      const rebuildingByRequestId = new Map<string, RebuildState>();
      const recoveryPromises = new Map<string, Promise<void>>();

      const emit = (event: any) => {
        for (const listener of listeners) listener(event);
      };

      const startSessionRecovery = (
        sessionId: string,
        options: { replayPrompt?: any; turnId?: string; fallbackError: string },
      ): Promise<void> => {
        const snapshot = sessionSnapshots.get(sessionId);
        if (!snapshot?.persistence || rebuildingSessions.has(sessionId)) {
          if (options.replayPrompt && options.turnId) {
            emit({
              type: "session.turn",
              sessionId,
              turnId: options.turnId,
              state: "failed",
              error: {
                message: options.fallbackError,
                code: "connection_lost",
              },
            });
          }
          return Promise.resolve();
        }

        const seq = ++recoverySequence;
        const closeRequestId = `agy-recover-close:${sessionId}:${seq}`;
        const openRequestId = `agy-recover-open:${sessionId}:${seq}`;
        let resolveClose!: () => void;
        let resolveOpen!: () => void;
        let rejectOpen!: (error: Error) => void;

        const closePromise = new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        const openPromise = new Promise<void>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        });

        const state: RebuildState = {
          sessionId,
          phase: "closing",
          closeRequestId,
          openRequestId,
          clientMessageId: options.replayPrompt?.prompt?.clientMessageId,
          turnId: options.turnId,
          fallbackError: options.fallbackError,
          onCloseSettled: () => resolveClose(),
          onOpenReady: () => resolveOpen(),
          onOpenFailed: (message) => rejectOpen(new Error(message)),
        };

        rebuildingSessions.set(sessionId, state);
        rebuildingByRequestId.set(closeRequestId, state);
        rebuildingByRequestId.set(openRequestId, state);

        const cleanupRequestIds = () => {
          rebuildingByRequestId.delete(closeRequestId);
          rebuildingByRequestId.delete(openRequestId);
        };

        const run = (async () => {
          try {
            await connection.send({
              type: "session.close",
              requestId: closeRequestId,
              sessionId,
            });
            await closePromise;

            state.phase = "opening";
            const currentSnapshot = sessionSnapshots.get(sessionId) ?? snapshot;
            const recoveryOpenInput = {
              ...currentSnapshot.openInput,
              type: "session.open",
              requestId: openRequestId,
              sessionId,
              persistence: currentSnapshot.persistence,
              history: "skip",
            } as any;
            if (isDangerouslySkipPermissionsMode(recoveryOpenInput.config?.mode)) {
              recoveryOpenInput.config = {
                ...recoveryOpenInput.config,
                mode: NATIVE_AUTO_APPROVE_BASE_MODE,
              };
            }
            await connection.send(recoveryOpenInput);
            await openPromise;
            cleanupRequestIds();

            // Yield one macrotask so `openSession` in `@getpaseo/plugin` finishes
            // registering `state.sessions.set(sessionId, ...)` after `session.ready`.
            await new Promise((resolve) => setTimeout(resolve, 0));

            if (options.replayPrompt && options.turnId) {
              state.phase = "replaying";
              activeTurns.set(sessionId, options.turnId);
              await connection.send(options.replayPrompt);
            } else {
              rebuildingSessions.delete(sessionId);
            }
          } catch (error) {
            cleanupRequestIds();
            rebuildingSessions.delete(sessionId);
            activeTurns.delete(sessionId);
            console.warn(
              `[agy-provider] Failed to recover session ${sessionId}: ${(error as Error).message}`,
            );
            if (options.replayPrompt && options.turnId) {
              emit({
                type: "session.turn",
                sessionId,
                turnId: options.turnId,
                state: "failed",
                error: {
                  message: options.fallbackError,
                  code: "connection_lost",
                },
              });
            }
          } finally {
            recoveryPromises.delete(sessionId);
          }
        })();

        recoveryPromises.set(sessionId, run);
        return run;
      };

      connection.onEvent((event: any) => {
        if (typeof event.requestId === "string") {
          const rebuildByReq = rebuildingByRequestId.get(event.requestId);
          if (rebuildByReq) {
            if (event.requestId === rebuildByReq.closeRequestId) {
              if (event.type === "request.completed" || event.type === "request.failed") {
                rebuildByReq.onCloseSettled();
                return;
              }
            } else if (event.requestId === rebuildByReq.openRequestId) {
              if (event.type === "session.opened") {
                const nativeSessionId = event.persistence?.data?.sessionId;
                if (typeof nativeSessionId === "string" && nativeSessionId !== "") {
                  conversationIds.set(event.sessionId, nativeSessionId);
                }
                const snap = sessionSnapshots.get(event.sessionId);
                if (snap && event.persistence) {
                  sessionSnapshots.set(event.sessionId, {
                    ...snap,
                    persistence: event.persistence,
                  });
                }
                return;
              }
              if (event.type === "session.ready") {
                rebuildByReq.onOpenReady();
                return;
              }
              if (event.type === "request.failed") {
                rebuildByReq.onOpenFailed(
                  event.error?.message ?? "Failed to reopen ACP session",
                );
                return;
              }
            }
          }
        }

        if (typeof event.sessionId === "string") {
          const rebuild = rebuildingSessions.get(event.sessionId);
          if (rebuild) {
            if (rebuild.phase === "closing" || rebuild.phase === "opening") {
              if (event.type === "session.runtime_failed" && rebuild.phase === "opening") {
                rebuild.onOpenFailed(
                  event.error?.message ?? "ACP runtime failed while reopening session",
                );
              }
              return;
            }
            if (rebuild.phase === "replaying") {
              if (
                event.type === "timeline.item" &&
                event.item?.type === "user_message" &&
                (!rebuild.clientMessageId || event.item.id === rebuild.clientMessageId)
              ) {
                return;
              }
              if (
                event.type === "session.prompt_result" &&
                (!rebuild.clientMessageId || event.clientMessageId === rebuild.clientMessageId)
              ) {
                if (event.result?.type === "failed") {
                  rebuildingSessions.delete(event.sessionId);
                  activeTurns.delete(event.sessionId);
                  if (rebuild.turnId) {
                    emit({
                      type: "session.turn",
                      sessionId: event.sessionId,
                      turnId: rebuild.turnId,
                      state: "failed",
                      error: {
                        message: event.result.error?.message ?? rebuild.fallbackError,
                        code: "connection_lost",
                      },
                    });
                  }
                }
                return;
              }
              if (event.type === "session.turn" && event.state === "started") {
                activeTurns.set(event.sessionId, event.turnId);
                rebuildingSessions.delete(event.sessionId);
                return;
              }
            }
          }
        }

        if (event.type === "catalog" && event.catalog) {
          event = {
            ...event,
            catalog: enrichCatalogModes(event.catalog),
          };
        } else if (event.type === "session.opened") {
          const nativeSessionId = event.persistence?.data?.sessionId;
          if (typeof nativeSessionId === "string" && nativeSessionId !== "") {
            conversationIds.set(event.sessionId, nativeSessionId);
          }
          const snap = sessionSnapshots.get(event.sessionId);
          if (snap && event.persistence) {
            sessionSnapshots.set(event.sessionId, {
              ...snap,
              persistence: event.persistence,
            });
          }
          if (Array.isArray(event.capabilities) && !event.capabilities.includes("prompt.steer")) {
            event = { ...event, capabilities: [...event.capabilities, "prompt.steer"] };
          }
        } else if (event.type === "session.config") {
          const currentMode = sessionModes.get(event.sessionId);
          event = {
            ...event,
            config: enrichConfigModes(event.config, currentMode),
          };
          const snap = sessionSnapshots.get(event.sessionId);
          if (snap && event.config) {
            sessionSnapshots.set(
              event.sessionId,
              applyConfigEventSnapshot(snap, event.config),
            );
          }
        } else if (event.type === "session.permission") {
          if (isDangerouslySkipPermissionsMode(sessionModes.get(event.sessionId))) {
            const allowAction = findAllowPermissionAction(event.request?.actions);
            void connection.send({
              type: "session.permission",
              sessionId: event.sessionId,
              permissionId: event.request?.id,
              response: {
                behavior: "allow",
                ...(allowAction?.id !== undefined ? { selectedActionId: allowAction.id } : {}),
              },
            }).catch((error) => {
              console.warn(
                `[agy-provider] Failed to auto-approve permission ${event.request?.id}: ${(error as Error).message}`,
              );
            });
            return;
          }
        } else if (event.type === "session.permission_resolved") {
          if (isDangerouslySkipPermissionsMode(sessionModes.get(event.sessionId))) {
            return;
          }
        } else if (event.type === "session.turn") {
          if (event.state === "started") {
            activeTurns.set(event.sessionId, event.turnId);
            pendingQuotaErrors.delete(event.sessionId);
            pendingMcpErrors.delete(event.sessionId);
            pendingConnectionErrors.delete(event.sessionId);
          } else {
            activeTurns.delete(event.sessionId);
            const pendingConnection = pendingConnectionErrors.get(event.sessionId);
            pendingConnectionErrors.delete(event.sessionId);

            const isRecoverableFailure =
              Boolean(pendingConnection) ||
              (event.state === "failed" &&
                isRecoverableTurnFailureMessage(event.error?.message));

            if (isRecoverableFailure) {
              const lastPrompt = lastPrompts.get(event.sessionId);
              const snapshot = sessionSnapshots.get(event.sessionId);
              const fallbackError =
                pendingConnection ??
                event.error?.message ??
                "Agent connection was lost and could not be re-established.";

              if (lastPrompt && !lastPrompt.retried && snapshot?.persistence) {
                lastPrompt.retried = true;
                console.warn(
                  `[agy-provider] Recovering dead ACP session ${event.sessionId} and replaying turn (${fallbackError})`,
                );
                void startSessionRecovery(event.sessionId, {
                  replayPrompt: lastPrompt.input,
                  turnId: event.turnId,
                  fallbackError,
                });
                return;
              }

              emit({
                ...event,
                state: "failed",
                error: {
                  message: fallbackError,
                  code: "connection_lost",
                  ...(event.error?.diagnostic ? { diagnostic: event.error.diagnostic } : {}),
                },
              });
              if (snapshot?.persistence) {
                void startSessionRecovery(event.sessionId, { fallbackError });
              }
              return;
            }

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
          sessionModes.delete(event.sessionId);
          pendingQuotaErrors.delete(event.sessionId);
          pendingMcpErrors.delete(event.sessionId);
          pendingConnectionErrors.delete(event.sessionId);
          activeTurns.delete(event.sessionId);
          conversationIds.delete(event.sessionId);
          pendingSystemPrompts.delete(event.sessionId);
          prependedSystemPrompts.delete(event.sessionId);
          sessionSnapshots.delete(event.sessionId);
          lastPrompts.delete(event.sessionId);
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
            if (isConnectionLostErrorMessage(event.item?.text)) {
              const cleanMessage = formatConnectionLostMessage(event.item.text);
              console.warn(`[agy-provider] Connection lost: ${cleanMessage}`);
              pendingConnectionErrors.set(event.sessionId, cleanMessage);
              return;
            }
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
          if (typeof input?.sessionId === "string") {
            const activeRecovery = recoveryPromises.get(input.sessionId);
            if (activeRecovery) {
              await activeRecovery;
            }
          }
          if (input?.type === "session.open") {
            const systemPrompt = input.config?.systemPrompt;
            if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
              pendingSystemPrompts.set(input.sessionId, systemPrompt.trim());
            }
            const requestedMode = input.config?.mode;
            if (isDangerouslySkipPermissionsMode(requestedMode)) {
              sessionModes.set(input.sessionId, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);
              input = {
                ...input,
                config: {
                  ...input.config,
                  mode: NATIVE_AUTO_APPROVE_BASE_MODE,
                },
              };
            } else if (typeof requestedMode === "string" && requestedMode.length > 0) {
              sessionModes.set(input.sessionId, requestedMode);
            }
          }
          if (input?.type === "session.configure" && typeof input.sessionId === "string") {
            if (input.changes && "mode" in input.changes) {
              const requestedMode = input.changes.mode;
              if (isDangerouslySkipPermissionsMode(requestedMode)) {
                sessionModes.set(input.sessionId, DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID);
                input = {
                  ...input,
                  changes: {
                    ...input.changes,
                    mode: NATIVE_AUTO_APPROVE_BASE_MODE,
                  },
                };
              } else if (typeof requestedMode === "string" && requestedMode.length > 0) {
                sessionModes.set(input.sessionId, requestedMode);
              } else if (requestedMode === null) {
                sessionModes.delete(input.sessionId);
              }
            }
            const snap = sessionSnapshots.get(input.sessionId);
            if (snap) {
              const recordedMode = sessionModes.get(input.sessionId);
              const snapshotChanges =
                isDangerouslySkipPermissionsMode(recordedMode) && input.changes
                  ? { ...input.changes, mode: DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID }
                  : input.changes;
              sessionSnapshots.set(
                input.sessionId,
                applyConfigureChanges(snap, snapshotChanges),
              );
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
            if (typeof input.sessionId === "string") {
              lastPrompts.set(input.sessionId, { input, retried: false });
            }
          }
          if ((input?.type === "catalog" || input?.type === "sessions") && (!input.cwd || input.cwd === "/")) {
            input = { ...input, cwd: homedir() };
          }
          const resolvedInput = await withMcpServers(input);
          if (resolvedInput?.type === "session.open" && typeof resolvedInput.sessionId === "string") {
            const recordedMode = sessionModes.get(resolvedInput.sessionId);
            const snapshotOpenInput =
              isDangerouslySkipPermissionsMode(recordedMode) && resolvedInput.config
                ? {
                    ...resolvedInput,
                    config: {
                      ...resolvedInput.config,
                      mode: DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID,
                    },
                  }
                : resolvedInput;
            sessionSnapshots.set(resolvedInput.sessionId, {
              openInput: snapshotOpenInput as Record<string, any>,
              persistence: (resolvedInput as any).persistence,
            });
          }
          return connection.send(resolvedInput);
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
    // Leaving the hooks installed would spawn processes for a plugin that is no longer active.
    try {
      removeSteerHook();
      removeProgressHook();
      removeTaskGuardHook();
    } catch {
      // Best effort.
    }
  };
}
