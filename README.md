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

## 与 zotero-gpt 的差异

两者都可以在 Zotero 中调用大模型、围绕 PDF 或选中文本提问，也都支持历史记录浏览。`your_zotero` 更聚焦“当前这一篇文献的证据边界”，而 [zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) 更偏向通用的 Zotero-GPT 工作台和可编程扩展。下表按公开项目说明和本项目当前实现整理，具体能力可能随版本变化：

| 维度 | your_zotero | zotero-gpt |
| --- | --- | --- |
| 核心定位 | 单篇文献的证据优先阅读助手 | 通用 Zotero-GPT 工作台 |
| 文献范围 | 当前打开的 PDF/文献，默认围绕单篇文献连续问答 | 当前 PDF、选中文本、所选条目，并可扩展到文库搜索 |
| 文献约束 | “建立全文索引”后使用全文哈希、分块、关键词 + Embedding 混合召回和证据预算，尽量避免问题脱离本文 | 主要通过上下文组装、命令标签和自定义提示完成任务编排 |
| 索引持久化 | 本地保存索引；按全文哈希和 Embedding 模型指纹自动检测，文献未变化时可复用 | 公共 README 重点介绍命令标签和上下文操作，未将本项目这套单篇全文索引流程作为核心入口 |
| Embedding | 单独配置问答模型与 Embedding；支持 Ollama 本地模型 | 以 GPT/API 配置和命令标签为主，具体 Embedding 能力取决于扩展与版本 |
| 背景补齐 | 空输入按章节补充概念、定义、理论和方法；指定段落时只解释该部分 | 可通过命令标签自定义摘要、解释和其他提示 |
| 笔记工作流 | 内置“暂存笔记”和“保存笔记”，直接整理为 Markdown | 可与 Better Notes 集成，也可通过命令标签自定义保存流程 |
| 扩展方式 | 固定的五个阅读动作，开箱即用、配置负担较低 | 支持命令标签、触发词、JavaScript 代码块等高级编排，扩展性更强 |
| UI 取向 | 简约浮窗，固定按钮对应索引、背景、翻译和笔记动作 | 更通用的 GPT 面板，支持实时 Markdown/LaTeX、窗口缩放和移动等能力 |
| 明确取舍 | 当前版本不含文库级语义搜索、多篇联合问答、自动 OCR 和 Better Notes 依赖 | 功能覆盖更广，但需要理解命令标签和更多配置项 |

因此，若目标是“回答必须优先服从当前论文”，优先使用 `your_zotero` 的全文索引与证据召回；若目标是把 Zotero 操作编排成可复用的 GPT 命令，`zotero-gpt` 的命令标签体系更合适。两者也可以同时安装，分别承担文献证据阅读和通用自动化任务。

## 安装

从 GitHub Releases 下载最新 `.xpi`，在 Zotero 中打开“工具 → 插件”，将 `.xpi` 拖入插件窗口并重启 Zotero。插件拥有读取当前文献和访问用户配置网络服务的权限，请只从可信来源安装。

## 配置

在 Zotero 设置的 `your_zotero` 页面依次完成：

1. AI 问答：选择厂商、填写 Key、点击“获取模型”，选择实际返回的模型后验证。
2. Embedding：可复用问答服务，也可选择 Ollama 本地模型。Ollama 默认地址为 `http://127.0.0.1:11434/v1`；推荐中英文论文使用 `qwen3-embedding:4b`。
3. 文献检索：Crossref 无需 Key；OpenAlex 和 Semantic Scholar 按服务要求填写 Key。

### Ollama 本地 Embedding

Ollama 只在你选择“Ollama”作为 Embedding 服务商时才需要启动；问答模型和云端 Embedding 不依赖 Ollama。首次配置可按以下步骤操作：

1. 安装 Ollama，并确认系统托盘中的 Ollama 服务正在运行。默认地址应为 `http://127.0.0.1:11434`。
2. 在 PowerShell 中安装模型：

   ```powershell
   ollama pull qwen3-embedding:4b
   ollama list
   ```

   `qwen3-embedding:4b` 约占 4B 级模型的本地存储空间；实际显存占用会随量化方式、上下文长度和并发请求变化。
   Windows 默认模型目录通常是 `%USERPROFILE%\.ollama\models`；如需更改位置，应在启动 Ollama 前设置 `OLLAMA_MODELS`，不建议直接移动模型目录中的文件。

3. 打开 Zotero → 设置 → `your_zotero`，取消“复用问答服务”，将 Embedding 服务商选为 `Ollama`。
4. 点击“检测本地模型”，选择列表中的 `qwen3-embedding:4b`，再点击“验证 Embedding”。验证成功后，点击“建立全文索引”。

如果检测失败，请依次检查：

- `ollama list` 是否能看到模型；
- Ollama 是否仍在运行；
- 浏览器或终端访问 `http://127.0.0.1:11434/api/tags` 是否能返回 JSON；
- Embedding 地址是否保持为 `http://127.0.0.1:11434/v1`；
- 模型名称是否完全匹配列表中的名称。

建立索引或执行需要向量召回的功能时，Ollama 会按需加载 Embedding 模型。空闲一段时间后 Ollama 可能卸载模型，因此不保证它持续占用显存；如果希望减少显存占用，可以在 Ollama 中设置模型保留时间，或执行 `ollama stop qwen3-embedding:4b`。

Embedding 模型变化后必须重新建立全文索引，不能混用不同模型生成的向量。

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

