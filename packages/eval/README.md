# @her-os/memory-eval

大库压测：生成一个有大量记忆和向量的临时数据库，测每轮回复前召回记忆的耗时（p50 / p95，不含向量服务请求）、事件循环最长停顿、内存和库体积。

```sh
pnpm --filter @her-os/memory-eval bench            # 默认 1 万条、1024 维
node packages/eval/src/bench.ts 50000 768          # 5 万条、768 维
```

检索效果（换说法能不能找到）的评测在 `packages/local-embed/bench/`，见仓库 README「语义检索」。
