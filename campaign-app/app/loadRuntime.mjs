import { createAppState } from "./state.mjs";
import { loadEnv, makeApi } from "../campaign_core.mjs";

export async function loadRuntime(overrides = {}) {
  const env = overrides.env || await loadEnv();
  for (const [key, value] of Object.entries(env)) {
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }

  return {
    host: overrides.host || "127.0.0.1",
    port: Number(overrides.port ?? process.env.CONSOLE_PORT ?? 8787),
    env,
    api: overrides.api || makeApi(env),
    state: overrides.state || createAppState(),
    ...overrides,
  };
}
