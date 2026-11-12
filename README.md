# her-dsh-memory

Her 的长期记忆插件，跑在 DeepSeek Harness（DSH）上：自动记住聊天里的重要信息，下次对话时自然想起。由北京词元共振智能科技有限公司开发，了解 Her：https://hersoul.cn/zh

## 安装

需要 DeepSeek Harness（DSH）桌面版或 `dsh` 命令行。

1. 在 DSH 的插件页按包名 `@her-os/dsh-memory` 安装，或在终端执行：
   ```sh
   dsh plugin add @her-os/dsh-memory
   ```
2. 桌面版装好后按 Cmd+Q 完全退出再打开（Windows / Linux 关掉再开）。只关窗口的话，页面还是旧代码。
3. 打开设置 → 插件 →「记忆」标签页，能看到「Her 记忆」就是装好了。

装好后就会自动工作：每 3 轮对话、停下 5 分钟或关闭会话时整理一次值得记住的事，说「记住……」会立刻记下；回复前自动带上相关记忆。在「记忆」页可以查看、搜索、编辑、置顶、删除记忆，也可以暂停学习。

## 包

| 目录 | 包名 | 内容 |
|---|---|---|
| `packages/core` | `@her-os/memory-core` | 不依赖 DSH 的记忆引擎：存储、检索、从对话里提取、遗忘与整理 |
| `packages/dsh` | `@her-os/dsh-memory` | DSH bundle：Host 插件（`lib/index.js`）+ 浏览器端（`lib/client.js`）+ `cordis.patch.yml` |
| `packages/local-embed` | `@her-os/memory-local-embed` | 本机向量模型：首次使用时下载 ONNX Runtime 和模型；`bench/` 里是效果和压测脚本 |
| `packages/e2e` | `@her-os/dsh-memory-e2e` | 在真实 DSH（headless 和 Web）里跑的端到端测试 |
| `packages/eval` | `@her-os/memory-eval` | 大库压测：1 万条以上记忆时每轮召回的耗时、卡顿、内存和库体积 |

## 开发

需要 Node ≥ 24.9 和 pnpm 11（`npx pnpm@11.28.5` 也行）。

```sh
pnpm install
pnpm build       # 构建 packages/dsh/lib
pnpm test        # 单元测试；构建后会多跑产物格式检查
pnpm typecheck
pnpm test:e2e    # 打包插件，装进临时 DSH_HOME，用假模型跑 headless 和 Web；需要本机有 Chrome
```

`HER_MEMORY_E2E_LOCAL=1 pnpm test:e2e` 会多跑本地向量模型那组：真实下载约 140 MB（bge-small-zh 加 Runtime），看 Web 页面的下载进度、模型列表，以及换说法召回。`HER_MEMORY_EMBED_CACHE=<缓存目录>` 可以复用已下载的文件。

## 从源码装到本机 DSH

先构建，再在 DSH 的插件页用本地路径安装（填 `packages/dsh` 的绝对路径），或在 DSH 对话里让它用 `plugin_manager` 安装这个路径。装好后在设置 → 插件里能看到“记忆”标签页。

## 语义检索

默认关闭，只用关键词检索（SQLite FTS5，BM25 排序）。在记忆页点「开启本机语义检索」，或在设置里把「语义检索来源」改成本地模型 / 云端服务即可开启。选本地模型时在后台下载 ONNX Runtime（约 115 MB）和所选模型，存在 `$DSH_HOME/her-memory/embedding/`；下好之前只用关键词检索，下好后自动给已有记忆补向量。下载先走 Hugging Face，失败换 ModelScope（npm 包走 npmjs，失败换 npmmirror），支持断点续传和校验，多个 DSH 进程同时启动只有一个在下。

| 模型 | 下载 | 效果 | 速度 | 内存 | 语言 |
|---|---|---|---|---|---|
| EmbeddingGemma 300M 4-bit（默认） | 约 219 MB | ★★★ | ★★ | 约 500 MB | 中英等多语言 |
| EmbeddingGemma 300M 8-bit | 约 331 MB | ★★★ | ★ | 约 1.7 GB | 中英等多语言 |
| BGE small 中文 | 约 24 MB | ★ | ★★★ | 约 150 MB | 中文 |
| multilingual-e5-small | 约 135 MB | ★★ | ★★★ | 约 650 MB | 中英等多语言 |
| BGE-M3 | 约 586 MB | ★★★ | ★★ | 约 1.7 GB | 中英等多语言 |

实测（M 系列 Mac，公开小样例 50 条记忆、45 条换说法的提问；压测再混入 1 万条干扰记忆）：

| 模型 | 召回命中@5 | 压测命中@5 | 压测召回 p50 / p95 | 补算速度 | 内存（用时 / 补算峰值） |
|---|---|---|---|---|---|
| 只用关键词 | 0.27 | 0.24 | 0.3 / 2.1 ms | — | — |
| EmbeddingGemma 4-bit | 0.98 | 0.84 | 15.5 / 22.3 ms | 162 条/秒 | 490 MB / 870 MB |
| EmbeddingGemma 8-bit | 0.98 | 0.84 | 48.0 / 66.1 ms | 151 条/秒 | 1.6 GB / 2.0 GB |
| BGE small 中文 | 0.98 | 0.60 | 6.4 / 11.4 ms | 1538 条/秒 | 110 MB / 300 MB |
| multilingual-e5-small | 0.89 | 0.67 | 5.4 / 8.2 ms | 955 条/秒 | 650 MB / 930 MB |
| BGE-M3 | 0.98 | 0.87 | 15.7 / 19.2 ms | 155 条/秒 | 1.7 GB / 1.8 GB |

8-bit 在这台机器上效果和 4-bit 相同，却更慢、更占内存，留作对照。

模型许可：EmbeddingGemma 受 Google [Gemma 使用条款](https://ai.google.dev/gemma/terms) 约束，选用即表示接受；BGE small 中文、multilingual-e5-small、BGE-M3 为 MIT 许可。模型文件在用户本机下载，不随插件分发。

支持 Apple 芯片 Mac、Windows（x64/arm64）、Linux（x64/arm64）；Intel Mac 没有预编译的 Runtime，页面会提示改用云端服务。

效果和压测：`node packages/local-embed/bench/eval.ts --root <缓存目录> --model <模型 id|keyword> [--set <评测集>] [--stress 10000]`。默认用仓库里的公开小样例，也可以用 `--set` 指定自己的评测集。

数据库默认在 `$DSH_HOME/her-memory/memory.db`（没设 `DSH_HOME` 时是 `~/.dsh/her-memory/memory.db`）。

## 浏览器端构建

DSH 的浏览器端插件要按它的模块加载格式打包：整个文件是一次 `window.__ModuleLoader__.load({ id, factory })` 调用，共享模块通过注入的 `require` 取。DSH 自己的 `clientBundle` 预设没有发布，`packages/dsh/tsdown.config.ts` 照它重写了一份；只有 DSH 页面提供的平台模块（React、cordis、ui-slots 等）留作外部依赖，其余全部打进包里。

## 反馈与参与

- 问题和建议：提 [Issue](https://github.com/her-os/her-dsh-memory/issues)。
- 安全漏洞请不要公开提 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。
- 想改代码：见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。本机向量模型各有自己的许可，见上文「语义检索」。

## 发布到 npm

插件以 `@her-os/dsh-memory` 发布到 npm，用户在 DSH 插件页按包名安装，之后也能在插件页收到更新。发布要用 npm 上 `her-os` 组织的账号登录：

```sh
pnpm install
pnpm --filter @her-os/dsh-memory publish   # 先构建，再以公开包发布
```

发布前把 `packages/dsh/package.json` 的 `version` 改成新版本号。
