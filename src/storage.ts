import { callAI } from "./ai";
import { metadataSummary } from "./paper";
import { filePickerPath, sessionDirectory } from "./paths";
import type { ConversationEntry, PaperContext, SavedSession } from "./types";

function sessionPath(libraryID: number, itemKey: string): string {
  return PathUtils.join(sessionDirectory(), `${libraryID}-${itemKey}.json`);
}

function draftPath(libraryID: number, itemKey: string): string {
  return PathUtils.join(sessionDirectory(), `${libraryID}-${itemKey}.draft.md`);
}

export async function saveSession(
  context: PaperContext,
  conversation: ConversationEntry[],
  promptHistory: string[],
): Promise<string> {
  const directory = sessionDirectory();
  await Zotero.File.createDirectoryIfMissingAsync(directory);
  const session: SavedSession = {
    schemaVersion: 1,
    paper: context.metadata,
    paperMemory: context.memory,
    contentHash: context.contentHash,
    textLength: context.textLength,
    lineCount: context.lineCount,
    chunkCount: context.chunks.length,
    conversation,
    promptHistory,
    savedAt: new Date().toISOString(),
  };
  const path = sessionPath(context.metadata.libraryID, context.metadata.itemKey);
  await Zotero.File.putContentsAsync(path, JSON.stringify(session, null, 2));
  const draft = [
    `# ${context.metadata.title}`,
    "",
    `> 暂存时间：${session.savedAt}`,
    `> 作者：${context.metadata.authors.join(", ") || "未知"}`,
    `> DOI：${context.metadata.doi || "无"}`,
    "",
    "## 文献内部记忆",
    "",
    context.memory || "尚未生成内部文献记忆。",
    "",
    "## 本次会话",
    "",
    transcript(conversation) || "尚无问答记录。",
  ].join("\n");
  await Zotero.File.putContentsAsync(
    draftPath(context.metadata.libraryID, context.metadata.itemKey),
    draft,
  );
  return path;
}

export async function loadSession(
  libraryID: number,
  itemKey: string,
): Promise<SavedSession | null> {
  const path = sessionPath(libraryID, itemKey);
  if (!(await IOUtils.exists(path))) return null;
  try {
    const raw = await Zotero.File.getContentsAsync(path);
    const parsed = JSON.parse(String(raw)) as SavedSession;
    return parsed.schemaVersion === 1 ? parsed : null;
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " "));
}

function transcript(conversation: ConversationEntry[]): string {
  return conversation
    .map(
      (entry, index) =>
        `### ${index + 1}. ${entry.input}\n\n${entry.output}\n\n` +
        (entry.evidenceChunkIDs.length
          ? `> 文内证据片段：${entry.evidenceChunkIDs.map((id) => `[[片段 ${id}]]`).join("、")}\n`
          : ""),
    )
    .join("\n");
}

async function organizeNote(
  context: PaperContext,
  conversation: ConversationEntry[],
): Promise<string> {
  if (!conversation.length && !context.memory) {
    return "# 阅读笔记\n\n尚未产生问答记录。\n";
  }
  const rawTranscript = transcript(conversation).slice(-28000);
  try {
    return await callAI(
      [
        {
          role: "system",
          content:
            "你是学术笔记编辑。请把文献内部记忆和用户会话整理为中文 Markdown 笔记。不得虚构论文内容；区分‘本文结论’、‘外部背景’和‘用户思考’。合并重复内容但保留重要细节。使用以下结构：核心问题、研究设计、关键发现、概念与背景、问答所得、局限与疑问、后续阅读线索。没有内容的章节可以省略。不要输出 YAML front matter。",
        },
        {
          role: "user",
          content: `${metadataSummary(context.metadata)}\n\n## 内部文献记忆\n${context.memory || "未生成"}\n\n## 会话记录\n${rawTranscript}`,
        },
      ],
      { temperature: 0.15, maxTokens: 3500 },
    );
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    return `# 内部文献记忆\n\n${context.memory || "未生成"}\n\n# 会话记录\n\n${rawTranscript}`;
  }
}

export async function exportMarkdown(
  win: Window,
  context: PaperContext,
  conversation: ConversationEntry[],
): Promise<string | null> {
  const body = await organizeNote(context, conversation);
  const metadata = context.metadata;
  const frontMatter = [
    "---",
    `title: ${yamlString(metadata.title)}`,
    `authors: [${metadata.authors.map(yamlString).join(", ")}]`,
    `year: ${yamlString(metadata.year)}`,
    `doi: ${yamlString(metadata.doi)}`,
    `zotero_item_key: ${yamlString(metadata.itemKey)}`,
    `saved_at: ${yamlString(new Date().toISOString())}`,
    "---",
    "",
  ].join("\n");

  const filePickerModule = ChromeUtils.importESModule(
    "chrome://zotero/content/modules/filePicker.mjs",
  ) as {
    FilePicker: new () => {
      modeSave: number;
      returnOK: number;
      returnReplace: number;
      defaultString: string;
      defaultExtension: string;
      file: string | { path: string };
      init(win: Window, title: string, mode: number): void;
      appendFilter(label: string, pattern: string): void;
      show(): Promise<number>;
    };
  };
  const picker = new filePickerModule.FilePicker();
  picker.init(win, "保存 your_zotero 笔记", picker.modeSave);
  picker.defaultString = `${Zotero.File.getValidFileName(metadata.title).slice(0, 100)}.md`;
  picker.defaultExtension = "md";
  picker.appendFilter("Markdown", "*.md");
  const result = await picker.show();
  if (result !== picker.returnOK && result !== picker.returnReplace) return null;
  const path = filePickerPath(picker.file);
  await Zotero.File.putContentsAsync(path, frontMatter + body.trim() + "\n");
  return path;
}
