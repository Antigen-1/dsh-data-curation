# 资源限制冻结规则

本文件定义“何时可以开始故障测试”。每个候选必须先提交 `limits.json`，再注入故障；故障结果不达标时不得事后放宽。

## 冻结值

| 限制 | 默认/公式 | 观测层 |
|---|---|---|
| `wallTimeoutMs` | `2000` | 父进程/Worker 外层计时；到期终止实例并记 `TIMEOUT` |
| `maxOutputBytes` | `1000000` | 结果 JSON UTF-8 字节数 |
| `memoryBytes` | `ceil((idlePeak + 32 MiB) / 64 KiB) * 64 KiB` | 独立 supervisor 的 OS 级峰值；不是 Node heap 估计 |
| `schemeHeapBytes` | 候选实测最小可用值，写 `limits.json` | Chibi 的 Scheme heap |
| `wasmMaxMemoryBytes` | 候选实测最小可用值，写 `limits.json` | Emscripten `MAXIMUM_MEMORY`；Hoot 不假设适用 |
| `maxFuel` | 当前解释器默认值；候选无对应机制则标 `not-applicable` | VM 内指令/步骤预算 |

`idlePeak` 的测量：在同一 supervisor 配置下启动候选、完成最小 smoke，执行 100 次无分配调用，静置到 RSS 连续 2 秒波动小于 5%，取至少 5 次启动的最大稳定 RSS。记录 Node/OS/架构/构建 hash；跨机器绝对数字不横比。

## 为什么要独立 supervisor

Node `Worker.resourceLimits` 限制的是 JS heap，不是 Wasm linear memory，也不是 Wasm GC 的宿主内存。用 JS heap 上限冒充 Wasm 上限会产生假通过。因此：

1. 纯 CPU 超时可由 Worker + `terminate()` 处理；
2. 内存故障必须在独立 child/OS supervisor 中注入；
3. 主测试进程必须存活并记录结构化 `MEMORY_LIMIT`；
4. 终止后同一 supervisor 配置能启动新实例并完成一次正常 smoke。

完成判据：`results/<engine>/<version>/limits.json` 含上述字段、测量环境和“故障测试前冻结”的时间戳；`supervision.json` 证明主进程存活且新实例可服务。

## 分引擎备注

- **Hoot**：Wasm GC/堆由引擎管理；不能用 Emscripten `MAXIMUM_MEMORY` 假设。优先使用 OS supervisor 的地址空间/内存上限；若 Node 进程无法隔离，则该候选在资源门禁失败。
- **Chibi**：同时记录 Chibi heap 和 Emscripten `MAXIMUM_MEMORY`。两者任一先触发都映射为 `MEMORY_LIMIT`，并记录实际触发层。
- **Chez**：记录 pb VM 与完整 boot 的基线；不能只测 Petite-only 后冒充完整动态配置。内存触发层写入结果。

## 禁止

- 故障前没有 `limits.json` 就运行故障注入。
- 用 `--max-old-space-size` 的结果声称 Wasm 内存受控。
- 输出超限后截断内容并返回成功。
- OOM 后主测试进程死亡仍记为通过。
