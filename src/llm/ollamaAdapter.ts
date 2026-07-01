import type { LlmAdapter } from '../types';

/**
 * Minimal, dependency-free LLM adapter for a local Ollama server.
 * Single non-streaming round trip; forwards the optional JSON format hint.
 * Local-only: no auth/tokens.
 */
export function createOllamaAdapter(opts?: { baseUrl?: string }): LlmAdapter {
  const baseUrl = (opts?.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');

  return {
    async generate(req) {
      const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, stream: false };
      if (req.format) body.format = req.format;

      const resp = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Ollama HTTP ${resp.status}: ${text}`);
      }
      const data: any = await resp.json();
      return { text: typeof data?.response === 'string' ? data.response : '' };
    },
  };
}
