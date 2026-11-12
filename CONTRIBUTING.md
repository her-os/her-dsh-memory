# 参与贡献

欢迎提 Issue 和 Pull Request。

## 开始之前

- 大一点的改动（新功能、改变记忆的记法或提起方式）先开 Issue 说清楚想法，避免白做。
- 小修小补可以直接提 PR。

## 本地开发

需要 Node ≥ 24.9 和 pnpm 11，命令见 [README](README.md#开发)。提 PR 前请确认：

```sh
pnpm typecheck
pnpm build
pnpm test
```

改了记忆页界面或插件和 DSH 的交互时，再跑 `pnpm test:e2e`（需要本机有 Chrome）。

## PR 要求

- 一个 PR 只做一件事，说明改了什么、为什么改、怎么测的。
- 行为有变化时补上对应测试。
- 界面上的文字中英文都要有（`packages/dsh/src/client/locales.ts`）。
- 提交代码即表示同意以 [MIT 许可证](LICENSE) 发布。
