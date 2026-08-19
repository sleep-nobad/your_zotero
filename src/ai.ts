import {
  endpoint,
  extractAssistantText,
  isLikelyChatModel,
  isLikelyEmbeddingModel,
  normalizeAPIBase,
  parseModelCatalog,
  type ModelRecord,
} from "./ai-core";
import { getPreferences } from "./prefs";
import type { AppPreferences, BackgroundSource, PaperMetadata } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIConnectionConfig {
  provider: AppPreferences["provider"];
  apiBase: string;
  apiKey: string;
  model: string;
}

export type ModelPurpose = "chat" | "embedding";

interface HTTPErrorShape {
  status?: number;
  message?: string;
  responseText?: string;
  xmlhttp?: { status?: number; responseText?: string };
}

function responseError(error: unknown, operation: string): Error {
  const raw = (error ?? {}) as HTTPErrorShape;
  const status = raw.status ?? raw.xmlhttp?.status;
  const responseText = raw.responseText ?? raw.xmlhttp?.responseText ?? "";
  let detail = "";
  if (responseText) {
    try {
      const payload = JSON.parse(responseText) as {
        error?: { message?: string; type?: string } | string;
        message?: string;
      };
      detail =
        typeof payload.error === "string"
          ? payload.error
          : (payload.error?.message ?? payload.message ?? "");
    } catch {
      detail = responseText
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    }
  }
  if (!detail && raw.message) detail = raw.message;
  let message: string;
  if (status === 401 || status === 403) {
    message = `${operation}认证失败（HTTP ${status}），请检查 API Key 和接口地址`;
  } else if (status === 404) {
    message = `${operation}地址不存在（HTTP 404），请检查 API Base URL`;
  } else if (status === 429) {
    message = `${operation}请求过于频繁或账户额度不足（HTTP 429）${detail ? `：${detail}` : ""}`;
  } else if (status && status >= 500) {
    message = `${operation}服务暂时不可用（HTTP ${status}）${detail ? `：${detail}` : ""}`;
  } else if (status) {
    message = `${operation}失败（HTTP ${status}）${detail ? `：${detail}` : ""}`;
  } else if (/timed?\s*out|timeout/i.test(detail)) {
    message = `${operation}超时，请检查网络或代理设置`;
  } else {
    message = `${operation}失败${detail ? `：${detail}` : "，请检查网络连接"}`;
  }
  return Object.assign(new Error(message), { status });
}

async function requestJSON(
  method: "GET" | "POST",
  url: string,
  options: Record<string, unknown>,
  operation: string,
  retrySafe = false,
): Promise<unknown> {
  const request = Zotero.HTTP.request as unknown as (
    this: typeof Zotero.HTTP,
    method: string,
    url: string,
    options: Record<string, unknown>,
  ) => Promise<XMLHttpRequest>;
  const attempts = retrySafe ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // Zotero.HTTP.request reads exception constructors from `this`. Calling a
      // detached function makes every HTTP request fail before a response can be
      // handled ("invalid 'instanceof' operand this.UnexpectedStatusException").
      const response = await request.call(Zotero.HTTP, method, url, {
        responseType: "text",
        timeout: 120000,
        errorDelayMax: 0,
        anon: true,
        ...options,
      });
      try {
        return JSON.parse(response.responseText ?? "");
      } catch {
        throw new Error(`${operation}返回了无法解析的数据（HTTP ${response.status}）`);
      }
    } catch (error) {
      lastError = error;
      const raw = error as HTTPErrorShape;
      const status = raw.status ?? raw.xmlhttp?.status ?? 0;
      const transient = !status || status === 429 || status >= 500;
      if (attempt + 1 >= attempts || !transient) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    }
  }
  if (lastError instanceof Error && /无法解析的数据/.test(lastError.message)) throw lastError;
  throw responseError(lastError, operation);
}

function currentAIConfig(): AIConnectionConfig {
  const prefs = getPreferences();
  return {
    provider: prefs.provider,
    apiBase: prefs.apiBase,
    apiKey: prefs.apiKey,
    model: prefs.model,
  };
}

export function currentEmbeddingConfig(): AIConnectionConfig {
  const prefs = getPreferences();
  return prefs.embeddingReuseAI
    ? {
        provider: prefs.provider,
        apiBase: prefs.apiBase,
        apiKey: prefs.apiKey,
        model: prefs.embeddingModel,
      }
    : {
        provider: prefs.embeddingProvider,
        apiBase: prefs.embeddingBase,
        apiKey: prefs.embeddingKey,
        model: prefs.embeddingModel,
      };
}

function validateConfig(config: AIConnectionConfig, requireModel = true): void {
  if (!normalizeAPIBase(config.apiBase)) throw new Error("请先填写 API Base URL");
  if (!config.apiKey && config.provider !== "ollama") {
    throw new Error("请先填写 AI 服务 API Key");
  }
  if (requireModel && !config.model) throw new Error("请先获取并选择一个可用模型");
}

function authHeaders(config: AIConnectionConfig): Record<string, string> {
  if (config.provider === "ollama") return {};
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/sleep-nobad/your_zotero";
    headers["X-Title"] = "your_zotero for Zotero";
  }
  return headers;
}

export async function fetchAvailableModels(
  config: AIConnectionConfig,
  purpose: ModelPurpose = "chat",
): Promise<ModelRecord[]> {
  validateConfig(config, false);
  let url = endpoint(config.apiBase, "models");
  if (config.provider === "siliconflow") {
    url += `?type=text&sub_type=${purpose === "chat" ? "chat" : "embedding"}`;
  }
  if (config.provider === "openrouter") {
    url += `?output_modalities=${purpose === "chat" ? "text" : "embeddings"}`;
  }
  const payload = await requestJSON(
    "GET",
    url,
    { headers: authHeaders(config), timeout: 30000, logBodyLength: 0 },
    "获取模型列表",
    true,
  );
  const allModels = parseModelCatalog(payload);
  const models = allModels.filter(purpose === "chat" ? isLikelyChatModel : isLikelyEmbeddingModel);
  if (!models.length) {
    throw new Error(
      `接口连接成功，但没有返回可用于${purpose === "chat" ? "文本问答" : "文本向量化"}的模型`,
    );
  }
  return models;
}

export async function embedTexts(
  inputs: string[],
  connection = currentEmbeddingConfig(),
): Promise<number[][]> {
  validateConfig(connection);
  if (!inputs.length) return [];

  const splitRejectedInput = (value: string): [string, string] | null => {
    const input = value.trim();
    if (input.length < 160) return null;
    const midpoint = Math.floor(input.length / 2);
    const candidates = ["\n\n", "\n", ". ", "。", "; ", "；", ", ", "，", " "];
    let splitAt = midpoint;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const separator of candidates) {
      const before = input.lastIndexOf(separator, midpoint);
      const after = input.indexOf(separator, midpoint);
      for (const position of [before, after]) {
        if (position < input.length * 0.3 || position > input.length * 0.7) continue;
        const distance = Math.abs(position - midpoint);
        if (distance < bestDistance) {
          splitAt = position + separator.length;
          bestDistance = distance;
        }
      }
      if (Number.isFinite(bestDistance)) break;
    }
    const left = input.slice(0, splitAt).trim();
    const right = input.slice(splitAt).trim();
    return left.length >= 60 && right.length >= 60 ? [left, right] : null;
  };

  const mergeVectors = (vectors: number[][], weights: number[]): number[] => {
    const dimensions = vectors[0]?.length ?? 0;
    if (
      !dimensions ||
      vectors.length !== weights.length ||
      vectors.some((vector) => vector.length !== dimensions)
    ) {
      throw new Error("Embedding 子片段向量维度不一致");
    }
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    return Array.from(
      { length: dimensions },
      (_, dimension) =>
        vectors.reduce(
          (sum, vector, index) => sum + (vector[dimension] ?? 0) * (weights[index] ?? 0),
          0,
        ) / totalWeight,
    );
  };

  const requestBatch = async (batch: string[]): Promise<number[][]> => {
    try {
      const payload = (await requestJSON(
        "POST",
        endpoint(connection.apiBase, "embeddings"),
        {
          body: JSON.stringify({ model: connection.model, input: batch }),
          headers: { "Content-Type": "application/json", ...authHeaders(connection) },
          timeout: 180000,
          logBodyLength: 0,
        },
        "Embedding 生成",
      )) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
        error?: { message?: string };
      };
      if (payload.error?.message) throw new Error(payload.error.message);
      const ordered = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (ordered.length !== batch.length) {
        throw new Error(
          `Embedding 接口返回数量异常：请求 ${batch.length} 条，返回 ${ordered.length} 条`,
        );
      }
      const batchVectors: number[][] = [];
      for (const item of ordered) {
        const vector = item.embedding;
        if (
          !Array.isArray(vector) ||
          !vector.length ||
          vector.some((value) => !Number.isFinite(value))
        ) {
          throw new Error("Embedding 接口返回了无效向量");
        }
        batchVectors.push(vector);
      }
      return batchVectors;
    } catch (error) {
      // Some OpenAI-compatible providers impose a total-token limit per batch
      // and report only HTTP 400. Split automatically while preserving order.
      const status = (error as Error & { status?: number }).status;
      if (status === 400 && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        return [
          ...(await requestBatch(batch.slice(0, middle))),
          ...(await requestBatch(batch.slice(middle))),
        ];
      }
      // A provider's real tokenizer can exceed its per-input token limit even
      // when our fast estimate is below it (dense equations are a common case).
      // Preserve one vector per paper chunk by embedding smaller sub-fragments
      // and length-weighting their vectors instead of failing the whole index.
      if (status === 400 && batch.length === 1) {
        const parts = splitRejectedInput(batch[0] ?? "");
        if (parts) {
          const partVectors = await requestBatch(parts);
          return [
            mergeVectors(
              partVectors,
              parts.map((part) => part.length),
            ),
          ];
        }
      }
      throw error;
    }
  };

  const vectors: number[][] = [];
  const batchSize = 24;
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    vectors.push(...(await requestBatch(inputs.slice(offset, offset + batchSize))));
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error("Embedding 向量维度不一致");
  }
  return vectors;
}

export async function testEmbeddingConnection(config = currentEmbeddingConfig()): Promise<number> {
  const vectors = await embedTexts(["Paper Companion embedding connection check"], config);
  return vectors[0]?.length ?? 0;
}

export async function callAI(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; thinking?: "enabled" | "disabled" } = {},
  connection = currentAIConfig(),
): Promise<string> {
  validateConfig(connection);
  const reasoningModel = /(?:^o\d|reasoner|reasoning|thinking|gpt-5)/i.test(connection.model);
  const body: Record<string, unknown> = {
    model: connection.model,
    messages,
    stream: false,
  };
  if (!reasoningModel) body.temperature = options.temperature ?? 0.2;
  if (options.maxTokens) {
    const modernLimit = connection.provider === "kimi" || /(?:^o\d|gpt-5)/i.test(connection.model);
    body[modernLimit ? "max_completion_tokens" : "max_tokens"] = options.maxTokens;
  }
  if (connection.provider === "kimi" && /^kimi-k2\.[56]/i.test(connection.model)) {
    body.thinking = { type: "disabled" };
  }
  if (connection.provider === "deepseek") {
    // DeepSeek V4 defaults to thinking mode, which can consume the entire
    // completion budget before producing visible content. Keep the plugin's
    // default predictable and token-efficient; callers may explicitly enable it.
    body.thinking = { type: options.thinking ?? "disabled" };
  }
  const payload = await requestJSON(
    "POST",
    endpoint(connection.apiBase, "chat/completions"),
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...authHeaders(connection) },
      timeout: 180000,
      logBodyLength: 0,
    },
    "AI 回答",
  );
  return extractAssistantText(payload);
}

export async function testAIConnection(config = currentAIConfig()): Promise<string> {
  const output = await callAI(
    [
      { role: "system", content: "Return only the two uppercase letters OK." },
      { role: "user", content: "Connection check" },
    ],
    { temperature: 0, maxTokens: 64, thinking: "disabled" },
    config,
  );
  if (!output) throw new Error("模型连接成功，但没有返回内容");
  return output;
}

function normalizeAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  return words
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
    .join(" ");
}

async function searchSemanticScholar(query: string, apiKey: string): Promise<BackgroundSource[]> {
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search?limit=6&fields=" +
    encodeURIComponent("title,abstract,year,authors,url,externalIds") +
    "&query=" +
    encodeURIComponent(query);
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  const payload = (await requestJSON(
    "GET",
    url,
    { headers, timeout: 30000 },
    "Semantic Scholar 检索",
    true,
  )) as {
    data?: Array<{
      paperId: string;
      title?: string;
      abstract?: string;
      year?: number;
      authors?: Array<{ name?: string }>;
      url?: string;
      externalIds?: { DOI?: string };
    }>;
  };
  return (payload.data ?? []).map((paper, index) => ({
    id: `B${index + 1}`,
    title: paper.title ?? "Untitled",
    year: paper.year,
    authors: (paper.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: paper.abstract ?? "",
    url: paper.url ?? (paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : ""),
  }));
}

async function searchOpenAlex(query: string, apiKey: string): Promise<BackgroundSource[]> {
  const url =
    "https://api.openalex.org/works?per_page=6&select=id,title,display_name,publication_year,authorships,abstract_inverted_index,doi,primary_location&search=" +
    encodeURIComponent(query) +
    "&api_key=" +
    encodeURIComponent(apiKey.trim());
  const payload = (await requestJSON("GET", url, { timeout: 30000 }, "OpenAlex 检索", true)) as {
    results?: Array<{
      id: string;
      title?: string;
      display_name?: string;
      publication_year?: number;
      authorships?: Array<{ author?: { display_name?: string } }>;
      abstract_inverted_index?: Record<string, number[]> | null;
      doi?: string;
      primary_location?: { landing_page_url?: string };
    }>;
  };
  return (payload.results ?? []).map((paper, index) => ({
    id: `B${index + 1}`,
    title: paper.display_name ?? paper.title ?? "Untitled",
    year: paper.publication_year,
    authors: (paper.authorships ?? [])
      .map((authorship) => authorship.author?.display_name ?? "")
      .filter(Boolean),
    abstract: normalizeAbstract(paper.abstract_inverted_index),
    url: paper.doi ?? paper.primary_location?.landing_page_url ?? paper.id,
  }));
}

async function searchCrossref(query: string): Promise<BackgroundSource[]> {
  const url =
    "https://api.crossref.org/works?rows=6&select=DOI,title,author,published,URL,abstract&query.bibliographic=" +
    encodeURIComponent(query);
  const payload = (await requestJSON("GET", url, { timeout: 30000 }, "Crossref 检索", true)) as {
    message?: {
      items?: Array<{
        DOI?: string;
        title?: string[];
        author?: Array<{ given?: string; family?: string; name?: string }>;
        published?: { "date-parts"?: number[][] };
        URL?: string;
        abstract?: string;
      }>;
    };
  };
  return (payload.message?.items ?? []).map((paper, index) => ({
    id: `B${index + 1}`,
    title: paper.title?.[0] ?? "Untitled",
    year: paper.published?.["date-parts"]?.[0]?.[0],
    authors: (paper.author ?? [])
      .map((author) => author.name ?? [author.given, author.family].filter(Boolean).join(" "))
      .filter(Boolean),
    abstract: (paper.abstract ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    url: paper.URL ?? (paper.DOI ? `https://doi.org/${paper.DOI}` : ""),
  }));
}

export async function searchBackground(
  paper: PaperMetadata,
  userFocus: string,
): Promise<BackgroundSource[]> {
  const prefs = getPreferences();
  const query = [userFocus.trim(), paper.title].filter(Boolean).join(" ").slice(0, 480);
  if (prefs.retrievalProvider === "crossref") return searchCrossref(query);
  if (prefs.retrievalProvider === "openalex") {
    if (!prefs.retrievalApiKey) throw new Error("请先在插件设置中填写 OpenAlex API Key");
    return searchOpenAlex(query, prefs.retrievalApiKey);
  }
  return searchSemanticScholar(query, prefs.retrievalApiKey);
}

export async function testRetrievalConnection(
  provider: AppPreferences["retrievalProvider"],
  apiKey: string,
): Promise<number> {
  if (provider !== "crossref" && !apiKey.trim()) {
    throw new Error(
      `请先填写 ${provider === "openalex" ? "OpenAlex" : "Semantic Scholar"} API Key`,
    );
  }
  const results =
    provider === "crossref"
      ? await searchCrossref("machine learning")
      : provider === "openalex"
        ? await searchOpenAlex("machine learning", apiKey)
        : await searchSemanticScholar("machine learning", apiKey.trim());
  if (!results.length) throw new Error("检索服务已响应，但没有返回测试结果");
  return results.length;
}

