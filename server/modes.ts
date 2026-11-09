import type { ProviderCatalog, ProviderConfigState, ProviderMode } from "@getpaseo/plugin/server/provider";

export const DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID = "dangerously-skip-permissions";
export const YOLO_MODE_ID = "yolo";

/**
 * Base native ACP mode to configure on the underlying `agy acp` server when
 * dangerously-skip-permissions mode is active. `accept-edits` allows native file
 * edits without overhead while any remaining tools (e.g. terminal/commands)
 * emit ACP permission requests that the plugin auto-approves.
 */
export const NATIVE_AUTO_APPROVE_BASE_MODE = "accept-edits";

export const DANGEROUSLY_SKIP_PERMISSIONS_MODE: ProviderMode = {
  id: DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID,
  label: "Dangerously skip permissions",
  description: "Auto-approve all tool permission requests without prompting",
  icon: "ShieldOff",
  colorTier: "dangerous",
  isUnattended: true,
};

export function isDangerouslySkipPermissionsMode(mode: unknown): boolean {
  return mode === DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID || mode === YOLO_MODE_ID;
}

export function enrichCatalogModes<T extends { modes?: readonly ProviderMode[] }>(catalog: T): T {
  const modes = Array.isArray(catalog.modes) ? [...catalog.modes] : [];
  if (!modes.some((m) => isDangerouslySkipPermissionsMode(m.id))) {
    modes.push(DANGEROUSLY_SKIP_PERMISSIONS_MODE);
  }
  return { ...catalog, modes };
}

export function enrichConfigModes<T extends { modes?: readonly ProviderMode[]; mode?: string }>(
  config: T,
  currentMode?: string,
): T {
  const modes = Array.isArray(config.modes) ? [...config.modes] : [];
  if (!modes.some((m) => isDangerouslySkipPermissionsMode(m.id))) {
    modes.push(DANGEROUSLY_SKIP_PERMISSIONS_MODE);
  }
  const effectiveMode = isDangerouslySkipPermissionsMode(currentMode)
    ? DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID
    : config.mode;
  return {
    ...config,
    modes,
    ...(effectiveMode !== undefined ? { mode: effectiveMode } : {}),
  };
}

export type PermissionAction = {
  id?: string;
  label?: string;
  behavior?: "allow" | "deny" | string;
};

export function findAllowPermissionAction(
  actions: readonly PermissionAction[] | undefined,
): PermissionAction | undefined {
  if (!Array.isArray(actions)) return undefined;
  return actions.find((action) => action?.behavior === "allow");
}
