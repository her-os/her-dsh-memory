# Her 记忆

DeepSeek Harness（DSH）的长期记忆插件：自动记住聊天里的重要信息，下次对话时自然想起。由北京词元共振智能科技有限公司开发，了解 Her：https://hersoul.cn/zh

## 它做什么

- **记下来**：每 3 轮对话、停下 5 分钟或关闭会话时，自动从对话里整理出值得记住的事；说「记住……」会立刻记下。看起来像密码或密钥的内容不会被记。
- **想起来**：回复前按关键词找相关记忆，开启语义检索后也按意思找；置顶的记忆每次都会带上。
- **你说了算**：在设置 → 插件 → 记忆页里查看、搜索、编辑、置顶、删除记忆，也可以暂停学习；叫 Her 忘掉的事不会再记。

## 数据在哪

记忆存在本机 `$DSH_HOME/her-memory/memory.db`，不会上传给 Her。对话模型只看到和当前对话相关的几条。整理记忆时会把对话片段发给你在 DSH 里配置的模型；用云端语义检索服务时，记忆文本会发给该服务。

## 语义检索

默认关闭，只用关键词检索。在记忆页点「开启本机语义检索」后，会在本机下载 ONNX Runtime 和向量模型，之后按意思也能找到记忆；也可以在设置里改用兼容 OpenAI 接口的云端向量服务。

本机模型在用户电脑上下载，不随插件分发。默认模型 EmbeddingGemma 受 Google [Gemma 使用条款](https://ai.google.dev/gemma/terms) 约束；BGE small 中文、multilingual-e5-small、BGE-M3 为 MIT 许可。

## 安装

在 DSH 的插件页按包名 `@her-os/dsh-memory` 安装，或执行 `dsh plugin add @her-os/dsh-memory`。桌面版装好后完全退出再打开，然后在设置 → 插件里打开「记忆」标签页。从源码构建见[仓库 README](https://github.com/her-os/her-dsh-memory#readme)。

## 许可证

MIT
