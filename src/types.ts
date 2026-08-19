export type ActionKind = "ask" | "background" | "translate";

export interface PaperMetadata {
  libraryID: number;
  itemID: number;
  itemKey: string;
  attachmentID: number;
  attachmentKey: string;
  title: string;
  authors: string[];
  year: string;
  publication: string;
  doi: string;
  abstract: string;
}

export interface PaperChunk {
  id: number;
  text: string;
  start: number;
  end: number;
}

export interface PaperContext {
  metadata: PaperMetadata;
  chunks: PaperChunk[];
  vectorIndex?: VectorIndex;
  contentHash: string;
  textLength: number;
  lineCount: number;
  memory: string;
  loadedAt: string;
}

export interface VectorIndex {
  schemaVersion: 1;
  contentHash: string;
  modelFingerprint: string;
  dimensions: number;
  chunkCount: number;
  vectors: Float32Array;
}

export interface ConversationEntry {
  id: string;
  action: ActionKind;
  input: string;
  output: string;
  evidenceChunkIDs: number[];
  createdAt: string;
}

export interface SavedSession {
  schemaVersion: 1;
  paper: PaperMetadata;
  paperMemory: string;
  contentHash?: string;
  textLength: number;
  lineCount?: number;
  chunkCount?: number;
  conversation: ConversationEntry[];
  promptHistory: string[];
  savedAt: string;
}

export interface AppPreferences {
  provider: "openai" | "deepseek" | "kimi" | "siliconflow" | "openrouter" | "ollama" | "custom";
  apiBase: string;
  apiKey: string;
  model: string;
  modelCatalog: string;
  aiVerifiedAt: string;
  embeddingReuseAI: boolean;
  embeddingProvider:
    "openai" | "deepseek" | "kimi" | "siliconflow" | "openrouter" | "ollama" | "custom";
  embeddingBase: string;
  embeddingKey: string;
  embeddingModel: string;
  embeddingCatalog: string;
  embeddingVerifiedAt: string;
  retrievalProvider: "crossref" | "semantic-scholar" | "openalex";
  retrievalApiKey: string;
  retrievalVerifiedAt: string;
  maxEvidenceTokens: number;
  storageDirectory: string;
  language: string;
}

export interface BackgroundSource {
  id: string;
  title: string;
  year?: number;
  authors: string[];
  abstract: string;
  url: string;
}
