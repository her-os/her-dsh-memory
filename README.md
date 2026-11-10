# her-dsh-memory

Her 的长期记忆插件，跑在 DeepSeek Harness（DSH）上。内部仓库，全部版本做完前不公开。

## 包

| 目录 | 包名 | 内容 |
|---|---|---|
| `packages/core` | `@her-os/memory-core` | 不依赖 DSH 的记忆库：建表、迁移，后续加检索、提取、生命周期 |
| `packages/dsh` | `@her-os/dsh-memory` | DSH bundle：Host 插件（`lib/index.js`）+ 浏览器端（`lib/client.js`）+ `cordis.patch.yml` |
| `packages/eval` | `@her-os/memory-eval` | 评估集和压测 |

## 开发

需要 Node ≥ 24.9 和 pnpm 11（`npx pnpm@11.28.5` 也行）。

```sh
pnpm install
pnpm build       # 构建 packages/dsh/lib
pnpm test        # 单元测试；构建后会多跑产物格式检查
pnpm typecheck
```

## 装到本机 DSH

先构建，再在 DSH 的插件页用本地路径安装（填 `packages/dsh` 的绝对路径），或在 DSH 对话里让它用 `plugin_manager` 安装这个路径。装好后在设置 → 插件里能看到“记忆”标签页。

数据库默认在 `$DSH_HOME/her-memory/memory.db`（没设 `DSH_HOME` 时是 `~/.dsh/her-memory/memory.db`）。

## 浏览器端构建

DSH 的浏览器端插件要按它的模块加载格式打包：整个文件是一次 `window.__ModuleLoader__.load({ id, factory })` 调用，共享模块通过注入的 `require` 取。DSH 自己的 `clientBundle` 预设没有发布，`packages/dsh/tsdown.config.ts` 照它重写了一份；只有 DSH 页面提供的平台模块（React、cordis、ui-slots 等）留作外部依赖，其余全部打进包里。
