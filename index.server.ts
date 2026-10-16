import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { agyCommand } from "./server/command.ts";
import {
  filterViableMcpServers,
  isMcpInitializationErrorMessage,
  resolveMcpServers,
  stripAnsi,
} from "./server/mcp.ts";
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
        async send(input) {
          return connection.send(await withMcpServers(input));
        },
        onEvent(listener) {
          return connection.onEvent((event: any) => {
            if (event.type === "timeline.item") {
              if (event.item?.type === "tool_call") {
                event = {
                  ...event,
                  item: enrichToolCall(event.item),
                };
              } else if (
                event.item?.type === "assistant_message" ||
                event.item?.type === "reasoning"
              ) {
                if (isMcpInitializationErrorMessage(event.item?.text)) {
                  const cleanMessage = stripAnsi(event.item.text);
                  console.warn(
                    `[agy-provider] MCP initialization failure: ${cleanMessage}`,
                  );
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
