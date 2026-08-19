import { modelCatalogFromJSON, type ModelRecord } from "./ai-core";
import type { AppPreferences } from "./types";

const PREFIX = "your_zotero.";
const LEGACY_PREFIX = "papercompanion.";
const preferenceKeys: Array<keyof AppPreferences> = [
  "provider",
  "apiBase",
  "apiKey",
  "model",
  "modelCatalog",
  "aiVerifiedAt",
  "embeddingReuseAI",
  "embeddingProvider",
  "embeddingBase",
  "embeddingKey",
  "embeddingModel",
  "embeddingCatalog",
  "embeddingVerifiedAt",
  "retrievalProvider",
  "retrievalApiKey",
  "retrievalVerifiedAt",
  "maxEvidenceTokens",
  "storageDirectory",
  "language",
];

let migratedLegacyPreferences = false;

function migrateLegacyPreferences(): void {
  if (migratedLegacyPreferences) return;
  migratedLegacyPreferences = true;
  for (const key of preferenceKeys) {
    const nextKey = PREFIX + key;
    const legacyKey = LEGACY_PREFIX + key;
    const current = Zotero.Prefs.get(nextKey);
    const legacy = Zotero.Prefs.get(legacyKey);
    if (
      (current === undefined || current === null || current === "") &&
      legacy !== undefined &&
      typeof Zotero.Prefs.set === "function"
    ) {
      Zotero.Prefs.set(nextKey, legacy);
    }
  }
}

const defaults: AppPreferences = {
  provider: "openai",
  apiBase: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  modelCatalog: "[]",
  aiVerifiedAt: "",
  embeddingReuseAI: true,
  embeddingProvider: "openai",
  embeddingBase: "https://api.openai.com/v1",
  embeddingKey: "",
  embeddingModel: "",
  embeddingCatalog: "[]",
  embeddingVerifiedAt: "",
  retrievalProvider: "crossref",
  retrievalApiKey: "",
  retrievalVerifiedAt: "",
  maxEvidenceTokens: 6000,
  storageDirectory: "",
  language: "zh-CN",
};

interface ProviderPreset {
  baseURL: string;
  keyURL: string;
  docsURL: string;
}

const providerPresets: Record<Exclude<AppPreferences["provider"], "custom">, ProviderPreset> = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyURL: "https://platform.openai.com/api-keys",
    docsURL: "https://platform.openai.com/docs/api-reference",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    keyURL: "https://platform.deepseek.com/api_keys",
    docsURL: "https://api-docs.deepseek.com/",
  },
  kimi: {
    baseURL: "https://api.moonshot.cn/v1",
    keyURL: "https://platform.kimi.com/console/api-keys",
    docsURL: "https://platform.kimi.com/docs/api/overview",
  },
  siliconflow: {
    baseURL: "https://api.siliconflow.cn/v1",
    keyURL: "https://cloud.siliconflow.cn/account/ak",
    docsURL: "https://docs.siliconflow.cn/cn/api-reference/models/get-model-list",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyURL: "https://openrouter.ai/settings/keys",
    docsURL: "https://openrouter.ai/docs/quickstart",
  },
  ollama: {
    baseURL: "http://127.0.0.1:11434/v1",
    keyURL: "",
    docsURL: "https://docs.ollama.com/api/openai-compatibility",
  },
};

export function getPreference<K extends keyof AppPreferences>(key: K): AppPreferences[K] {
  migrateLegacyPreferences();
  const value = Zotero.Prefs.get(PREFIX + key);
  const legacyValue =
    value === undefined || value === null || value === ""
      ? Zotero.Prefs.get(LEGACY_PREFIX + key)
      : undefined;
  const effectiveValue =
    value === undefined || value === null || value === "" ? legacyValue : value;
  if (effectiveValue === undefined || effectiveValue === null || effectiveValue === "") {
    if (
      key === "apiKey" ||
      key === "retrievalApiKey" ||
      key === "model" ||
      key === "aiVerifiedAt" ||
      key === "embeddingKey" ||
      key === "embeddingModel" ||
      key === "embeddingVerifiedAt" ||
      key === "storageDirectory" ||
      key === "retrievalVerifiedAt"
    ) {
      return "" as AppPreferences[K];
    }
    return defaults[key];
  }
  return effectiveValue as AppPreferences[K];
}

export function setPreference<K extends keyof AppPreferences>(
  key: K,
  value: AppPreferences[K],
): void {
  Zotero.Prefs.set(PREFIX + key, value);
}

export function getPreferences(): AppPreferences {
  return {
    provider: getPreference("provider") as AppPreferences["provider"],
    apiBase: String(getPreference("apiBase")).trim(),
    apiKey: String(getPreference("apiKey")).trim(),
    model: String(getPreference("model")).trim(),
    modelCatalog: String(getPreference("modelCatalog")),
    aiVerifiedAt: String(getPreference("aiVerifiedAt")),
    embeddingReuseAI: Boolean(getPreference("embeddingReuseAI")),
    embeddingProvider: getPreference("embeddingProvider") as AppPreferences["embeddingProvider"],
    embeddingBase: String(getPreference("embeddingBase")).trim(),
    embeddingKey: String(getPreference("embeddingKey")).trim(),
    embeddingModel: String(getPreference("embeddingModel")).trim(),
    embeddingCatalog: String(getPreference("embeddingCatalog")),
    embeddingVerifiedAt: String(getPreference("embeddingVerifiedAt")),
    retrievalProvider: getPreference("retrievalProvider") as AppPreferences["retrievalProvider"],
    retrievalApiKey: String(getPreference("retrievalApiKey")).trim(),
    retrievalVerifiedAt: String(getPreference("retrievalVerifiedAt")),
    maxEvidenceTokens: Number(getPreference("maxEvidenceTokens")) || defaults.maxEvidenceTokens,
    storageDirectory: String(getPreference("storageDirectory")).trim(),
    language: String(getPreference("language")),
  };
}

export function registerPreferencePane(): void {
  Zotero.PreferencePanes.register({
    pluginID: "your_zotero@zotero.local",
    src: rootURI + "content/preferences.xhtml",
    label: "your_zotero",
    image: "chrome://your_zotero/content/icons/paper-companion.svg",
  });
}

type PrefField = HTMLInputElement | HTMLSelectElement;

function button(doc: Document, id: string): HTMLButtonElement | null {
  return doc.getElementById(id) as HTMLButtonElement | null;
}

function setResult(element: HTMLElement | null, message: string, state = ""): void {
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

export function bindPreferencePane(win: Window): void {
  const doc = win.document;
  const prefs = getPreferences();
  const providerSelect = doc.getElementById("papercompanion-provider") as HTMLSelectElement | null;
  const apiBaseInput = doc.getElementById("papercompanion-api-base") as HTMLInputElement | null;
  const apiKeyInput = doc.getElementById("papercompanion-api-key") as HTMLInputElement | null;
  const modelSelect = doc.getElementById("papercompanion-model") as HTMLSelectElement | null;
  const aiResult = doc.getElementById("papercompanion-ai-result") as HTMLElement | null;
  const embeddingReuse = doc.getElementById(
    "papercompanion-embedding-reuse",
  ) as HTMLInputElement | null;
  const embeddingCustomFields = doc.getElementById(
    "papercompanion-embedding-custom-fields",
  ) as HTMLElement | null;
  const embeddingProviderSelect = doc.getElementById(
    "papercompanion-embedding-provider",
  ) as HTMLSelectElement | null;
  const embeddingBaseInput = doc.getElementById(
    "papercompanion-embedding-base",
  ) as HTMLInputElement | null;
  const embeddingKeyInput = doc.getElementById(
    "papercompanion-embedding-key",
  ) as HTMLInputElement | null;
  const embeddingModelSelect = doc.getElementById(
    "papercompanion-embedding-model",
  ) as HTMLSelectElement | null;
  const embeddingResult = doc.getElementById(
    "papercompanion-embedding-result",
  ) as HTMLElement | null;
  const embeddingKeyRow = doc.getElementById(
    "papercompanion-embedding-key-row",
  ) as HTMLElement | null;
  const embeddingAdvanced = doc.getElementById(
    "papercompanion-embedding-advanced",
  ) as HTMLElement | null;
  const retrievalSelect = doc.getElementById(
    "papercompanion-retrieval-provider",
  ) as HTMLSelectElement | null;
  const retrievalKeyInput = doc.getElementById(
    "papercompanion-retrieval-key",
  ) as HTMLInputElement | null;
  const retrievalResult = doc.getElementById(
    "papercompanion-retrieval-result",
  ) as HTMLElement | null;
  const fields: Array<[keyof AppPreferences, string]> = [
    ["provider", "papercompanion-provider"],
    ["apiBase", "papercompanion-api-base"],
    ["apiKey", "papercompanion-api-key"],
    ["embeddingProvider", "papercompanion-embedding-provider"],
    ["embeddingBase", "papercompanion-embedding-base"],
    ["embeddingKey", "papercompanion-embedding-key"],
    ["retrievalProvider", "papercompanion-retrieval-provider"],
    ["retrievalApiKey", "papercompanion-retrieval-key"],
    ["maxEvidenceTokens", "papercompanion-max-evidence"],
  ];

  for (const [key, id] of fields) {
    const element = doc.getElementById(id) as PrefField | null;
    if (!element) continue;
    element.value = String(prefs[key]);
    element.addEventListener("change", () => {
      if (key === "maxEvidenceTokens") {
        const value = Math.max(2000, Math.min(16000, Number(element.value) || 6000));
        setPreference(key, value);
        element.value = String(value);
      } else {
        setPreference(key, element.value as never);
      }
    });
  }

  const populateModels = (
    target: HTMLSelectElement | null,
    models: ModelRecord[],
    selected: string,
    purpose: "问答" | "Embedding",
  ): string => {
    if (!target) return "";
    const options: HTMLOptionElement[] = [];
    const placeholder = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option",
    ) as HTMLOptionElement;
    placeholder.value = "";
    placeholder.textContent = models.length ? `请选择${purpose}模型` : "请先点击“获取模型”";
    options.push(placeholder);
    for (const model of models) {
      const option = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      option.value = model.id;
      option.textContent =
        model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
      options.push(option);
    }
    if (selected && !models.some((model) => model.id === selected)) {
      const legacy = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      legacy.value = selected;
      legacy.textContent = `${selected}（尚未验证）`;
      options.push(legacy);
    }
    target.replaceChildren(...options);
    target.value = selected;
    return target.value;
  };

  const invalidateEmbedding = (message: string, clearCatalog = true) => {
    setPreference("embeddingVerifiedAt", "");
    if (clearCatalog) {
      setPreference("embeddingModel", "");
      setPreference("embeddingCatalog", "[]");
      populateModels(embeddingModelSelect, [], "", "Embedding");
    }
    setResult(embeddingResult, message, "warning");
  };

  populateModels(modelSelect, modelCatalogFromJSON(prefs.modelCatalog), prefs.model, "问答");
  modelSelect?.addEventListener("change", () => {
    setPreference("model", modelSelect.value);
    setPreference("aiVerifiedAt", "");
    setResult(aiResult, "模型已更改，请重新验证", "warning");
  });

  const openExternal = (url: string) => {
    if (url) Zotero.launchURL(url);
  };
  const keyButton = button(doc, "papercompanion-open-key-page");
  const docsButton = button(doc, "papercompanion-open-docs");
  const updateProviderUI = (applyPreset: boolean) => {
    const provider = providerSelect?.value as AppPreferences["provider"] | undefined;
    const preset = provider && provider !== "custom" ? providerPresets[provider] : null;
    keyButton?.toggleAttribute("hidden", !preset);
    docsButton?.toggleAttribute("hidden", !preset);
    if (keyButton) keyButton.dataset.url = preset?.keyURL ?? "";
    if (docsButton) docsButton.dataset.url = preset?.docsURL ?? "";
    if (applyPreset && apiBaseInput) {
      apiBaseInput.value = preset?.baseURL ?? "";
      if (apiKeyInput) apiKeyInput.value = "";
      setPreference("apiBase", apiBaseInput.value);
      setPreference("apiKey", "");
      setPreference("model", "");
      setPreference("modelCatalog", "[]");
      setPreference("aiVerifiedAt", "");
      populateModels(modelSelect, [], "", "问答");
      setResult(aiResult, "服务商已更改，请获取模型并验证连接", "warning");
      if (embeddingReuse?.checked) invalidateEmbedding("问答服务已更改，请重新获取 Embedding 模型");
    }
  };
  providerSelect?.addEventListener("change", () => updateProviderUI(true));
  apiBaseInput?.addEventListener("change", () => {
    setPreference("modelCatalog", "[]");
    setPreference("aiVerifiedAt", "");
    populateModels(modelSelect, [], "", "问答");
    setResult(aiResult, "接口地址已更改，请重新获取模型", "warning");
    if (embeddingReuse?.checked)
      invalidateEmbedding("复用的接口地址已更改，请重新获取 Embedding 模型");
  });
  apiKeyInput?.addEventListener("change", () => {
    setPreference("modelCatalog", "[]");
    setPreference("aiVerifiedAt", "");
    populateModels(modelSelect, [], "", "问答");
    setResult(aiResult, "Key 已更改，请重新获取模型", "warning");
    if (embeddingReuse?.checked)
      invalidateEmbedding("复用的 Key 已更改，请重新获取 Embedding 模型");
  });
  updateProviderUI(false);
  keyButton?.addEventListener("click", () => openExternal(keyButton.dataset.url ?? ""));
  docsButton?.addEventListener("click", () => openExternal(docsButton.dataset.url ?? ""));

  const showKeyButton = button(doc, "papercompanion-show-api-key");
  showKeyButton?.addEventListener("click", () => {
    if (!apiKeyInput || !showKeyButton) return;
    const reveal = apiKeyInput.type === "password";
    apiKeyInput.type = reveal ? "text" : "password";
    showKeyButton.textContent = reveal ? "隐藏" : "显示";
  });

  const fetchButton = button(doc, "papercompanion-fetch-models");
  fetchButton?.addEventListener("click", async () => {
    if (!providerSelect || !apiBaseInput || !apiKeyInput || !fetchButton) return;
    setResult(aiResult, "正在连接账户并获取模型…", "loading");
    fetchButton.disabled = true;
    try {
      setPreference("provider", providerSelect.value as AppPreferences["provider"]);
      setPreference("apiBase", apiBaseInput.value.trim());
      setPreference("apiKey", apiKeyInput.value.trim());
      const { fetchAvailableModels } = await import("./ai");
      const models = await fetchAvailableModels({
        provider: providerSelect.value as AppPreferences["provider"],
        apiBase: apiBaseInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        model: "",
      });
      const previous = String(getPreference("model"));
      const selected = models.some((model) => model.id === previous)
        ? previous
        : (models[0]?.id ?? "");
      populateModels(modelSelect, models, selected, "问答");
      setPreference("modelCatalog", JSON.stringify(models));
      setPreference("model", selected);
      setPreference("aiVerifiedAt", "");
      setResult(
        aiResult,
        `已从账户获取 ${models.length} 个文本模型，请确认模型后验证连接`,
        "success",
      );
    } catch (error) {
      setResult(aiResult, error instanceof Error ? error.message : String(error), "error");
    } finally {
      fetchButton.disabled = false;
    }
  });

  const testButton = button(doc, "papercompanion-test-api");
  testButton?.addEventListener("click", async () => {
    if (!providerSelect || !apiBaseInput || !apiKeyInput || !modelSelect || !testButton) return;
    setResult(aiResult, "正在向所选模型发送真实测试请求…", "loading");
    testButton.disabled = true;
    try {
      setPreference("provider", providerSelect.value as AppPreferences["provider"]);
      setPreference("apiBase", apiBaseInput.value.trim());
      setPreference("apiKey", apiKeyInput.value.trim());
      setPreference("model", modelSelect.value);
      const { testAIConnection } = await import("./ai");
      await testAIConnection({
        provider: providerSelect.value as AppPreferences["provider"],
        apiBase: apiBaseInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        model: modelSelect.value,
      });
      const verifiedAt = new Date().toISOString();
      setPreference("model", modelSelect.value);
      setPreference("aiVerifiedAt", verifiedAt);
      setResult(aiResult, `连接成功 · ${modelSelect.value}`, "success");
    } catch (error) {
      setPreference("aiVerifiedAt", "");
      setResult(aiResult, error instanceof Error ? error.message : String(error), "error");
    } finally {
      testButton.disabled = false;
    }
  });

  if (embeddingReuse) embeddingReuse.checked = prefs.embeddingReuseAI;
  populateModels(
    embeddingModelSelect,
    modelCatalogFromJSON(prefs.embeddingCatalog),
    prefs.embeddingModel,
    "Embedding",
  );
  const embeddingKeyButton = button(doc, "papercompanion-open-embedding-key-page");
  const embeddingDocsButton = button(doc, "papercompanion-open-embedding-docs");
  const showEmbeddingKeyButton = button(doc, "papercompanion-show-embedding-key");
  const fetchEmbeddingButton = button(doc, "papercompanion-fetch-embedding-models");
  const effectiveEmbeddingConfig = () => {
    const reuse = embeddingReuse?.checked ?? true;
    return {
      provider: (reuse ? providerSelect?.value : embeddingProviderSelect?.value) as
        AppPreferences["provider"] | undefined,
      apiBase: (reuse ? apiBaseInput?.value : embeddingBaseInput?.value)?.trim() ?? "",
      apiKey: (reuse ? apiKeyInput?.value : embeddingKeyInput?.value)?.trim() ?? "",
      model: embeddingModelSelect?.value ?? "",
    };
  };
  const updateEmbeddingProviderUI = (applyPreset: boolean) => {
    const provider = embeddingProviderSelect?.value as AppPreferences["provider"] | undefined;
    const preset = provider && provider !== "custom" ? providerPresets[provider] : null;
    const isOllama = provider === "ollama";
    embeddingKeyRow?.toggleAttribute("hidden", isOllama);
    embeddingAdvanced?.toggleAttribute("hidden", isOllama);
    showEmbeddingKeyButton?.toggleAttribute("hidden", isOllama);
    embeddingKeyButton?.toggleAttribute("hidden", isOllama || !preset?.keyURL);
    embeddingDocsButton?.toggleAttribute("hidden", !preset);
    if (fetchEmbeddingButton) {
      fetchEmbeddingButton.textContent = isOllama ? "检测本地模型" : "获取模型";
    }
    if (embeddingKeyButton) embeddingKeyButton.dataset.url = preset?.keyURL ?? "";
    if (embeddingDocsButton) embeddingDocsButton.dataset.url = preset?.docsURL ?? "";
    if (applyPreset && embeddingBaseInput) {
      embeddingBaseInput.value = preset?.baseURL ?? "";
      if (embeddingKeyInput) embeddingKeyInput.value = "";
      setPreference("embeddingBase", embeddingBaseInput.value);
      setPreference("embeddingKey", "");
      invalidateEmbedding(
        isOllama
          ? "正在等待检测本机 Ollama 和 Embedding 模型"
          : "Embedding 服务商已更改，请重新获取模型",
      );
    }
  };
  const updateEmbeddingReuseUI = (changed: boolean) => {
    const reuse = embeddingReuse?.checked ?? true;
    embeddingCustomFields?.toggleAttribute("hidden", reuse);
    setPreference("embeddingReuseAI", reuse);
    if (changed) {
      invalidateEmbedding(
        reuse ? "已改为复用问答服务，请获取 Embedding 模型" : "请配置独立 Embedding 服务",
      );
    }
  };
  embeddingReuse?.addEventListener("change", () => updateEmbeddingReuseUI(true));
  embeddingProviderSelect?.addEventListener("change", () => {
    updateEmbeddingProviderUI(true);
    if (embeddingProviderSelect.value === "ollama") fetchEmbeddingButton?.click();
  });
  embeddingBaseInput?.addEventListener("change", () =>
    invalidateEmbedding("Embedding 接口地址已更改，请重新获取模型"),
  );
  embeddingKeyInput?.addEventListener("change", () =>
    invalidateEmbedding("Embedding Key 已更改，请重新获取模型"),
  );
  embeddingModelSelect?.addEventListener("change", () => {
    setPreference("embeddingModel", embeddingModelSelect.value);
    setPreference("embeddingVerifiedAt", "");
    setResult(embeddingResult, "Embedding 模型已更改，请重新验证", "warning");
  });
  updateEmbeddingProviderUI(false);
  updateEmbeddingReuseUI(false);
  embeddingKeyButton?.addEventListener("click", () =>
    openExternal(embeddingKeyButton.dataset.url ?? ""),
  );
  embeddingDocsButton?.addEventListener("click", () =>
    openExternal(embeddingDocsButton.dataset.url ?? ""),
  );
  showEmbeddingKeyButton?.addEventListener("click", () => {
    if (!embeddingKeyInput || !showEmbeddingKeyButton) return;
    const reveal = embeddingKeyInput.type === "password";
    embeddingKeyInput.type = reveal ? "text" : "password";
    showEmbeddingKeyButton.textContent = reveal ? "隐藏" : "显示";
  });

  fetchEmbeddingButton?.addEventListener("click", async () => {
    if (!embeddingModelSelect || !fetchEmbeddingButton) return;
    const isOllama = embeddingProviderSelect?.value === "ollama";
    setResult(
      embeddingResult,
      isOllama ? "正在检测本机 Ollama 服务和已安装模型…" : "正在获取账户可用的 Embedding 模型…",
      "loading",
    );
    fetchEmbeddingButton.disabled = true;
    try {
      const config = effectiveEmbeddingConfig();
      if (!config.provider) throw new Error("请选择 Embedding 服务商");
      if (!embeddingReuse?.checked) {
        setPreference("embeddingProvider", config.provider);
        setPreference("embeddingBase", config.apiBase);
        setPreference("embeddingKey", config.apiKey);
      }
      const { fetchAvailableModels } = await import("./ai");
      const models = await fetchAvailableModels(
        { ...config, provider: config.provider, model: "" },
        "embedding",
      );
      const previous = String(getPreference("embeddingModel"));
      const localRecommended = models.find((model) => model.id === "qwen3-embedding:4b")?.id;
      const selected = models.some((model) => model.id === previous)
        ? previous
        : (localRecommended ?? models[0]?.id ?? "");
      populateModels(embeddingModelSelect, models, selected, "Embedding");
      setPreference("embeddingCatalog", JSON.stringify(models));
      setPreference("embeddingModel", selected);
      setPreference("embeddingVerifiedAt", "");
      setResult(
        embeddingResult,
        isOllama
          ? `已检测到 Ollama · ${models.length} 个本地 Embedding 模型，请确认后验证`
          : `已获取 ${models.length} 个 Embedding 模型，请确认后验证`,
        "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult(
        embeddingResult,
        isOllama
          ? `未检测到可用的本地 Embedding 模型：${message}。请确认 Ollama 已启动并先安装 Embedding 模型。`
          : message,
        "error",
      );
    } finally {
      fetchEmbeddingButton.disabled = false;
    }
  });

  const testEmbeddingButton = button(doc, "papercompanion-test-embedding");
  testEmbeddingButton?.addEventListener("click", async () => {
    if (!embeddingModelSelect || !testEmbeddingButton) return;
    setResult(embeddingResult, "正在生成真实测试向量…", "loading");
    testEmbeddingButton.disabled = true;
    try {
      const config = effectiveEmbeddingConfig();
      if (!config.provider) throw new Error("请选择 Embedding 服务商");
      if (!embeddingReuse?.checked) {
        setPreference("embeddingProvider", config.provider);
        setPreference("embeddingBase", config.apiBase);
        setPreference("embeddingKey", config.apiKey);
      }
      setPreference("embeddingModel", embeddingModelSelect.value);
      const { testEmbeddingConnection } = await import("./ai");
      const dimensions = await testEmbeddingConnection({
        ...config,
        provider: config.provider,
        model: embeddingModelSelect.value,
      });
      setPreference("embeddingVerifiedAt", new Date().toISOString());
      setResult(
        embeddingResult,
        `连接成功 · ${embeddingModelSelect.value} · ${dimensions} 维`,
        "success",
      );
    } catch (error) {
      setPreference("embeddingVerifiedAt", "");
      setResult(embeddingResult, error instanceof Error ? error.message : String(error), "error");
    } finally {
      testEmbeddingButton.disabled = false;
    }
  });

  const storageInput = doc.getElementById(
    "papercompanion-storage-directory",
  ) as HTMLInputElement | null;
  const storageResult = doc.getElementById("papercompanion-storage-result") as HTMLElement | null;
  if (storageInput) {
    storageInput.value = prefs.storageDirectory;
    storageInput.placeholder = PathUtils.join(Zotero.getProfileDirectory().path, "paper-companion");
  }
  button(doc, "papercompanion-choose-storage")?.addEventListener("click", async () => {
    setResult(storageResult, "正在检查目录写入权限…", "loading");
    try {
      const { chooseStorageDirectory } = await import("./paths");
      const selected = await chooseStorageDirectory(win);
      if (!selected) {
        setResult(storageResult, "已取消选择", "");
        return;
      }
      setPreference("storageDirectory", selected);
      if (storageInput) storageInput.value = selected;
      setResult(storageResult, "目录可写；新索引和暂存笔记将保存到这里", "success");
    } catch (error) {
      setResult(storageResult, error instanceof Error ? error.message : String(error), "error");
    }
  });
  button(doc, "papercompanion-reset-storage")?.addEventListener("click", () => {
    setPreference("storageDirectory", "");
    if (storageInput) storageInput.value = "";
    setResult(storageResult, "已恢复 Zotero 配置目录；原目录中的文件不会被删除", "success");
  });

  const retrievalKeyRow = doc.getElementById(
    "papercompanion-retrieval-key-row",
  ) as HTMLElement | null;
  const retrievalLink = button(doc, "papercompanion-open-retrieval-page");
  const updateRetrievalUI = () => {
    const provider = retrievalSelect?.value;
    const noKey = provider === "crossref";
    retrievalKeyRow?.toggleAttribute("hidden", noKey);
    if (retrievalLink) {
      if (provider === "openalex") {
        retrievalLink.textContent = "申请 OpenAlex Key";
        retrievalLink.dataset.url = "https://openalex.org/settings/api";
      } else if (provider === "semantic-scholar") {
        retrievalLink.textContent = "申请 Semantic Scholar Key";
        retrievalLink.dataset.url = "https://www.semanticscholar.org/product/api";
      } else {
        retrievalLink.textContent = "查看 Crossref 说明";
        retrievalLink.dataset.url =
          "https://www.crossref.org/documentation/retrieve-metadata/rest-api/";
      }
    }
  };
  retrievalSelect?.addEventListener("change", () => {
    if (retrievalKeyInput) retrievalKeyInput.value = "";
    setPreference("retrievalApiKey", "");
    setPreference("retrievalVerifiedAt", "");
    setResult(retrievalResult, "检索服务已更改，请重新验证", "warning");
    updateRetrievalUI();
  });
  retrievalKeyInput?.addEventListener("change", () => {
    setPreference("retrievalVerifiedAt", "");
    setResult(retrievalResult, "检索 Key 已更改，请重新验证", "warning");
  });
  retrievalLink?.addEventListener("click", () => openExternal(retrievalLink.dataset.url ?? ""));
  updateRetrievalUI();

  const retrievalTestButton = button(doc, "papercompanion-test-retrieval");
  retrievalTestButton?.addEventListener("click", async () => {
    if (!retrievalSelect || !retrievalKeyInput || !retrievalTestButton) return;
    setResult(retrievalResult, "正在执行真实文献检索…", "loading");
    retrievalTestButton.disabled = true;
    try {
      setPreference(
        "retrievalProvider",
        retrievalSelect.value as AppPreferences["retrievalProvider"],
      );
      setPreference("retrievalApiKey", retrievalKeyInput.value.trim());
      const { testRetrievalConnection } = await import("./ai");
      const count = await testRetrievalConnection(
        retrievalSelect.value as AppPreferences["retrievalProvider"],
        retrievalKeyInput.value,
      );
      setPreference("retrievalVerifiedAt", new Date().toISOString());
      setResult(retrievalResult, `连接成功，测试检索返回 ${count} 条结果`, "success");
    } catch (error) {
      setPreference("retrievalVerifiedAt", "");
      setResult(retrievalResult, error instanceof Error ? error.message : String(error), "error");
    } finally {
      retrievalTestButton.disabled = false;
    }
  });

  if (prefs.aiVerifiedAt) setResult(aiResult, `上次验证成功 · ${prefs.model}`, "success");
  if (prefs.embeddingVerifiedAt) {
    setResult(embeddingResult, `上次验证成功 · ${prefs.embeddingModel}`, "success");
  }
  if (prefs.retrievalVerifiedAt) setResult(retrievalResult, "检索服务上次验证成功", "success");
}

