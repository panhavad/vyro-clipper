import type { AppSettings } from '../shared/settings';

export interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Minimal OpenAI-compatible chat completion (OpenAI, Groq, OpenRouter, Together, LM Studio, Ollama...). */
export async function chatJson(cfg: ChatConfig, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = (json: boolean) =>
    JSON.stringify({
      model: cfg.model,
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  let res = await fetch(url, { method: 'POST', headers, body: body(true), signal });
  if (res.status === 400 || res.status === 422) res = await fetch(url, { method: 'POST', headers, body: body(false), signal });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned an empty response');
  return content;
}

export function llmConfig(settings: AppSettings): ChatConfig | undefined {
  const l = settings.llm;
  if (!l.enabled || !l.model || !l.baseUrl) return undefined;
  return { baseUrl: l.baseUrl, apiKey: l.apiKey, model: l.model };
}
