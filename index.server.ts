import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { agyCommand } from "./server/command.ts";
import { resolveMcpServers } from "./server/mcp.ts";

// `ProviderInput` is not exported from the package root; session.open is the only shape used here.
type ProviderInput = { type: string; config?: { cwd?: string; mcpServers?: Record<string, unknown> } };

// Adds the MCP servers agy-cli would load. A failure here must never block the session.
function withMcpServers<T>(input: T): T {
  const open = input as unknown as ProviderInput;
  if (open?.type !== "session.open" || !open.config) return input;
  try {
    const mcpServers = resolveMcpServers(open.config.cwd || process.cwd(), open.config.mcpServers);
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
          return connection.send(withMcpServers(input));
        },
        onEvent(listener) {
          return connection.onEvent((event: any) => {
            if (
              event.type === "timeline.item" &&
              event.item?.type === "tool_call" &&
              event.item?.status === "failed" &&
              event.item?.error == null
            ) {
              event = {
                ...event,
                item: {
                  ...event.item,
                  error: event.item.detail?.output ?? "Tool call failed",
                },
              };
            }
            listener(event);
          });
        },
      };
    },
  });

  return () => {};
}
