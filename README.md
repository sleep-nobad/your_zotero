# your_zotero

`your_zotero` 是一个以当前文献为事实中心的 Zotero 9 AI 阅读插件。它把单篇论文的全文索引、连续问答、背景补充、专业翻译和 Markdown 笔记整理放进一个轻量悬浮窗，尽量避免回答脱离当前文献。

## 功能

- `Ctrl + 2`（macOS 为 `⌘ + 2`）或 PDF 工具栏按钮唤醒悬浮窗
- “建立全文索引”使用 Embedding 与关键词混合召回，限制证据预算
- “补齐背景”支持空输入按章节补充概念，也支持针对选中段落或术语补充
- 专业翻译、暂存笔记、保存笔记（Markdown）
- `↑` / `↓` 浏览输入历史并切换对应回答
- 输入区和输出区在默认范围内随内容自适应，也可以手动调整；滚动条隐藏
- 从服务端获取可用模型，避免手写模型名
- 支持 OpenAI 兼容服务、Ollama 本地 Embedding，以及 Crossref/OpenAlex/Semantic Scholar 检索

明确不包含：整个文库语义搜索、多篇论文联合问答、自动 OCR、云端账户同步、可编程命令标签以及 Better Notes 依赖。

## 安装

从 GitHub Releases 下载最新 `.xpi`，在 Zotero 中打开“工具 → 插件”，将 `.xpi` 拖入插件窗口并重启 Zotero。插件拥有读取当前文献和访问用户配置网络服务的权限，请只从可信来源安装。

## 配置

在 Zotero 设置的 `your_zotero` 页面依次完成：

1. AI 问答：选择厂商、填写 Key、点击“获取模型”，选择实际返回的模型后验证。
2. Embedding：可复用问答服务，也可选择 Ollama 本地模型。Ollama 默认地址为 `http://127.0.0.1:11434/v1`；推荐中英文论文使用 `qwen3-embedding:4b`。
3. 文献检索：Crossref 无需 Key；OpenAlex 和 Semantic Scholar 按服务要求填写 Key。

Key 只保存在本机 Zotero 偏好设置中，不会写入 Markdown 或会话日志。建立索引时，论文分块会发送给所选 Embedding 服务；普通问答只发送全局记忆和混合检索到的原文片段。未通过连接验证时不会发送论文内容。

默认索引目录是 Zotero 配置目录下的 `paper-companion`，可以在设置中改为其他本地目录。更换目录不会自动删除或迁移旧数据。

## 开发

```bash
npm install
npm run format:check
npm test
npm run build
```

构建结果位于 `release/`，开发模式需要先复制 `.env.example` 为 `.env` 并填入本机 Zotero 开发配置，然后运行 `npm start`。`.env`、`node_modules/`、`.scaffold/` 和 `.xpi` 均被 `.gitignore` 排除，发布时不会上传个人路径或密钥。

## 发布

发布者可使用 GitHub Actions 或本地构建生成 `.xpi`，再将其作为 Release asset 上传。`addon/manifest.json` 中的更新地址指向本仓库的 `release/update.json`；发布新版本时请同步更新版本号、更新清单和 SHA-256 哈希。

## License

AGPL-3.0-or-later

