export interface ModelRecord {
  id: string;
  name?: string;
}

export function normalizeAPIBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function endpoint(base: string, path: "models" | "chat/completions" | "embeddings"): string {
  const cleaned = normalizeAPIBase(base);
  if (new RegExp(`/${path.replace("/", "\\/")}$`, "i").test(cleaned)) return cleaned;
  if (/\/chat\/completions$/i.test(cleaned)) {
    return cleaned.replace(/\/chat\/completions$/i, `/${path}`);
  }
  return `${cleaned}/${path}`;
}

export function parseModelCatalog(payload: unknown): ModelRecord[] {
  const data = payload as { data?: unknown; models?: unknown };
  const records = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : [];
  const seen = new Set<string>();
  const models: ModelRecord[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { id?: unknown; name?: unknown };
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: typeof item.name === "string" ? item.name : undefined });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export function isLikelyChatModel(model: ModelRecord): boolean {
  const value = `${model.id} ${model.name ?? ""}`.toLocaleLowerCase();
  return !/(embedding|rerank|moderation|whisper|transcri|tts|speech|audio|realtime|image|dall-e|sora|video)/i.test(
    value,
  );
}

export function isLikelyEmbeddingModel(model: ModelRecord): boolean {
  const value = `${model.id} ${model.name ?? ""}`.toLocaleLowerCase();
  return (
    /(embedding|embed|bge-|e5-|gte-|qwen3-embedding|text-embedding)/i.test(value) &&
    !/(rerank|image|audio|video)/i.test(value)
  );
}

function visibleAnswer(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

export function extractAssistantText(payload: unknown): string {
  const data = payload as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string; content?: string }>;
      };
      text?: string;
    }>;
    output_text?: string;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(data.error.message);
  const content =
    data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.output_text;
  const raw = Array.isArray(content)
    ? content.map((part) => part.text ?? part.content ?? "").join("")
    : content;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("AI 接口已响应，但没有返回文本答案");
  }
  const answer = visibleAnswer(raw);
  if (!answer) throw new Error("模型只返回了思考过程，没有生成最终答案，请重试");
  return answer;
}

export function modelCatalogFromJSON(value: string): ModelRecord[] {
  try {
    return parseModelCatalog({ data: JSON.parse(value) });
  } catch {
    return [];
  }
}

