import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const PLS_DEFAULT_MODEL_REF = "pls/default";

export function applyPlsConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(cfg, PLS_DEFAULT_MODEL_REF);
}
