import type { Capabilities } from "../bindings/Capabilities";
import { appInfo } from "./platform";

export type { Capabilities };

/**
 * What this build can do (NP-072a): a file manager, a tray, quitting, browser capture, the MCP
 * server, the updater… Shared components show what exists and hide the rest, instead of asking which
 * system they run on.
 */
export const capabilities: Capabilities = appInfo.capabilities;

/**
 * The desktop's own commands (the file manager, the tray, quitting, the updater, capture, MCP) are
 * registered: `desktopApi` (services/api.ts) is there. Rust registers them on a desktop build only
 * (src-tauri/src/ipc.rs).
 */
export const desktopCommands = appInfo.platform === "desktop";
