import { statSync } from "node:fs";
import { loadDemoState, type DemoConfig, type DemoState } from "@/rwtsa-demo/state/demo-state";

/**
 * Reads the RWTSA_* configuration (the only environment variables this app touches) and loads the demo state.
 *
 * The result is memoised IN PROCESS MEMORY only, keyed by configuration plus the workbook / header-map file
 * signature (mtime and size), so editing the workbook is picked up on the next request. Nothing derived from the
 * workbook is written to disk, to the repository, or into the Next.js build output: every page is dynamic.
 */
export function configFromEnv(): DemoConfig {
  return {
    source: process.env.RWTSA_SOURCE,
    workbookPath: process.env.RWTSA_WORKBOOK_PATH,
    headerMapPath: process.env.RWTSA_HEADER_MAP,
    forecastWindow: process.env.RWTSA_FORECAST_WINDOW,
    devServer: process.env.NODE_ENV === "development",
  };
}

function signature(file: string | undefined): string {
  if (!file || file.trim() === "") return "-";
  try {
    const s = statSync(file.trim());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "unreadable";
  }
}

let memo: { key: string; state: Promise<DemoState> } | null = null;

export function getDemoState(config: DemoConfig = configFromEnv()): Promise<DemoState> {
  const key = JSON.stringify([config, signature(config.workbookPath), signature(config.headerMapPath)]);
  if (memo?.key !== key) memo = { key, state: loadDemoState(config) };
  return memo.state;
}
