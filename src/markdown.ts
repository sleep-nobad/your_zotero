import katex from "katex";

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMath(source: string, displayMode: boolean): string {
  try {
    const math = katex.renderToString(source.trim(), {
      displayMode,
      output: "mathml",
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
    return `<span class="${displayMode ? "pc-math-display" : "pc-math-inline"}">${math}</span>`;
  } catch {
    return `<code class="pc-math-error">${escapeHTML(source)}</code>`;
  }
}

function inlineMarkdown(value: string): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `\uE000PC${index}\uE001`;
  };
  let source = value
    .replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHTML(code)}</code>`))
    .replace(/\\\((.+?)\\\)/g, (_match, formula: string) => stash(renderMath(formula, false)))
    .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_match, formula: string) =>
      stash(renderMath(formula, false)),
    );
  source = escapeHTML(source)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return source.replace(
    /\uE000PC(\d+)\uE001/g,
    (_match, index: string) => tokens[Number(index)] ?? "",
  );
}

export function renderMarkdown(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  let inCode = false;
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeList();
      output.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      output.push(escapeHTML(line) + "\n");
      continue;
    }
    const displayMath = line.match(/^\s*(?:\\\[([\s\S]+)\\\]|\$\$([\s\S]+)\$\$)\s*$/);
    if (displayMath) {
      closeList();
      output.push(renderMath(displayMath[1] ?? displayMath[2] ?? "", true));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1]?.length ?? 3;
      output.push(`<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const needed = unordered ? "ul" : "ol";
      if (listType !== needed) {
        closeList();
        listType = needed;
        output.push(`<${needed}>`);
      }
      output.push(`<li>${inlineMarkdown((unordered?.[1] ?? ordered?.[1]) || "")}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) {
      output.push('<div style="height:.25em"></div>');
    } else if (line.startsWith("> ")) {
      output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
    } else {
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  if (inCode) output.push("</code></pre>");
  return output.join("");
}

