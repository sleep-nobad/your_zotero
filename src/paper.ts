import { callAI, currentEmbeddingConfig, embedTexts } from "./ai";
import { getPreferences } from "./prefs";
import {
  buildVectorIndex,
  cosineScores,
  embeddingFingerprint,
  loadVectorIndex,
  paperContentHash,
} from "./vector-index";
import type { PaperChunk, PaperContext, PaperMetadata } from "./types";

type ProgressCallback = (message: string) => void;

function field(item: Zotero.Item, name: string): string {
  const value = item.getField(name as never);
  return value === null || value === undefined ? "" : String(value);
}

function buildMetadata(item: Zotero.Item, attachment: Zotero.Item): PaperMetadata {
  const creators = item.getCreators();
  const authors = creators
    .map((rawCreator) => {
      const creator = rawCreator as typeof rawCreator & { name?: string };
      if (creator.name) return creator.name;
      return [creator.firstName, creator.lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  const date = field(item, "date");
  return {
    libraryID: item.libraryID,
    itemID: item.id,
    itemKey: item.key,
    attachmentID: attachment.id,
    attachmentKey: attachment.key,
    title: field(item, "title") || field(attachment, "title") || "未命名文献",
    authors,
    year: date.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? date,
    publication:
      field(item, "publicationTitle") || field(item, "bookTitle") || field(item, "publisher"),
    doi: field(item, "DOI"),
    abstract: field(item, "abstractNote"),
  };
}

export function resolveCurrentPaper(win: Window): {
  item: Zotero.Item;
  attachment: Zotero.Item;
  metadata: PaperMetadata;
} {
  const selected = win.ZoteroPane?.getSelectedItems() ?? [];
  const activeReaderID =
    win.Zotero_Tabs?.selectedType === "reader" ? win.Zotero_Tabs.selectedID : "";
  const reader = activeReaderID
    ? (Zotero.Reader.getByTabID(activeReaderID) as { itemID?: number } | undefined)
    : undefined;
  const resolvedReaderItem = reader?.itemID ? Zotero.Items.get(reader.itemID) : undefined;
  const readerItem = resolvedReaderItem || undefined;
  const selectedItem = selected.length === 1 ? selected[0] : undefined;
  if (!readerItem && !selectedItem) throw new Error("请先选中一篇文献，或打开它的 PDF");

  let item = readerItem?.parentItem || readerItem || selectedItem;
  if (!item) throw new Error("没有检测到当前文献");
  let attachment: Zotero.Item | undefined;

  if (readerItem?.isAttachment()) {
    attachment = readerItem;
  } else if (selectedItem?.isAttachment()) {
    attachment = selectedItem;
    const parent = selectedItem.parentItem;
    item = parent || selectedItem;
  }
  if (!attachment) {
    for (const id of item.getAttachments()) {
      const candidate = Zotero.Items.get(id);
      if (candidate && candidate.isPDFAttachment()) {
        attachment = candidate;
        break;
      }
    }
  }

  if (!attachment?.isPDFAttachment()) {
    throw new Error("当前文献没有可读取的 PDF 附件");
  }
  return { item, attachment, metadata: buildMetadata(item, attachment) };
}

export function splitText(text: string, targetTokens = 420, overlapTokens = 60): PaperChunk[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  const chunks: PaperChunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    let low = start + 1;
    let high = Math.min(normalized.length, start + targetTokens * 5);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (estimateTokens(normalized.slice(start, middle)) <= targetTokens) low = middle;
      else high = middle - 1;
    }
    let end = low;
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const sentenceBreak = Math.max(
        normalized.lastIndexOf("。", end),
        normalized.lastIndexOf(". ", end),
      );
      const candidate = Math.max(paragraphBreak, sentenceBreak);
      if (candidate > start + (end - start) * 0.55) end = candidate + 1;
    }
    const chunkText = normalized.slice(start, end).trim();
    if (chunkText) {
      chunks.push({ id: chunks.length + 1, text: chunkText, start, end });
    }
    if (end >= normalized.length) break;
    const chunkTokens = Math.max(1, estimateTokens(chunkText));
    const overlapChars = Math.max(
      20,
      Math.min(chunkText.length - 1, Math.round((chunkText.length * overlapTokens) / chunkTokens)),
    );
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

/**
 * Read Zotero's cached PDF text without generating embeddings. The cache is
 * reused when available; indexing is only requested when Zotero has not
 * extracted this attachment yet.
 */
export async function readPaperText(attachment: Zotero.Item): Promise<string> {
  let cacheFile = Zotero.FullText.getItemCacheFile(attachment);
  if (!cacheFile.exists()) {
    await Zotero.FullText.indexItems([attachment.id], { complete: true });
    cacheFile = Zotero.FullText.getItemCacheFile(attachment);
  }
  if (!cacheFile.exists()) {
    throw new Error("没有从 PDF 中提取到文本；扫描版 PDF 暂不支持自动 OCR");
  }
  const text = String(await Zotero.File.getContentsAsync(cacheFile.path)).trim();
  if (text.length < 200) {
    throw new Error("PDF 可提取文本过少；它可能是扫描件或文件内容异常");
  }
  return text;
}

function representativeExcerpts(chunks: PaperChunk[], maxChars = 30000): string {
  if (!chunks.length) return "";
  const count = Math.min(12, chunks.length);
  const selected = new Set<number>([0, chunks.length - 1]);
  for (let i = 0; i < count; i++) {
    selected.add(Math.round((i * (chunks.length - 1)) / Math.max(1, count - 1)));
  }
  let used = 0;
  const excerpts: string[] = [];
  for (const index of [...selected].sort((a, b) => a - b)) {
    const chunk = chunks[index];
    if (!chunk || used >= maxChars) break;
    const text = chunk.text.slice(0, maxChars - used);
    excerpts.push(`[[片段 ${chunk.id}]]\n${text}`);
    used += text.length;
  }
  return excerpts.join("\n\n");
}

async function buildPaperMemory(metadata: PaperMetadata, chunks: PaperChunk[]): Promise<string> {
  const excerpts = representativeExcerpts(chunks);
  return callAI(
    [
      {
        role: "system",
        content:
          "你是严谨的学术阅读助手。下面是论文中按全文位置均匀抽取的代表性片段。请建立供后续问答使用的内部文献记忆，不要写寒暄。仅依据片段，总结：研究问题、理论背景、方法与数据、关键发现、作者结论、限制、重要术语及片段编号。无法确认的内容写‘未确认’，禁止补充外部知识。",
      },
      {
        role: "user",
        content: `题名：${metadata.title}\n作者：${metadata.authors.join(", ")}\n摘要：${metadata.abstract}\n\n${excerpts}`,
      },
    ],
    { temperature: 0.1, maxTokens: 1800 },
  );
}

export async function ingestCurrentPaper(
  win: Window,
  onProgress: ProgressCallback = () => undefined,
  existingMemory = "",
  existingContentHash = "",
): Promise<PaperContext> {
  const { attachment, metadata } = resolveCurrentPaper(win);
  onProgress("正在提取 PDF 全文…");
  const text = await readPaperText(attachment);
  onProgress("正在建立全文检索索引…");
  const chunks = splitText(text);
  if (!chunks.length) throw new Error("全文切分失败");
  const contentHash = paperContentHash(text);

  const prefs = getPreferences();
  let vectorIndex;
  if (prefs.embeddingVerifiedAt) {
    const connection = currentEmbeddingConfig();
    vectorIndex = await loadVectorIndex(metadata, contentHash, chunks.length, connection);
    if (vectorIndex) {
      onProgress("已加载本地全文向量索引…");
    } else {
      onProgress(`正在生成 ${chunks.length} 个全文向量…`);
      vectorIndex = await buildVectorIndex(metadata, chunks, contentHash, connection);
    }
  }

  let memory = existingContentHash === contentHash ? existingMemory : "";
  if (!memory && prefs.apiKey && prefs.model && prefs.aiVerifiedAt) {
    onProgress("正在建立内部文献记忆…");
    memory = await buildPaperMemory(metadata, chunks);
  }
  return {
    metadata,
    chunks,
    vectorIndex,
    contentHash,
    textLength: text.length,
    lineCount: text.split(/\r\n|\r|\n/).length,
    memory,
    loadedAt: new Date().toISOString(),
  };
}

function queryTerms(query: string): string[] {
  const lower = query.toLocaleLowerCase();
  const latin = lower.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const hanRuns = lower.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const hanTerms: string[] = [];
  for (const run of hanRuns) {
    if (run.length <= 4) hanTerms.push(run);
    for (let index = 0; index < run.length - 1; index++) {
      hanTerms.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...latin, ...hanTerms])].filter((term) => term.length > 1);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count++;
    offset += term.length;
  }
  return count;
}

export function estimateTokens(value: string): number {
  const han = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  return Math.ceil(han * 1.15 + (value.length - han) / 3.6);
}

function chapterHeading(chunk: PaperChunk): string {
  const genericHeading =
    /^(?:abstract|introduction|background|related work|literature review|method(?:s|ology)?|materials and methods|experimental setup|experiments?|results?|analysis|discussion|limitations?|conclusions?|appendix)$/i;
  const numberedHeading = /^(?:\d+|[IVXLC]+)[.)]?\s+(?!\d)([\p{L}][\p{L}\p{N}\s,&:()\-/]{2,88})$/iu;
  const chineseHeading =
    /^(?:第[一二三四五六七八九十百\d]+[章节]\s*)?([一二三四五六七八九十]+、)?(?:摘要|引言|绪论|研究背景|相关工作|文献综述|理论基础|研究方法|材料与方法|实验(?:设计|设置)?|结果|分析|讨论|局限性?|结论|附录)$/;
  for (const rawLine of chunk.text.split("\n")) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (line.length < 3 || line.length > 96) continue;
    if (/^(?:references|bibliography|acknowledg(?:e)?ments?|参考文献|致谢)$/i.test(line)) continue;
    if (genericHeading.test(line) || numberedHeading.test(line) || chineseHeading.test(line)) {
      return line;
    }
  }
  return "";
}

/**
 * Select one representative chunk for every identifiable major section. This
 * is intentionally structural rather than semantic: the empty-input
 * background mode must inspect the paper chapter by chapter instead of
 * returning only the chunks closest to a generic query.
 */
export function selectChapterEvidence(
  context: PaperContext,
): { text: string; chunkIDs: number[] } | null {
  const detected: Array<{ heading: string; chunk: PaperChunk }> = [];
  const seen = new Set<string>();
  for (const chunk of context.chunks) {
    const heading = chapterHeading(chunk);
    const key = heading.toLocaleLowerCase();
    if (!heading || seen.has(key)) continue;
    seen.add(key);
    detected.push({ heading, chunk });
  }
  if (detected.length < 2) return null;

  const maxSections = 12;
  const selected =
    detected.length <= maxSections
      ? detected
      : Array.from(
          { length: maxSections },
          (_, index) => detected[Math.round((index * (detected.length - 1)) / (maxSections - 1))],
        ).filter((entry): entry is { heading: string; chunk: PaperChunk } => Boolean(entry));
  const budget = Math.max(4000, getPreferences().maxEvidenceTokens);
  const accepted: typeof selected = [];
  let usedTokens = 0;
  for (const entry of selected) {
    const tokens = estimateTokens(entry.chunk.text);
    if (accepted.length >= 2 && usedTokens + tokens > budget) break;
    accepted.push(entry);
    usedTokens += tokens;
  }
  return {
    text: accepted
      .map(({ heading, chunk }) => `## 章节线索：${heading}\n[[片段 ${chunk.id}]]\n${chunk.text}`)
      .join("\n\n"),
    chunkIDs: accepted.map(({ chunk }) => chunk.id),
  };
}

function isGlobalQuestion(query: string): boolean {
  return /(全文|整篇|总体|整体|核心贡献|主要贡献|研究框架|论证链|所有实验|综合|总结本文|概括本文|overall|entire paper|main contribution|summari[sz]e)/i.test(
    query,
  );
}

export async function selectEvidence(
  context: PaperContext,
  query: string,
): Promise<{ text: string; chunkIDs: number[] }> {
  const terms = queryTerms(query);
  const lexicalScores = context.chunks.map((chunk, index) => {
    const lower = chunk.text.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      const occurrences = countOccurrences(lower, term);
      if (occurrences) score += (1 + Math.log(occurrences)) * Math.min(5, term.length);
    }
    if (index === 0) score += 0.25;
    return score;
  });
  const lexicalMax = Math.max(...lexicalScores, 1);
  let semanticScores: number[] | null = null;
  if (context.vectorIndex) {
    const connection = currentEmbeddingConfig();
    if (context.vectorIndex.modelFingerprint !== embeddingFingerprint(connection)) {
      throw new Error("Embedding 模型配置已改变，请重新点击“建立全文索引”");
    }
    const queryVector = (await embedTexts([query], connection))[0];
    if (!queryVector) throw new Error("没有生成有效的问题向量");
    semanticScores = cosineScores(context.vectorIndex, queryVector);
  }
  const scored = context.chunks.map((chunk, index) => {
    const lexical = (lexicalScores[index] ?? 0) / lexicalMax;
    const semantic = semanticScores ? ((semanticScores[index] ?? -1) + 1) / 2 : 0;
    return { chunk, score: semanticScores ? semantic * 0.82 + lexical * 0.18 : lexical };
  });
  scored.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);

  const maxTokens = getPreferences().maxEvidenceTokens;
  let candidates = [...scored];
  if (isGlobalQuestion(query) && context.chunks.length > 4) {
    const representativeCount = Math.min(10, context.chunks.length);
    const representatives: Array<{ chunk: PaperChunk; score: number }> = [];
    for (let index = 0; index < representativeCount; index++) {
      const position = Math.round(
        (index * (context.chunks.length - 1)) / Math.max(1, representativeCount - 1),
      );
      const chunk = context.chunks[position];
      if (chunk) representatives.push({ chunk, score: 0.35 });
    }
    candidates = [scored[0], ...representatives, ...scored].filter(
      (candidate): candidate is { chunk: PaperChunk; score: number } => Boolean(candidate),
    );
  }
  const chosen: PaperChunk[] = [];
  let usedTokens = 0;
  for (const { chunk } of candidates) {
    if (chosen.length >= 10 || usedTokens >= maxTokens) break;
    if (chosen.some((selected) => selected.id === chunk.id)) continue;
    const tokens = estimateTokens(chunk.text);
    if (chosen.length >= 3 && usedTokens + tokens > maxTokens) continue;
    chosen.push(chunk);
    usedTokens += tokens;
  }
  chosen.sort((a, b) => a.id - b.id);
  return {
    text: chosen.map((chunk) => `[[片段 ${chunk.id}]]\n${chunk.text}`).join("\n\n"),
    chunkIDs: chosen.map((chunk) => chunk.id),
  };
}

export function metadataSummary(metadata: PaperMetadata): string {
  return [
    `题名：${metadata.title}`,
    `作者：${metadata.authors.join(", ") || "未知"}`,
    `年份：${metadata.year || "未知"}`,
    `期刊/出版物：${metadata.publication || "未知"}`,
    `DOI：${metadata.doi || "无"}`,
    `摘要：${metadata.abstract || "无"}`,
  ].join("\n");
}
