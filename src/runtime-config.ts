import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runtime, dashboard-editable configuration for the tracking service.
 *
 * Values set here override the matching environment variables at read time and
 * are persisted to a JSON file so they survive restarts. This lets the COD
 * dashboard update the CAPTCHA solver keys and J&T concurrency without editing
 * the service `.env` and redeploying.
 *
 * Only the keys explicitly written are stored; anything left unset falls back
 * to `process.env`. Secret values are never returned in reads — only a masked
 * hint and whether a value is configured.
 */

export interface RuntimeConfig {
  capsolverApiKey?: string;
  twoCaptchaApiKey?: string;
  jtBulkConcurrency?: number;
}

export interface RuntimeConfigPatch {
  capsolverApiKey?: string | null;
  twoCaptchaApiKey?: string | null;
  jtBulkConcurrency?: number | null;
}

interface MaskedField {
  configured: boolean;
  source: "override" | "env" | "none";
  hint: string | null;
}

export interface MaskedRuntimeConfig {
  capsolverApiKey: MaskedField;
  twoCaptchaApiKey: MaskedField;
  jtBulkConcurrency: { value: number; source: "override" | "env" | "default" };
}

const CONFIG_PATH =
  process.env.RUNTIME_CONFIG_PATH ?? join(process.cwd(), "runtime-config.json");

let overrides: RuntimeConfig = loadFromDisk();

function loadFromDisk(): RuntimeConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as RuntimeConfig;
    return sanitize(parsed);
  } catch {
    return {};
  }
}

function sanitize(input: RuntimeConfig): RuntimeConfig {
  const next: RuntimeConfig = {};
  if (typeof input.capsolverApiKey === "string" && input.capsolverApiKey.trim()) {
    next.capsolverApiKey = input.capsolverApiKey.trim();
  }
  if (typeof input.twoCaptchaApiKey === "string" && input.twoCaptchaApiKey.trim()) {
    next.twoCaptchaApiKey = input.twoCaptchaApiKey.trim();
  }
  if (
    typeof input.jtBulkConcurrency === "number" &&
    Number.isFinite(input.jtBulkConcurrency)
  ) {
    next.jtBulkConcurrency = clampConcurrency(input.jtBulkConcurrency);
  }
  return next;
}

function persist(): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2), {
    mode: 0o600,
  });
}

function clampConcurrency(value: number): number {
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export function getCapsolverApiKey(): string | undefined {
  return overrides.capsolverApiKey ?? envValue("CAPSOLVER_API_KEY");
}

export function getTwoCaptchaApiKey(): string | undefined {
  return overrides.twoCaptchaApiKey ?? envValue("TWOCAPTCHA_API_KEY");
}

/** Raw concurrency string used as the default for `getJtBulkConcurrency`. */
export function getJtBulkConcurrencyRaw(): string | undefined {
  if (typeof overrides.jtBulkConcurrency === "number") {
    return String(overrides.jtBulkConcurrency);
  }
  return process.env.JT_BULK_CONCURRENCY;
}

function maskKey(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function maskField(override: string | undefined, envName: string): MaskedField {
  if (override) {
    return { configured: true, source: "override", hint: maskKey(override) };
  }
  const env = envValue(envName);
  if (env) {
    return { configured: true, source: "env", hint: maskKey(env) };
  }
  return { configured: false, source: "none", hint: null };
}

export function getMaskedRuntimeConfig(): MaskedRuntimeConfig {
  const concurrencySource: "override" | "env" | "default" =
    typeof overrides.jtBulkConcurrency === "number"
      ? "override"
      : envValue("JT_BULK_CONCURRENCY")
        ? "env"
        : "default";
  const rawConcurrency = getJtBulkConcurrencyRaw();
  const parsedConcurrency = Number.parseInt(rawConcurrency ?? "5", 10);
  return {
    capsolverApiKey: maskField(overrides.capsolverApiKey, "CAPSOLVER_API_KEY"),
    twoCaptchaApiKey: maskField(overrides.twoCaptchaApiKey, "TWOCAPTCHA_API_KEY"),
    jtBulkConcurrency: {
      value: Number.isFinite(parsedConcurrency)
        ? clampConcurrency(parsedConcurrency)
        : 5,
      source: concurrencySource,
    },
  };
}

/**
 * Apply a patch. A `null` (or empty string) value clears the override so the
 * corresponding env var takes over again; an omitted (`undefined`) field is
 * left unchanged. Returns the resulting masked config.
 */
export function updateRuntimeConfig(patch: RuntimeConfigPatch): MaskedRuntimeConfig {
  const next: RuntimeConfig = { ...overrides };

  if (patch.capsolverApiKey !== undefined) {
    const v = patch.capsolverApiKey?.trim();
    if (v) next.capsolverApiKey = v;
    else delete next.capsolverApiKey;
  }
  if (patch.twoCaptchaApiKey !== undefined) {
    const v = patch.twoCaptchaApiKey?.trim();
    if (v) next.twoCaptchaApiKey = v;
    else delete next.twoCaptchaApiKey;
  }
  if (patch.jtBulkConcurrency !== undefined) {
    if (
      patch.jtBulkConcurrency === null ||
      !Number.isFinite(patch.jtBulkConcurrency)
    ) {
      delete next.jtBulkConcurrency;
    } else {
      next.jtBulkConcurrency = clampConcurrency(patch.jtBulkConcurrency);
    }
  }

  overrides = next;
  persist();
  return getMaskedRuntimeConfig();
}
