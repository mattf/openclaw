import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-model-shared";
import { applyPlsConfig, PLS_DEFAULT_MODEL_REF } from "./onboard.js";
import { getPlsModelCapabilities, loadPlsModelCapabilities } from "./pls-model-capabilities.js";
import { buildPlsProvider, PLS_BASE_URL } from "./provider-catalog.js";

const PROVIDER_ID = "pls";
const PLS_DEFAULT_MAX_TOKENS = 8192;

export default definePluginEntry({
  id: "pls",
  name: "PLS Provider",
  description: "OpenClaw PLS (Private LLM Service) provider plugin",
  register(api) {
    function buildDynamicPlsModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel {
      const capabilities = getPlsModelCapabilities(ctx.modelId);
      return {
        id: ctx.modelId,
        name: ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: PLS_BASE_URL,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? ["text"],
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? PLS_DEFAULT_MAX_TOKENS,
      };
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "PLS (Private LLM Service)",
      docsPath: "/providers/pls",
      envVars: ["PLS_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "PLS API key",
          hint: "API key",
          optionKey: "plsApiKey",
          flagName: "--pls-api-key",
          envVar: "PLS_API_KEY",
          promptMessage: "Enter PLS API key",
          defaultModel: PLS_DEFAULT_MODEL_REF,
          expectedProviders: ["pls"],
          applyConfig: (cfg) => applyPlsConfig(cfg),
          wizard: {
            choiceId: "pls-api-key",
            choiceLabel: "PLS API key",
            groupId: "pls-api-key",
            groupLabel: "PLS (Private LLM Service)",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildPlsProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicPlsModel(ctx),
      prepareDynamicModel: async (ctx) => {
        const rawApiKey = ctx.config?.models?.providers?.[PROVIDER_ID]?.apiKey;
        const apiKey =
          (typeof rawApiKey === "string" ? rawApiKey : undefined) ?? process.env.PLS_API_KEY ?? "";
        const baseUrl = ctx.providerConfig?.baseUrl ?? PLS_BASE_URL;
        await loadPlsModelCapabilities(ctx.modelId, apiKey, baseUrl);
      },
    });
  },
});
