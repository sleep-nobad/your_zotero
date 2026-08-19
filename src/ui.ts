import { callAI, searchBackground } from "./ai";
import {
  ingestCurrentPaper,
  metadataSummary,
  readPaperText,
  resolveCurrentPaper,
  selectChapterEvidence,
  selectEvidence,
} from "./paper";
import { renderMarkdown } from "./markdown";
import { getPreferences } from "./prefs";
import { exportMarkdown, loadSession, saveSession } from "./storage";
import { getVectorIndexStatus, paperContentHash } from "./vector-index";
import type {
  ActionKind,
  ConversationEntry,
  PaperContext,
  PaperMetadata,
  SavedSession,
} from "./types";

const INPUT_LINE_HEIGHT = 38;
const INPUT_AUTO_MAX_HEIGHT = 160;
const INPUT_MANUAL_MAX_HEIGHT = 320;
const OUTPUT_LINE_HEIGHT = 40;
const OUTPUT_AUTO_MAX_HEIGHT = 220;
const OUTPUT_MANUAL_MAX_HEIGHT = 720;

function create<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function recentConversation(entries: ConversationEntry[]): string {
  return entries
    .slice(-4)
    .map((entry) => `用户：${entry.input.slice(0, 900)}\n助手：${entry.output.slice(0, 1800)}`)
    .join("\n\n")
    .slice(-7500);
}

function sourceText(sources: Awaited<ReturnType<typeof searchBackground>>): string {
  return sources
    .map(
      (source) =>
        `[${source.id}] ${source.title} (${source.year ?? "年份未知"})\n` +
        `作者：${source.authors.join(", ") || "未知"}\n摘要：${source.abstract || "无摘要"}\n链接：${source.url || "无"}`,
    )
    .join("\n\n");
}

export class CompanionUI {
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly outputWrap: HTMLDivElement;
  private readonly output: HTMLDivElement;
  private readonly outputLabel: HTMLSpanElement;
  private readonly paperTitle: HTMLSpanElement;
  private readonly status: HTMLSpanElement;
  private readonly progressRow: HTMLDivElement;
  private readonly progressText: HTMLSpanElement;
  private readonly dot: HTMLSpanElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly actionButtons: HTMLButtonElement[] = [];
  private context: PaperContext | null = null;
  private currentPaper: PaperMetadata | null = null;
  private restored: SavedSession | null = null;
  private conversation: ConversationEntry[] = [];
  private promptHistory: string[] = [];
  private historyIndex = 0;
  private historyDraft = "";
  private busy = false;
  private displayedText = "";
  private outputResizeFrame = 0;
  private readonly keyHandler: (event: KeyboardEvent) => void;
  private readonly viewportResizeHandler: () => void;

  constructor(private readonly win: Window) {
    this.doc = win.document;
    this.root = create(this.doc, "div", "") as HTMLDivElement;
    this.root.id = "papercompanion-root";
    this.root.dataset.open = "false";

    const shell = create(this.doc, "div", "pc-shell");
    const topbar = create(this.doc, "div", "pc-topbar");
    this.dot = create(this.doc, "span", "pc-dot");
    this.paperTitle = create(this.doc, "span", "pc-paper-title", "未选择文献");
    this.status = create(this.doc, "span", "pc-status", "就绪");
    const closeButton = create(this.doc, "button", "pc-close-button", "关闭") as HTMLButtonElement;
    closeButton.type = "button";
    closeButton.title = "关闭（Esc）";
    closeButton.addEventListener("click", () => this.hide());
    topbar.append(this.dot, this.paperTitle, this.status, closeButton);

    const inputRow = create(this.doc, "div", "pc-input-row");
    this.input = create(this.doc, "textarea", "pc-input") as HTMLTextAreaElement;
    this.input.rows = 1;
    this.input.placeholder = "针对当前文献提问，或粘贴需要翻译的内容…";
    this.input.setAttribute("aria-label", "your_zotero 输入框");
    this.sendButton = create(this.doc, "button", "pc-send") as HTMLButtonElement;
    this.sendButton.type = "button";
    this.sendButton.title = "发送";
    this.setSendButtonIcon("send");
    inputRow.append(this.input, this.sendButton);
    const inputResizeHandle = create(this.doc, "div", "pc-region-resize pc-input-resize");
    inputResizeHandle.title = "拖动调整输入区域高度";
    inputResizeHandle.setAttribute("aria-hidden", "true");

    const actions = create(this.doc, "div", "pc-actions");
    const actionSpecs: Array<[string, () => void]> = [
      ["建立全文索引", () => void this.readPaper()],
      ["补齐背景", () => void this.runAction("background")],
      ["专业翻译", () => void this.runAction("translate")],
      ["暂存笔记", () => void this.stash()],
      ["保存笔记", () => void this.exportNote()],
    ];
    for (const [label, handler] of actionSpecs) {
      const button = create(this.doc, "button", "pc-action", label) as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", handler);
      actions.append(button);
      this.actionButtons.push(button);
    }

    this.progressRow = create(this.doc, "div", "pc-progress") as HTMLDivElement;
    this.progressRow.dataset.visible = "false";
    this.progressRow.setAttribute("role", "status");
    this.progressRow.setAttribute("aria-live", "polite");
    const progressSpinner = create(this.doc, "span", "pc-spinner");
    this.progressText = create(this.doc, "span", "pc-progress-text", "正在处理…");
    this.progressRow.append(progressSpinner, this.progressText);

    this.outputWrap = create(this.doc, "div", "pc-output-wrap");
    this.outputWrap.dataset.visible = "false";
    const outputTools = create(this.doc, "div", "pc-output-tools");
    this.outputLabel = create(this.doc, "span", "pc-output-label", "回答");
    const copyButton = create(this.doc, "button", "pc-copy", "复制") as HTMLButtonElement;
    copyButton.type = "button";
    copyButton.addEventListener("click", () => this.copyOutput(copyButton));
    outputTools.append(this.outputLabel, copyButton);
    this.output = create(this.doc, "div", "pc-output");
    this.output.addEventListener("click", (rawEvent) => {
      const event = rawEvent as MouseEvent;
      const anchor = (event.target as HTMLElement | null)?.closest("a") as HTMLAnchorElement | null;
      if (!anchor?.href) return;
      event.preventDefault();
      event.stopPropagation();
      Zotero.launchURL(anchor.href);
    });
    const outputResizeHandle = create(this.doc, "div", "pc-region-resize pc-output-resize");
    outputResizeHandle.title = "拖动调整回答区域高度";
    outputResizeHandle.setAttribute("aria-hidden", "true");
    this.outputWrap.append(outputTools, this.output, outputResizeHandle);

    const resizeHandle = create(this.doc, "div", "pc-resize-handle");
    resizeHandle.title = "拖动调整悬浮框宽度";
    resizeHandle.setAttribute("aria-hidden", "true");

    shell.append(
      topbar,
      inputRow,
      inputResizeHandle,
      actions,
      this.progressRow,
      this.outputWrap,
      resizeHandle,
    );
    this.root.append(shell);
    this.doc.documentElement?.append(this.root);

    this.sendButton.addEventListener("click", () => void this.runAction("ask"));
    this.input.addEventListener("keydown", (event) => this.onInputKeyDown(event as KeyboardEvent));
    this.input.addEventListener("input", () => this.resizeInputToContent());
    this.bindDragging(topbar);
    this.bindResize(resizeHandle);
    this.bindVerticalResize(
      inputResizeHandle,
      this.input,
      INPUT_LINE_HEIGHT,
      INPUT_MANUAL_MAX_HEIGHT,
      () => {
        this.input.dataset.userResized = "true";
      },
    );
    this.bindVerticalResize(
      outputResizeHandle,
      this.output,
      OUTPUT_LINE_HEIGHT,
      OUTPUT_MANUAL_MAX_HEIGHT,
      () => {
        this.output.dataset.userResized = "true";
      },
    );
    inputResizeHandle.title = "拖动调整输入区域高度；双击恢复自动高度";
    outputResizeHandle.title = "拖动调整回答区域高度；双击恢复自动高度";
    inputResizeHandle.addEventListener("dblclick", () => {
      delete this.input.dataset.userResized;
      this.resizeInputToContent();
    });
    outputResizeHandle.addEventListener("dblclick", () => {
      delete this.output.dataset.userResized;
      this.resizeOutputToContent();
    });

    this.keyHandler = (event) => {
      const modifier = Zotero.isMac ? event.metaKey : event.ctrlKey;
      const isDigitTwo = event.code === "Digit2" || event.code === "Numpad2" || event.key === "2";
      if (modifier && !event.shiftKey && !event.altKey && isDigitTwo) {
        event.preventDefault();
        event.stopPropagation();
        void this.toggle();
      } else if (event.key === "Escape" && this.isOpen()) {
        event.preventDefault();
        this.hide();
      }
    };
    this.win.addEventListener("keydown", this.keyHandler, true);
    this.viewportResizeHandler = () => {
      this.resizeInputToContent();
      if (this.outputWrap.dataset.visible === "true") this.resizeOutputToContent();
    };
    this.win.addEventListener("resize", this.viewportResizeHandler);
  }

  destroy(): void {
    this.win.removeEventListener("keydown", this.keyHandler, true);
    this.win.removeEventListener("resize", this.viewportResizeHandler);
    if (this.outputResizeFrame) this.win.cancelAnimationFrame(this.outputResizeFrame);
    this.root.remove();
  }

  isOpen(): boolean {
    return this.root.dataset.open === "true";
  }

  async toggle(): Promise<void> {
    if (this.isOpen()) this.hide();
    else await this.show();
  }

  async show(): Promise<void> {
    this.root.dataset.open = "true";
    await this.syncCurrentPaper(true);
    this.input.focus();
  }

  hide(): void {
    this.root.dataset.open = "false";
  }

  private setStatus(message: string, loading = false): void {
    this.status.textContent = loading ? "处理中" : message;
    this.progressText.textContent = message;
    this.progressRow.dataset.visible = loading ? "true" : "false";
    if (!loading && this.outputWrap.dataset.visible === "true") this.resizeOutputToContent();
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.sendButton.disabled = value;
    this.setSendButtonIcon(value ? "stop" : "send");
    this.sendButton.title = value ? "正在处理" : "发送";
    for (const button of this.actionButtons) button.disabled = value;
  }

  private setSendButtonIcon(mode: "send" | "stop"): void {
    const icon = this.doc.createElement("img");
    icon.src = `chrome://your_zotero/content/icons/${
      mode === "send" ? "paper-plane-right.svg" : "stop.svg"
    }`;
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    this.sendButton.dataset.mode = mode;
    this.sendButton.replaceChildren(icon);
  }

  private setIndexReady(ready: boolean): void {
    this.dot.dataset.ready = String(ready);
    this.paperTitle.dataset.ready = String(ready);
  }

  private async detectCurrentPaperIndex(
    metadata: PaperMetadata,
    attachment: Zotero.Item,
  ): Promise<Awaited<ReturnType<typeof getVectorIndexStatus>> | null> {
    if (!getPreferences().embeddingVerifiedAt) return null;
    try {
      const text = await readPaperText(attachment);
      return await getVectorIndexStatus(metadata, paperContentHash(text));
    } catch (error) {
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private async syncCurrentPaper(forceIndexCheck = false): Promise<void> {
    try {
      const { metadata, attachment } = resolveCurrentPaper(this.win);
      this.paperTitle.textContent = metadata.title;
      const samePaper =
        this.currentPaper?.itemKey === metadata.itemKey &&
        this.currentPaper.libraryID === metadata.libraryID;
      if (samePaper && !forceIndexCheck) {
        return;
      }
      if (samePaper) {
        const index = await this.detectCurrentPaperIndex(metadata, attachment);
        this.setIndexReady(Boolean(index));
        if (index) this.setStatus(`索引已检测 · ${index.chunkCount} 个片段`);
        return;
      }
      this.currentPaper = metadata;
      this.context = null;
      this.restored = await loadSession(metadata.libraryID, metadata.itemKey);
      this.conversation = this.restored?.conversation ?? [];
      // A completed conversation is the authoritative history: each prompt is
      // then guaranteed to have the exact answer displayed beside it.
      this.promptHistory = this.conversation.map((entry) => entry.input).slice(-100);
      this.historyIndex = this.conversation.length;
      const restoredIndex = await this.detectCurrentPaperIndex(metadata, attachment);
      this.setIndexReady(Boolean(restoredIndex));
      if (this.restored) {
        this.setStatus(
          restoredIndex
            ? `索引已恢复 · ${restoredIndex.chunkCount} 个片段 · ${this.conversation.length} 条记录`
            : `已恢复 ${this.conversation.length} 条记录 · 索引需重新建立`,
        );
        const last = this.conversation.at(-1);
        if (last) this.showOutput("上次回答", last.output);
      } else {
        this.setStatus(
          restoredIndex ? `索引已检测 · ${restoredIndex.chunkCount} 个片段` : "尚未建立全文索引",
        );
        this.outputWrap.dataset.visible = "false";
      }
    } catch (error) {
      this.currentPaper = null;
      this.context = null;
      this.paperTitle.textContent = "未选择文献";
      this.setIndexReady(false);
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureContext(): Promise<PaperContext> {
    await this.syncCurrentPaper();
    if (this.context) return this.context;
    const memory = this.restored?.paperMemory ?? "";
    this.context = await ingestCurrentPaper(
      this.win,
      (message) => this.setStatus(message, true),
      memory,
      this.restored?.contentHash ?? "",
    );
    this.currentPaper = this.context.metadata;
    this.setIndexReady(true);
    return this.context;
  }

  private async readPaper(): Promise<void> {
    if (this.busy) return;
    this.resetOutputForTask();
    if (!getPreferences().embeddingVerifiedAt) {
      this.showError(new Error("请先在插件设置中完成 Embedding 模型验证"));
      return;
    }
    this.setBusy(true);
    try {
      this.context = null;
      const context = await this.ensureContext();
      this.setStatus(
        `全文索引已就绪 · ${context.textLength.toLocaleString()} 字符 · ${context.lineCount.toLocaleString()} 行 · ${context.chunks.length} 个片段`,
      );
      this.outputWrap.dataset.visible = "false";
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  private onInputKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.runAction("ask");
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const value = this.input.value;
    const caret = this.input.selectionStart ?? 0;
    const firstLineEnd = value.indexOf("\n");
    const lastLineStart = value.lastIndexOf("\n") + 1;
    const canGoUp = event.key === "ArrowUp" && (firstLineEnd === -1 || caret <= firstLineEnd);
    const canGoDown = event.key === "ArrowDown" && (lastLineStart === 0 || caret >= lastLineStart);
    if (!canGoUp && !canGoDown) return;
    if (!this.conversation.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.historyIndex === this.conversation.length) this.historyDraft = value;
    if (canGoUp) this.historyIndex = Math.max(0, this.historyIndex - 1);
    if (canGoDown) this.historyIndex = Math.min(this.conversation.length, this.historyIndex + 1);
    const entry = this.conversation[this.historyIndex];
    const next = entry?.input ?? this.historyDraft;
    this.input.value = next;
    delete this.input.dataset.userResized;
    this.input.style.height = `${INPUT_LINE_HEIGHT}px`;
    this.resizeInputToContent();
    this.input.setSelectionRange(next.length, next.length);
    if (entry) this.showOutput(this.outputLabelFor(entry.action, true), entry.output, true);
  }

  private rememberPrompt(input: string): void {
    if (!input.trim()) return;
    if (this.promptHistory.at(-1) !== input) this.promptHistory.push(input);
    if (this.promptHistory.length > 100)
      this.promptHistory.splice(0, this.promptHistory.length - 100);
    this.historyIndex = this.conversation.length;
    this.historyDraft = "";
  }

  private async runAction(action: ActionKind): Promise<void> {
    if (this.busy) return;
    const input = this.input.value.trim();
    if (!input && action !== "background") {
      this.setStatus(action === "translate" ? "请先粘贴需要翻译的内容" : "请输入问题");
      this.input.focus();
      return;
    }
    this.resetOutputForTask();
    const prefs = getPreferences();
    if (!prefs.apiKey || !prefs.model || !prefs.aiVerifiedAt) {
      this.showError(new Error("请先在 Zotero 设置 → your_zotero 中获取模型并完成真实连接验证"));
      return;
    }
    if (action === "background" && !prefs.retrievalVerifiedAt) {
      this.showError(new Error("请先在 Zotero 设置 → your_zotero 中验证文献检索服务"));
      return;
    }
    if (action !== "translate" && !prefs.embeddingVerifiedAt) {
      this.showError(new Error("请先在插件设置中完成 Embedding 模型验证"));
      return;
    }
    this.setBusy(true);
    try {
      let output: string;
      let chunkIDs: number[] = [];
      if (action === "translate") {
        output = await this.translate(input);
      } else if (action === "background") {
        output = await this.background(input);
      } else {
        const answer = await this.ask(input);
        output = answer.output;
        chunkIDs = answer.chunkIDs;
      }
      const actualInput = input || "补齐本文背景";
      const entry: ConversationEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        action,
        input: actualInput,
        output,
        evidenceChunkIDs: chunkIDs,
        createdAt: new Date().toISOString(),
      };
      this.conversation.push(entry);
      this.rememberPrompt(actualInput);
      this.showOutput(this.outputLabelFor(action), output);
      this.input.value = "";
      this.resizeInputToContent();
      this.setStatus("完成");
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  private async ask(input: string): Promise<{ output: string; chunkIDs: number[] }> {
    const context = await this.ensureContext();
    this.setStatus("正在检索本文证据…", true);
    const evidence = await selectEvidence(context, input);
    this.setStatus("正在依据本文回答…", true);
    const output = await callAI(
      [
        {
          role: "system",
          content:
            "你是当前论文的严谨阅读助手。回答必须以提供的论文证据片段为主，不得把常识或外部知识伪装成本文内容。引用本文时使用 [[片段 N]] 标记。证据不足时明确说‘当前证据片段中无法确认’，并指出需要查看的章节。回答用户真正的问题，保持专业、清晰。",
        },
        {
          role: "user",
          content: `${metadataSummary(context.metadata)}\n\n## 内部文献记忆\n${context.memory || "未生成"}\n\n## 最近会话\n${recentConversation(this.conversation) || "无"}\n\n## 本次检索到的论文原文\n${evidence.text}\n\n## 用户问题\n${input}`,
        },
      ],
      { temperature: 0.15, maxTokens: 2200 },
    );
    return { output, chunkIDs: evidence.chunkIDs };
  }

  private async background(input: string): Promise<string> {
    const context = await this.ensureContext();
    const focus = input.trim();
    const wholePaperMode = !focus;
    this.setStatus(
      wholePaperMode ? "正在分析各章节的知识门槛…" : "正在定位指定部分的知识门槛…",
      true,
    );
    let evidence = wholePaperMode ? selectChapterEvidence(context) : null;
    if (!evidence) {
      evidence = await selectEvidence(
        context,
        focus || "全文 各章节 专业概念 定义 定理 理论方法 外行 前置知识",
      );
    }
    this.setStatus("正在检索外部文献…", true);
    const sources = await searchBackground(context.metadata, focus);
    if (!sources.length) throw new Error("没有检索到可用的背景文献");
    this.setStatus("正在整理背景知识…", true);
    return callAI(
      [
        {
          role: "system",
          content:
            "你是论文知识门槛补全助手，不是论文概述助手。系统会明确指定以下两种模式之一，必须严格执行，不能混用。\n\n" +
            "**模式 A｜未指定内容**：按给出的论文原文识别各个主要章节或篇章。以章节为一级标题，逐章补充外行进入该专业后理解本章必须知道的概念、定义、定理、理论方法、符号和评价指标。每章只选真正构成理解门槛的 2—5 项；不要概述本章内容，也不要总结全文。若原文没有给出明确章节名，使用‘片段 N 对应部分’并声明无法确认标题，禁止编造章节名。\n\n" +
            "**模式 B｜已指定内容**：只围绕用户指定的章节、段落、公式、术语或方法补充知识。不得解释其他章节，不得扩展为全文背景。\n\n" +
            "每个知识点都应包含：中英文名称、一句话直觉、准确的定义、必要公式或定理及符号含义、成立/适用条件、常见误区，以及它与对应原文的直接关系。知识点按学习依赖顺序排列；最后用一条依赖链或小表格说明它们如何衔接，并列出实际使用的外部来源。\n\n" +
            "严禁输出论文摘要、全文导读、研究贡献列表或泛泛的领域综述。必须区分本文证据与外部知识：本文证据引用 [[片段 N]]；外部材料只能依据给定检索记录并引用 [B1]。证据不足时明确指出，不得杜撰章节、定理或公式。语言要连贯、紧凑、便于快速查阅。",
        },
        {
          role: "user",
          content: `${metadataSummary(context.metadata)}\n\n## 执行模式\n${wholePaperMode ? "模式 A：用户未输入内容。请按可识别的主要章节逐章补齐专业知识门槛，但不要概述章节或全文。" : "模式 B：用户指定了范围。只能补齐指定部分所需知识，不得涉及其他章节。"}\n\n## 当前论文内部记忆（仅用于辨认章节与上下文，禁止据此概述全文）\n${context.memory || "未生成"}\n\n## 当前论文证据\n${evidence.text}\n\n## 用户指定范围\n${focus || "无"}\n\n## 可用的外部检索结果\n${sourceText(sources)}`,
        },
      ],
      { temperature: 0.12, maxTokens: 3000 },
    );
  }

  private async translate(input: string): Promise<string> {
    await this.syncCurrentPaper();
    this.setStatus("正在进行专业翻译…", true);
    const terminology = this.context
      ? `\n当前论文题名：${this.context.metadata.title}\n术语上下文：${this.context.memory.slice(0, 5000)}`
      : this.currentPaper
        ? `\n当前论文题名：${this.currentPaper.title}`
        : "";
    return callAI(
      [
        {
          role: "system",
          content:
            "你是专业学术翻译。自动判断源语言：中文译为自然、准确的学术英文，其他语言译为严谨流畅的简体中文。保留 LaTeX、公式、变量、引文编号、DOI、Markdown 和专有名词；术语前后一致。不解释、不总结，只输出译文。",
        },
        { role: "user", content: `${terminology}\n\n待翻译内容：\n${input}` },
      ],
      { temperature: 0.1, maxTokens: 3000 },
    );
  }

  private async stash(): Promise<void> {
    if (this.busy) return;
    this.resetOutputForTask();
    this.setBusy(true);
    try {
      const context = await this.ensureContext();
      const path = await saveSession(context, this.conversation, this.promptHistory);
      this.setStatus("会话已暂存");
      this.restored = await loadSession(context.metadata.libraryID, context.metadata.itemKey);
      Zotero.debug(`your_zotero session saved to ${path}`);
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  private async exportNote(): Promise<void> {
    if (this.busy) return;
    this.resetOutputForTask();
    this.setBusy(true);
    try {
      const context = await this.ensureContext();
      this.setStatus("正在智能整理笔记…", true);
      const path = await exportMarkdown(this.win, context, this.conversation);
      if (path) {
        await saveSession(context, this.conversation, this.promptHistory);
        this.setStatus("Markdown 笔记已保存");
      } else {
        this.setStatus("已取消保存");
      }
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  private showOutput(label: string, text: string, forceAutosize = false): void {
    if (forceAutosize) {
      delete this.output.dataset.userResized;
      this.output.style.height = `${OUTPUT_LINE_HEIGHT}px`;
    }
    this.displayedText = text;
    this.outputLabel.textContent = label;
    this.output.innerHTML = renderMarkdown(text);
    this.outputWrap.dataset.visible = "true";
    this.output.scrollTop = 0;
    this.resizeOutputToContent();
    if (this.root.dataset.dragged === "true") {
      this.win.requestAnimationFrame(() => {
        const rect = this.root.getBoundingClientRect();
        const overflow = rect.bottom - (this.win.innerHeight - 12);
        if (overflow > 0) {
          this.root.style.top = `${Math.max(12, rect.top - overflow)}px`;
        }
      });
    }
  }

  private outputLabelFor(action: ActionKind, historical = false): string {
    const label =
      action === "translate" ? "专业翻译" : action === "background" ? "背景补充" : "本文回答";
    return historical ? `历史 · ${label}` : label;
  }

  private resetOutputForTask(): void {
    if (this.outputResizeFrame) {
      this.win.cancelAnimationFrame(this.outputResizeFrame);
      this.outputResizeFrame = 0;
    }
    delete this.output.dataset.userResized;
    delete this.output.dataset.resizing;
    this.output.style.height = `${OUTPUT_LINE_HEIGHT}px`;
    this.output.scrollTop = 0;
    this.output.replaceChildren();
    this.displayedText = "";
    this.outputWrap.dataset.visible = "false";
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    this.setStatus("操作失败");
    this.showOutput("错误", `**操作未完成**\n\n${message}`);
  }

  private copyOutput(button: HTMLButtonElement): void {
    if (!this.displayedText) return;
    const utilities = Zotero.Utilities.Internal as unknown as {
      copyTextToClipboard(text: string): void;
    };
    utilities.copyTextToClipboard(this.displayedText);
    const original = button.textContent;
    button.textContent = "已复制";
    this.win.setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }

  private fitHeightToContent(
    target: HTMLElement,
    minHeight: number,
    configuredMaxHeight: number,
  ): void {
    const rootHeight = this.root.getBoundingClientRect().height;
    const currentHeight = Math.max(minHeight, target.getBoundingClientRect().height);
    const otherHeight = Math.max(0, rootHeight - currentHeight);
    const availableHeight = Math.max(
      minHeight,
      Math.min(configuredMaxHeight, this.win.innerHeight - 24 - otherHeight),
    );
    // A fixed tall element reports its own height as scrollHeight even after
    // shorter history content is inserted. Measure from the one-line baseline,
    // then animate from the current visual height to the natural height.
    target.dataset.measuring = "true";
    target.style.height = `${minHeight}px`;
    const naturalHeight = Math.ceil(target.scrollHeight);
    const desiredHeight = Math.max(minHeight, Math.min(availableHeight, naturalHeight));
    target.style.height = `${currentHeight}px`;
    void target.offsetHeight;
    delete target.dataset.measuring;
    target.style.height = `${desiredHeight}px`;
  }

  private resizeInputToContent(): void {
    if (this.input.dataset.userResized === "true") return;
    this.fitHeightToContent(this.input, INPUT_LINE_HEIGHT, INPUT_AUTO_MAX_HEIGHT);
  }

  private resizeOutputToContent(): void {
    if (this.output.dataset.userResized === "true") return;
    if (this.outputResizeFrame) this.win.cancelAnimationFrame(this.outputResizeFrame);
    this.outputResizeFrame = this.win.requestAnimationFrame(() => {
      this.outputResizeFrame = 0;
      this.fitHeightToContent(this.output, OUTPUT_LINE_HEIGHT, OUTPUT_AUTO_MAX_HEIGHT);
    });
  }

  private bindVerticalResize(
    handle: HTMLElement,
    target: HTMLElement,
    minHeight: number,
    configuredMaxHeight: number,
    onResize?: () => void,
  ): void {
    let startY = 0;
    let originHeight = 0;
    let maxHeight = configuredMaxHeight;
    const move = (event: MouseEvent) => {
      const height = Math.max(
        minHeight,
        Math.min(maxHeight, originHeight + event.clientY - startY),
      );
      target.style.height = `${height}px`;
      onResize?.();
    };
    const up = () => {
      this.win.removeEventListener("mousemove", move);
      this.win.removeEventListener("mouseup", up);
      delete target.dataset.resizing;
      this.resizeInputToContent();
      if (this.outputWrap.dataset.visible === "true") this.resizeOutputToContent();
    };
    handle.addEventListener("mousedown", (rawEvent) => {
      const event = rawEvent as MouseEvent;
      const rootRect = this.root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (this.root.dataset.dragged !== "true") {
        // Pin the current visual position before a vertical resize so the
        // divider follows the pointer instead of the bottom-anchored root
        // expanding in the opposite direction.
        this.root.dataset.dragged = "true";
        this.root.style.left = `${rootRect.left}px`;
        this.root.style.top = `${rootRect.top}px`;
        this.root.style.bottom = "auto";
      }
      const otherHeight = rootRect.height - targetRect.height;
      maxHeight = Math.min(
        configuredMaxHeight,
        Math.max(minHeight, this.win.innerHeight - 24 - otherHeight),
      );
      startY = event.clientY;
      originHeight = targetRect.height;
      target.dataset.resizing = "true";
      this.win.addEventListener("mousemove", move);
      this.win.addEventListener("mouseup", up);
      event.preventDefault();
      event.stopPropagation();
    });
  }

  private bindDragging(handle: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    const move = (event: MouseEvent) => {
      const left = Math.max(
        12,
        Math.min(
          this.win.innerWidth - this.root.offsetWidth - 12,
          originLeft + event.clientX - startX,
        ),
      );
      const top = Math.max(
        12,
        Math.min(
          this.win.innerHeight - this.root.offsetHeight - 12,
          originTop + event.clientY - startY,
        ),
      );
      this.root.dataset.dragged = "true";
      this.root.style.bottom = "auto";
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    };
    const up = () => {
      this.win.removeEventListener("mousemove", move);
      this.win.removeEventListener("mouseup", up);
      delete this.root.dataset.dragging;
      this.resizeInputToContent();
      if (this.outputWrap.dataset.visible === "true") this.resizeOutputToContent();
    };
    handle.addEventListener("mousedown", (rawEvent) => {
      const event = rawEvent as MouseEvent;
      if ((event.target as HTMLElement).closest("button")) return;
      const rect = this.root.getBoundingClientRect();
      // Pin the transformed bottom-centred window to its exact visual pixels
      // before the first pointer move. Otherwise removing translateX(-50%) is
      // animated and looks like a short jump to the left.
      this.root.dataset.dragging = "true";
      this.root.dataset.dragged = "true";
      this.root.style.left = `${rect.left}px`;
      this.root.style.top = `${rect.top}px`;
      this.root.style.bottom = "auto";
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      this.win.addEventListener("mousemove", move);
      this.win.addEventListener("mouseup", up);
      event.preventDefault();
    });
  }

  private bindResize(handle: HTMLElement): void {
    let startX = 0;
    let originWidth = 0;
    let maxWidth = 0;
    let horizontalScale = 1;
    const move = (event: MouseEvent) => {
      const minWidth = Math.min(520, Math.max(320, this.win.innerWidth - 24));
      const width = Math.max(
        minWidth,
        Math.min(maxWidth, originWidth + (event.clientX - startX) * horizontalScale),
      );
      this.root.style.width = `${width}px`;
    };
    const up = () => {
      this.win.removeEventListener("mousemove", move);
      this.win.removeEventListener("mouseup", up);
      this.resizeInputToContent();
      if (this.outputWrap.dataset.visible === "true") this.resizeOutputToContent();
    };
    handle.addEventListener("mousedown", (rawEvent) => {
      const event = rawEvent as MouseEvent;
      const rect = this.root.getBoundingClientRect();
      startX = event.clientX;
      originWidth = rect.width;
      horizontalScale = this.root.dataset.dragged === "true" ? 1 : 2;
      maxWidth = Math.max(
        Math.min(520, Math.max(320, this.win.innerWidth - 24)),
        this.root.dataset.dragged === "true"
          ? this.win.innerWidth - rect.left - 12
          : this.win.innerWidth - 24,
      );
      this.win.addEventListener("mousemove", move);
      this.win.addEventListener("mouseup", up);
      event.preventDefault();
      event.stopPropagation();
    });
  }
}
