import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Self-hosted Ollama provider (OpenAI-compatible endpoint).
 *
 * Set `LLM_PROVIDER=ollama` to route every model key to a local model. This is
 * meant for single-operator deployments: the hosted model catalog, pricing and
 * provider-specific request repairs are bypassed.
 */

export const OLLAMA_DEFAULT_BASE_URL = "http://ollama:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen3:8b";

const trimmed = (value: string | undefined) => value?.trim() || undefined;

export const isOllamaEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => trimmed(env.LLM_PROVIDER)?.toLowerCase() === "ollama";

export const getOllamaModelId = (
  env: Record<string, string | undefined> = process.env,
): string => trimmed(env.OLLAMA_MODEL) ?? OLLAMA_DEFAULT_MODEL;

/** Whether the configured model accepts images inside tool results. */
export const ollamaSupportsVision = (
  env: Record<string, string | undefined> = process.env,
): boolean => trimmed(env.OLLAMA_VISION)?.toLowerCase() === "true";

/** Ollama's OpenAI-compatible API lives under `/v1`. */
export const getOllamaBaseUrl = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const base = (trimmed(env.OLLAMA_BASE_URL) ?? OLLAMA_DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  return `${base}/v1`;
};

export const ollama = createOpenAICompatible({
  name: "ollama",
  baseURL: getOllamaBaseUrl(),
  // Ollama ignores the key; a reverse proxy in front of it may require one.
  apiKey: trimmed(process.env.OLLAMA_API_KEY),
  includeUsage: true,
});
