import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const PLS_BASE_URL = "https://api.pls.beyondbits.dev/v1";

export function buildPlsProvider(): ModelProviderConfig {
  return {
    baseUrl: PLS_BASE_URL,
    api: "openai-completions",
    models: [],
  };
}
