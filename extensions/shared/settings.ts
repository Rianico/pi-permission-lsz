import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { DEFAULT_RTK_TIMEOUT_MS } from "../../src/rtk.js";
import { parseTypeBoxValue } from "./typebox.js";

export const DEFAULT_TOGGLE_SHORTCUT = "alt+p" as KeyId;

const RTK_SETTINGS_SCHEMA = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number()),
});

const PERMISSIONS_FILE_SETTINGS_SCHEMA = Type.Object({
  toggleShortcut: Type.Optional(Type.String()),
  rtk: Type.Optional(RTK_SETTINGS_SCHEMA),
});

const ROOT_SETTINGS_SCHEMA = Type.Object({
  permissions: Type.Optional(PERMISSIONS_FILE_SETTINGS_SCHEMA),
});

type PermissionsFileSettings = Static<typeof PERMISSIONS_FILE_SETTINGS_SCHEMA>;

export interface PermissionsSettings {
  toggleShortcut: KeyId;
  rtk: { enabled: boolean; timeoutMs: number };
}

export function loadSettings(): PermissionsSettings {
  return resolvePermissionsSettings(loadPermissionsFileSettings());
}

function loadPermissionsFileSettings(): PermissionsFileSettings {
  const globalSettings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return parsed.permissions ?? {};
}

function resolvePermissionsSettings(fileSettings: PermissionsFileSettings): PermissionsSettings {
  return {
    toggleShortcut: normalizeShortcut(fileSettings.toggleShortcut),
    rtk: {
      enabled: fileSettings.rtk?.enabled ?? true,
      timeoutMs: fileSettings.rtk?.timeoutMs ?? DEFAULT_RTK_TIMEOUT_MS,
    },
  };
}

function normalizeShortcut(value: string | undefined): KeyId {
  const trimmed = value?.trim();
  return (trimmed ? trimmed : DEFAULT_TOGGLE_SHORTCUT) as KeyId;
}
