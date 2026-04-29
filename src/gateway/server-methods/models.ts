import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { buildAllowedModelSet, normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function buildProviderFilteredCatalog(
  catalog: ModelCatalogEntry[],
  cfg: OpenClawConfig,
): ModelCatalogEntry[] {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const configuredProviders = new Set(
    Object.keys(providers).map((k) => normalizeProviderId(k)).filter(Boolean),
  );
  if (configuredProviders.size === 0) {
    return [];
  }
  return catalog.filter((entry) => configuredProviders.has(normalizeProviderId(entry.provider)));
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = context.getRuntimeConfig();
      const view = (params as { view?: string } | undefined)?.view ?? "default";
      if (view === "authenticated") {
        const filtered = buildProviderFilteredCatalog(catalog, cfg);
        if (filtered.length > 0) {
          respond(true, { models: filtered }, undefined);
          return;
        }
      }
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
