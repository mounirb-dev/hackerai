import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Self-hosted Ollama provider (OpenAI-compatible endpoint).
 *
 * Set `LLM_PROVIDER=ollama` to route every model key to a local model. This is
 * meant for single-operator deployments: the hosted model catalog, pricing and
 * provider-specific request repairs are bypassed.
 *
 * Context window: Ollama sizes each model's context at load time from
 * `OLLAMA_CONTEXT_LENGTH` on the Ollama server itself (default: a VRAM-based
 * guess, often 4096 - too small for HackerAI's system prompt plus any real
 * conversation history, which silently drops older turns once the window
 * fills). There is no per-request field this client can set to override an
 * already-loaded model's window; the operator must set
 * `OLLAMA_CONTEXT_LENGTH` (e.g. 32768) in the environment that runs
 * `ollama serve`, before the model is first loaded, and restart Ollama after
 * changing it.
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
