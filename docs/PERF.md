# 规则执行性能基线（0.12.0）

这是一份**本地微基准**，只测 `adjudicate` 的逐格裁定路径，不含 SQLite 写入、verify、
启动或宿主开销；不能直接外推为端到端验收时间。

环境：Linux、Node v24.18.0，单进程。数据：500 条记录 × 2 字段 = 1000 格，每格两个
有效通道（text/vision），值一致、证据齐备。每项先预热 2 次，再取 5 次 wall time 的
中位数。

| 路径 | 中位数 | 每格 |
| --- | ---: | ---: |
| 原生双通道（无 decision 规则） | 9.4 ms | 0.0094 ms |
| 自定义 decision 规则（accept-first） | 65.0 ms | 0.065 ms |

自定义规则约为原生路径的 **6.9x**；按此微基准线性外推，5000 格约 0.33 s。规则逐格
`await` 且每次调用都做输入/输出校验，这是当前主要开销。0.12 没有为 decision 启用
worker 隔离（每格 worker 启动成本远高于规则本身）。

复现：

```bash
node scripts/bench-rules.mjs
RECORDS=1000 node scripts/bench-rules.mjs
```

0.12 验收只要求“可复现基线 + 不劣化到不可用”；端到端 5000 格目标留到接真实工作区时
单独测量。
