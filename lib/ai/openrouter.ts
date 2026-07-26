import { env, isProductionLike } from "@/lib/config/env";
import { HttpError } from "@/lib/api/responses";

export function hasOpenRouterCredentials() {
  return Boolean(env.OPENROUTER_API_KEY);
}

export function assertOpenRouterAvailableForProduction() {
  if (isProductionLike() && !hasOpenRouterCredentials()) {
    throw new HttpError(503, "OpenRouter is not configured for production AI jobs.", "ai_provider_not_configured");
  }
}

export async function callOpenRouterJson(input: { system: string; user: string; responseSchemaName?: string }) {
  if (!env.OPENROUTER_API_KEY) throw new HttpError(503, "OpenRouter is not configured.", "ai_provider_not_configured");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "http-referer": env.NEXT_PUBLIC_APP_URL,
      "x-title": "Challenge My AI",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });
  if (!response.ok) {
    throw new HttpError(502, "OpenRouter request failed.", "ai_provider_error", { status: response.status });
  }
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new HttpError(502, "OpenRouter response did not include JSON content.", "ai_provider_error");
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "OpenRouter returned invalid JSON content.", "ai_provider_error");
  }
}
