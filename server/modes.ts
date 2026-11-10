import type { ProviderCatalog, ProviderConfigState, ProviderMode } from "@getpaseo/plugin/server/provider";

export const DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID = "dangerously-skip-permissions";
export const YOLO_MODE_ID = "yolo";
export const AUTO_MODE_ID = "auto";

/**
 * Base native ACP mode to configure on the underlying `agy acp` server when
 * dangerously-skip-permissions mode is active. `accept-edits` allows
 * native file edits without overhead while any remaining tools (e.g. terminal/commands)
 * emit ACP permission requests.
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

export const AUTO_MODE: ProviderMode = {
  id: AUTO_MODE_ID,
  label: "Auto",
  description: "Approve edits and safe commands; ask before irreversible actions",
  icon: "ShieldCheck",
  colorTier: "moderate",
};

export const MODE_VISUALS: Record<string, { icon: string; colorTier: string; isUnattended?: boolean }> = {
  default: { icon: "Shield", colorTier: "safe" },
  "accept-edits": { icon: "ShieldPlus", colorTier: "moderate" },
  auto: { icon: "ShieldCheck", colorTier: "moderate" },
  plan: { icon: "ShieldEllipsis", colorTier: "planning" },
  "dangerously-skip-permissions": { icon: "ShieldOff", colorTier: "dangerous", isUnattended: true },
  yolo: { icon: "ShieldOff", colorTier: "dangerous", isUnattended: true },
};

export function isDangerouslySkipPermissionsMode(mode: unknown): boolean {
  return mode === DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID || mode === YOLO_MODE_ID;
}

export function isAutoMode(mode: unknown): boolean {
  return mode === AUTO_MODE_ID;
}

export function enrichModeVisuals(mode: ProviderMode): ProviderMode {
  const visuals = MODE_VISUALS[mode.id];
  if (!visuals) return mode;
  return {
    ...mode,
    icon: mode.icon ?? visuals.icon,
    colorTier: mode.colorTier ?? visuals.colorTier,
    ...(visuals.isUnattended !== undefined ? { isUnattended: mode.isUnattended ?? visuals.isUnattended } : {}),
  };
}

export function enrichCatalogModes<T extends { modes?: readonly ProviderMode[] }>(
  catalog: T,
): Omit<T, "modes"> & { modes: ProviderMode[] } {
  const modes = Array.isArray(catalog.modes) ? catalog.modes.map(enrichModeVisuals) : [];
  if (!modes.some((m) => m.id === AUTO_MODE_ID)) {
    modes.push(AUTO_MODE);
  }
  if (!modes.some((m) => isDangerouslySkipPermissionsMode(m.id))) {
    modes.push(DANGEROUSLY_SKIP_PERMISSIONS_MODE);
  }
  return { ...catalog, modes };
}

export function enrichConfigModes<T extends { modes?: readonly ProviderMode[]; mode?: string }>(
  config: T,
  currentMode?: string,
): Omit<T, "modes"> & { modes: ProviderMode[]; mode?: string } {
  const modes = Array.isArray(config.modes) ? config.modes.map(enrichModeVisuals) : [];
  if (!modes.some((m) => m.id === AUTO_MODE_ID)) {
    modes.push(AUTO_MODE);
  }
  if (!modes.some((m) => isDangerouslySkipPermissionsMode(m.id))) {
    modes.push(DANGEROUSLY_SKIP_PERMISSIONS_MODE);
  }
  const effectiveMode = isDangerouslySkipPermissionsMode(currentMode)
    ? DANGEROUSLY_SKIP_PERMISSIONS_MODE_ID
    : (currentMode ?? config.mode);
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
