/**
 * Runtime PLS model capability detection.
 *
 * When a PLS model is requested, we look up its actual capabilities from a
 * cached copy of the PLS model catalog fetched from the API.
 *
 * Cache layers (checked in order):
 * 1. In-memory Map (instant, cleared on process restart)
 * 2. On-disk JSON file (<stateDir>/cache/pls-models.json)
 * 3. PLS API fetch (populates both layers)
 *
 * Model capabilities are assumed stable — the cache has no TTL expiry.
 * A background refresh is triggered only when a model is not found in
 * the cache (i.e. a newly added model on PLS).
 *
 * Sync callers can read whatever is already cached. Async callers can await a
 * one-time fetch so the first unknown-model lookup resolves with real
 * capabilities instead of the text-only fallback.
 *
 * Embedding models (IDs matching /embed/i) are excluded from the cache and
 * must NOT be registered as generation models.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const log = createSubsystemLogger("pls-model-capabilities");

const FETCH_TIMEOUT_MS = 10_000;
const DISK_CACHE_FILENAME = "pls-models.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlsApiModel {
  id?: string;
  context_length?: number;
  max_completion_tokens?: number;
  input?: string[];
}

export interface PlsModelCapabilities {
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface DiskCachePayload {
  models: Record<string, PlsModelCapabilities>;
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function resolveDiskCacheDir(): string {
  return join(resolveStateDir(), "cache");
}

function resolveDiskCachePath(): string {
  return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}

function writeDiskCache(map: Map<string, PlsModelCapabilities>): void {
  try {
    const cacheDir = resolveDiskCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const payload: DiskCachePayload = {
      models: Object.fromEntries(map),
    };
    writeFileSync(resolveDiskCachePath(), JSON.stringify(payload), "utf-8");
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to write PLS disk cache: ${message}`);
  }
}

function isValidCapabilities(value: unknown): value is PlsModelCapabilities {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.input) &&
    typeof record.reasoning === "boolean" &&
    typeof record.contextWindow === "number" &&
    typeof record.maxTokens === "number"
  );
}

function readDiskCache(): Map<string, PlsModelCapabilities> | undefined {
  try {
    const cachePath = resolveDiskCachePath();
    if (!existsSync(cachePath)) {
      return undefined;
    }
    const raw = readFileSync(cachePath, "utf-8");
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const models = (payload as DiskCachePayload).models;
    if (!models || typeof models !== "object") {
      return undefined;
    }
    const map = new Map<string, PlsModelCapabilities>();
    for (const [id, caps] of Object.entries(models)) {
      if (isValidCapabilities(caps)) {
        map.set(id, caps);
      }
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// In-memory cache state
// ---------------------------------------------------------------------------

let cache: Map<string, PlsModelCapabilities> | undefined;
let fetchInFlight: Promise<void> | undefined;
const skipNextMissRefresh = new Set<string>();

function parseModel(model: PlsApiModel): PlsModelCapabilities {
  const rawInput = model.input ?? ["text"];
  const input: Array<"text" | "image"> = rawInput.includes("image") ? ["text", "image"] : ["text"];

  const id = model.id ?? "";
  const reasoning = /r1|reasoning|think|reason/i.test(id);

  return {
    input,
    reasoning,
    contextWindow: model.context_length || 128_000,
    maxTokens: model.max_completion_tokens || 8192,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function doFetch(apiKey: string, baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const modelsUrl = `${baseUrl}/models`;
    const response = await globalThis.fetch(modelsUrl, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      log.warn(`PLS models API returned ${response.status}`);
      return;
    }

    const data = (await response.json()) as { data?: PlsApiModel[] };
    const models = data.data ?? [];
    const map = new Map<string, PlsModelCapabilities>();

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      // Exclude embedding models — they are not generation models.
      if (/embed/i.test(model.id)) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    writeDiskCache(map);
    log.debug(`Cached ${map.size} PLS models from API`);
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.warn(`Failed to fetch PLS models: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function triggerFetch(apiKey: string, baseUrl: string): void {
  if (fetchInFlight) {
    return;
  }
  fetchInFlight = doFetch(apiKey, baseUrl).finally(() => {
    fetchInFlight = undefined;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the in-memory cache is populated from disk if available.
 * Does not trigger a network fetch (no credentials available here).
 * Does not block — returns immediately.
 */
export function ensurePlsModelCache(): void {
  if (cache) {
    return;
  }

  // Try loading from disk before hitting the network.
  const disk = readDiskCache();
  if (disk) {
    cache = disk;
    log.debug(`Loaded ${disk.size} PLS models from disk cache`);
  }
}

/**
 * Ensure capabilities for a specific model are available before first use.
 *
 * Known cached entries return immediately. Unknown entries wait for at most
 * one catalog fetch, then leave sync resolution to read from the populated
 * cache on the same request.
 */
export async function loadPlsModelCapabilities(
  modelId: string,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  ensurePlsModelCache();
  if (cache?.has(modelId)) {
    return;
  }
  let fetchPromise = fetchInFlight;
  if (!fetchPromise) {
    triggerFetch(apiKey, baseUrl);
    fetchPromise = fetchInFlight;
  }
  await fetchPromise;
  if (!cache?.has(modelId)) {
    skipNextMissRefresh.add(modelId);
  }
}

/**
 * Synchronously look up model capabilities from the cache.
 *
 * If a model is not found but the cache exists, the caller should ensure
 * loadPlsModelCapabilities was awaited in prepareDynamicModel first.
 */
export function getPlsModelCapabilities(modelId: string): PlsModelCapabilities | undefined {
  ensurePlsModelCache();
  const result = cache?.get(modelId);

  // Model not found but cache exists — may be a newly added model.
  if (!result && skipNextMissRefresh.delete(modelId)) {
    return undefined;
  }

  return result;
}
