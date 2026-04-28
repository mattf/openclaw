import {
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveBaseUrl,
  resolveBraveMode,
} from "./src/brave-web-search-provider.shared.js";

export const __testing = {
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveBaseUrl,
  resolveBraveMode,
  mapBraveLlmContextResults,
} as const;
