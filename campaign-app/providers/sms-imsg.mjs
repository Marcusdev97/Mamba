import { spawn } from "node:child_process";
import {
  ProviderConfigurationError,
  ProviderSendError,
  ProviderUnavailableError,
} from "./provider-errors.mjs";

function runCommand(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new ProviderUnavailableError("imsg command timed out.", { provider: "imsg" }));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new ProviderUnavailableError(`Unable to start imsg: ${error.message}`, {
          provider: "imsg",
          cause: error,
        }));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new ProviderSendError(`imsg exited with code ${code}: ${stderr.trim() || "Unknown error"}`, {
          provider: "imsg",
        }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return { text: line }; }
    });
}

export function createImsgSmsProvider({
  id = "imsg",
  binary = "imsg",
  service = "sms",
  timeoutMs = 30000,
  runner = runCommand,
} = {}) {
  if (!binary) {
    throw new ProviderConfigurationError("imsg binary path is required.", { provider: id });
  }

  return {
    id,
    channel: "sms",

    async healthCheck() {
      const result = await runner(binary, ["--version"], timeoutMs);
      return {
        provider: id,
        channel: "sms",
        ok: true,
        status: "READY",
        version: result.stdout.trim() || result.stderr.trim(),
      };
    },

    async sendText({ to, text, sender = null, metadata = {} }) {
      const args = [
        "send",
        "--to", String(to),
        "--text", String(text),
        "--service", String(service),
        "--json",
      ];
      const result = await runner(binary, args, timeoutMs);
      const rows = parseJsonLines(result.stdout);
      const raw = rows.at(-1) ?? { stdout: result.stdout, stderr: result.stderr };
      return {
        provider: id,
        channel: "sms",
        senderId: sender?.id ?? null,
        messageId: raw?.guid ?? raw?.message_id ?? raw?.id ?? null,
        status: raw?.error ? "failed" : "accepted",
        sentAt: new Date().toISOString(),
        metadata,
        raw,
      };
    },
  };
}
