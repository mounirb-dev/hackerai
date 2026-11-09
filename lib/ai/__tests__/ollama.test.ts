import {
  getOllamaBaseUrl,
  getOllamaModelId,
  isOllamaEnabled,
  ollamaSupportsVision,
  OLLAMA_DEFAULT_MODEL,
} from "../ollama";

describe("ollama provider config", () => {
  it("is opt-in through LLM_PROVIDER", () => {
    expect(isOllamaEnabled({})).toBe(false);
    expect(isOllamaEnabled({ LLM_PROVIDER: "openrouter" })).toBe(false);
    expect(isOllamaEnabled({ LLM_PROVIDER: " Ollama " })).toBe(true);
  });

  it("normalizes the base URL to the OpenAI-compatible /v1 path", () => {
    expect(getOllamaBaseUrl({})).toBe("http://ollama:11434/v1");
    expect(getOllamaBaseUrl({ OLLAMA_BASE_URL: "http://host:11434/" })).toBe(
      "http://host:11434/v1",
    );
    expect(getOllamaBaseUrl({ OLLAMA_BASE_URL: "http://host:11434/v1" })).toBe(
      "http://host:11434/v1",
    );
  });

  it("falls back to the default model and gates vision explicitly", () => {
    expect(getOllamaModelId({})).toBe(OLLAMA_DEFAULT_MODEL);
    expect(getOllamaModelId({ OLLAMA_MODEL: "llama3.1:8b" })).toBe(
      "llama3.1:8b",
    );
    expect(ollamaSupportsVision({})).toBe(false);
    expect(ollamaSupportsVision({ OLLAMA_VISION: "true" })).toBe(true);
  });
});
