export type ModelProvider = "deepseek" | "kimi" | "kimi_code_plan" | "glm" | "dashscope" | "volcengine" | "qianfan" | "hunyuan" | "siliconflow" | "custom";
export type ThinkingMode = "auto" | "enabled" | "disabled";
export type VisionMode = "auto" | "main" | "custom" | "off";
export interface ModelConnection {
  provider: ModelProvider; base_url: string; model: string;
  thinking_mode: ThinkingMode; reasoning_effort: string; model_type: "auto" | "text" | "vision";
  thinking_protocol: "none" | "openai" | "deepseek" | "qwen" | "zai";
}
export interface ModelCapabilities {
  id: string; label: string; vision: boolean; thinking: "toggle" | "always" | "none";
  efforts: string[]; format: string; context: number; maxOutput: number; known?: boolean;
  requested_id?: string; canonical_id?: string; legacy_alias?: boolean;
}
export interface ModelProviderOption {
  id: ModelProvider; label: string; base_url: string; default_model: string; description?: string; docs?: string;
  models: Array<{ id: string; label: string }>;
}
export const MODEL_PROVIDERS: Record<ModelProvider, ModelProviderOption>;
export function modelCapabilities(provider: ModelProvider, id: string, overrides?: Partial<ModelConnection>): ModelCapabilities;
export function normalizeModelSettings(settings?: Partial<ModelConnection>): ModelConnection;
export function validateModelSettings(settings: ModelConnection): void;
export function selectedEffort(settings: ModelConnection): string | undefined;
export function workflowReasoningPolicy(settings: Partial<ModelConnection>, workflow?: "compile" | "construct"): Record<string,string> | string | undefined;
export function workflowResourcePolicy(settings: Partial<ModelConnection>): { version: string; provider: string; model: string; model_context_tokens: number; model_output_tokens: number; source_chars: number; context_chars: number; construction_chars: number; strategy_chars: number; output_tokens: Record<string,number> };
export function visionSelection(settings: Partial<ModelConnection> & { vision_mode?: VisionMode; vision_model?: string; vision_base_url?: string }): { available: boolean; source: string; model?: string; reason?: string };
