const LEGACY_ACP_SERVER_PATTERN = /(?:^|[\\/])agy_acp_server\.(?:par|exe)$/i;

export function agyCommand(
  platform: NodeJS.Platform = process.platform,
  override = process.env.PASEO_AGY_ACP_BIN,
  dangerouslySkipPermissions = process.env.PASEO_AGY_DANGEROUSLY_SKIP_PERMISSIONS === "1",
): readonly [string, ...string[]] {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`Google's official Antigravity ACP server does not support ${platform}`);
  }

  const trimmed = override?.trim();
  const executable =
    trimmed && !LEGACY_ACP_SERVER_PATTERN.test(trimmed)
      ? trimmed
      : platform === "win32"
        ? "agy.exe"
        : "agy";
  const args = ["acp"];
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return [executable, ...args];
}
