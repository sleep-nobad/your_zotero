import { currentEmbeddingConfig, embedTexts, type AIConnectionConfig } from "./ai";
import { indexDirectory } from "./paths";
import type { PaperChunk, PaperMetadata, VectorIndex } from "./types";

interface VectorIndexMetadata {
  schemaVersion: 1;
  contentHash: string;
  modelFingerprint: string;
  dimensions: number;
  chunkCount: number;
  createdAt: string;
}

export interface VectorIndexStatus {
  chunkCount: number;
  dimensions: number;
  createdAt: string;
}

function hash(value: string): string {
  return Zotero.Utilities.Internal.md5(value);
}

export function embeddingFingerprint(config = currentEmbeddingConfig()): string {
  return hash(`${config.provider}\n${config.apiBase.replace(/\/+$/, "")}\n${config.model}`);
}

function paths(metadata: PaperMetadata): { meta: string; vectors: string } {
  const stem = `${metadata.libraryID}-${metadata.attachmentKey}`;
  const directory = indexDirectory();
  return {
    meta: PathUtils.join(directory, `${stem}.meta.json`),
    vectors: PathUtils.join(directory, `${stem}.f32`),
  };
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("Embedding 返回了零向量");
  return vector.map((value) => value / magnitude);
}

function encodeFloat32(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function decodeFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4) throw new Error("向量缓存文件长度异常");
  const values = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < values.length; index++) {
    values[index] = view.getFloat32(index * 4, true);
  }
  return values;
}

export function paperContentHash(text: string): string {
  return hash(text);
}

export async function getVectorIndexStatus(
  metadata: PaperMetadata,
  contentHash: string,
  connection = currentEmbeddingConfig(),
): Promise<VectorIndexStatus | null> {
  if (!contentHash) return null;
  const target = paths(metadata);
  if (!(await IOUtils.exists(target.meta)) || !(await IOUtils.exists(target.vectors))) return null;
  try {
    const raw = await Zotero.File.getContentsAsync(target.meta);
    const meta = JSON.parse(String(raw)) as VectorIndexMetadata;
    if (
      meta.schemaVersion !== 1 ||
      meta.contentHash !== contentHash ||
      meta.modelFingerprint !== embeddingFingerprint(connection) ||
      meta.chunkCount <= 0 ||
      meta.dimensions <= 0
    ) {
      return null;
    }
    return {
      chunkCount: meta.chunkCount,
      dimensions: meta.dimensions,
      createdAt: meta.createdAt,
    };
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

export async function loadVectorIndex(
  metadata: PaperMetadata,
  contentHash: string,
  chunkCount: number,
  connection = currentEmbeddingConfig(),
): Promise<VectorIndex | null> {
  const target = paths(metadata);
  if (!(await IOUtils.exists(target.meta)) || !(await IOUtils.exists(target.vectors))) return null;
  try {
    const raw = await Zotero.File.getContentsAsync(target.meta);
    const meta = JSON.parse(String(raw)) as VectorIndexMetadata;
    const fingerprint = embeddingFingerprint(connection);
    if (
      meta.schemaVersion !== 1 ||
      meta.contentHash !== contentHash ||
      meta.modelFingerprint !== fingerprint ||
      meta.chunkCount !== chunkCount ||
      meta.dimensions <= 0
    ) {
      return null;
    }
    const vectors = decodeFloat32(await IOUtils.read(target.vectors));
    if (vectors.length !== meta.chunkCount * meta.dimensions) return null;
    return { ...meta, vectors };
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

export async function buildVectorIndex(
  metadata: PaperMetadata,
  chunks: PaperChunk[],
  contentHash: string,
  connection: AIConnectionConfig = currentEmbeddingConfig(),
): Promise<VectorIndex> {
  const generated = await embedTexts(
    chunks.map((chunk) => chunk.text),
    connection,
  );
  const dimensions = generated[0]?.length ?? 0;
  if (!dimensions || generated.length !== chunks.length) throw new Error("全文向量索引生成不完整");
  const flattened = generated.flatMap(normalize);
  const vectors = Float32Array.from(flattened);
  const meta: VectorIndexMetadata = {
    schemaVersion: 1,
    contentHash,
    modelFingerprint: embeddingFingerprint(connection),
    dimensions,
    chunkCount: chunks.length,
    createdAt: new Date().toISOString(),
  };
  const directory = indexDirectory();
  await Zotero.File.createDirectoryIfMissingAsync(directory);
  const target = paths(metadata);
  await IOUtils.write(target.vectors, encodeFloat32(flattened), {
    tmpPath: `${target.vectors}.tmp`,
  });
  await Zotero.File.putContentsAsync(target.meta, JSON.stringify(meta, null, 2));
  return { ...meta, vectors };
}

export function cosineScores(index: VectorIndex, queryVector: number[]): number[] {
  if (queryVector.length !== index.dimensions) {
    throw new Error("问题向量维度与全文索引不一致，请重新执行“建立全文索引”");
  }
  const normalizedQuery = normalize(queryVector);
  const scores: number[] = [];
  for (let row = 0; row < index.chunkCount; row++) {
    let score = 0;
    const offset = row * index.dimensions;
    for (let column = 0; column < index.dimensions; column++) {
      score += (index.vectors[offset + column] ?? 0) * (normalizedQuery[column] ?? 0);
    }
    scores.push(score);
  }
  return scores;
}
