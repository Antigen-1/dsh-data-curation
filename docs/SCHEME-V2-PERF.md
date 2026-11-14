# Scheme v2 性能与容量基线

## 方法

```powershell
node scripts/bench-scheme-v2.mjs 5000
```

脚本打开 `test/fixtures/scheme-v2/pin-v2-a.json`，串行调用 `runtime.call('rule.example')`，记录每次耗时、RSS、Wasm 线性内存字节，然后执行一次 `runtime.gc(5000)` 并重新记录内存。测试机为当前 Windows x64 开发机，Node 24，单进程、单 VM、无并发。

## 观测结果

H1（fd-backed stream + 二进制 TLV）后、修复规则过程缓存中的 `(environment ...)` 每次调用分配问题后，2 分钟连续调用：

```json
{"elapsedSeconds":30,"calls":381951,"errors":0,"rss":175984640,"wasmBytes":60424192,"p50Ms":0.07,"p95Ms":0.108,"p99Ms":0.148}
{"elapsedSeconds":60,"calls":760958,"errors":0,"rss":148570112,"wasmBytes":60424192,"p50Ms":0.074,"p95Ms":0.117,"p99Ms":0.156}
{"elapsedSeconds":90,"calls":1144015,"errors":0,"rss":195399680,"wasmBytes":60424192,"p50Ms":0.07,"p95Ms":0.109,"p99Ms":0.152}
{"elapsedSeconds":120,"calls":1526509,"errors":0,"rss":169111552,"wasmBytes":60424192,"p50Ms":0.075,"p95Ms":0.111,"p99Ms":0.152}
```

约 12,700 calls/s，p50 在 0.07ms 附近稳定，Wasm 保持 60.4MB，RSS 在 148–195MB 波动，0 error。此前 H1 后 5000 次为 4739 calls/s、p95 0.282ms；更早的 2 分钟 soak 出现 p50 从 0.98ms 升到 2.82ms 的退化，根因是 `pin-call` 每次调用都创建新的 `(environment ...)`；缓存规则过程时只保存 env spec、只在首次解析时创建 environment 后，退化消失。

## 1 小时长稳

修复后 detached soak（`3600000 30000`，PID 20536）完成 120 个 30 秒样本：

```json
{"samples":120,"elapsedSeconds":3600.9,"calls":34621517,"errors":0,"p50Ms":{"min":0.068,"max":0.107,"first":0.081,"last":0.093},"p95Ms":{"min":0.11,"max":0.433,"first":0.121,"last":0.215},"p99Ms":{"max":1.066},"rss":{"min":64847872,"max":219430912},"wasmBytes":{"min":60424192,"max":60424192}}
```

34,621,517 次调用、0 error；p50 在 0.068–0.107ms 区间，首末 0.081→0.093ms，已进入平台期；Wasm 恒定 60.4MB，RSS 在 64.8–219.4MB 间随 GC 波动，没有单调增长。该结果只覆盖单进程、单 VM、串行纯规则调用。

## 短时连续调用观察（H1 前历史数据）

以下 2 分钟数据是 H1 之前、仍走 stdin/stdout 桥时的退化观察，保留作为对照；不能代表当前 fd+TLV 路径。

```json
{"elapsedSeconds":30,"calls":47100,"errors":0,"rss":137510912,"wasmBytes":60424192,"p50Ms":0.988,"p95Ms":1.272,"p99Ms":1.47}
{"elapsedSeconds":60,"calls":70164,"errors":0,"rss":141164544,"wasmBytes":60424192,"p50Ms":1.386,"p95Ms":1.816,"p99Ms":1.976}
{"elapsedSeconds":90.1,"calls":88193,"errors":0,"rss":143163392,"wasmBytes":60424192,"p50Ms":1.701,"p95Ms":2.116,"p99Ms":2.322}
{"elapsedSeconds":120.1,"calls":103789,"errors":0,"rss":134291456,"wasmBytes":60424192,"p50Ms":1.947,"p95Ms":2.314,"p99Ms":2.599}
```

这是**H1 前连续调用下的退化观察**，不是稳定吞吐。修复 `(environment ...)` 每次分配后，同样的 2 分钟窗口到达 1,526,509 次、p50 0.075ms、p95 0.111ms；1 小时结果见上一节。

## 指标开销 A/B

`node scripts/bench-scheme-v2-overhead.mjs 3000 100` 用交错 A/B（每轮 baseline 与 measured 顺序交替，每 100 次调用读一次 `metrics()`）：

```json
{
  "iterations": 3000,
  "sampleEvery": 100,
  "sampled": 30,
  "baseline": {"p50Ms": 0.216, "p95Ms": 0.303, "p99Ms": 0.36},
  "withMetrics": {"p50Ms": 0.215, "p95Ms": 0.304, "p99Ms": 0.384},
  "p95Overhead": 0.0033,
  "rss": 129671168,
  "wasmBytes": 60424192
}
```

按周期采样时 p95 开销 0.33%，在 5% 预算内；此前每次调用都读 `metrics()` 的 18.8%–23.2% 是未交错、冷启动/漂移混合的最坏情况，不作为生产采样方式。内部计数器本身每次调用都更新，开销未单独关闭对比。

## supervisor 与故障矩阵

- `CvmSupervisor` 用独立 Node 子进程承载 `CvmClient`；父进程只负责 spawn、单请求调度、超时 kill、restart 和 close。
- `SchemeV2Runtime.open(pin, { supervised: true, ffiModules })` 在子进程内预加载/执行 FFI；provider 超时终止子进程，父进程保持存活并可 restart。
- 已覆盖故障：子进程被 kill 后父进程存活并可 restart；并发 restart 返回 `E-VM-BUSY`；已退出子进程 close 仍可 resolve；子进程初始化失败时 open reject 且 close 可结束；FFI provider abort、reused requestId、malformed frame、host timeout。
- Wasm 构建固定 `-s MAXIMUM_MEMORY=536870912`（512MiB）；live-set 超限测试通过 `(oom)` 触发 Emscripten abort，`dispatch` 以 `E-VM-ERROR: Aborted()` fail-closed，随后 `close()` 可完成。当前无法在 abort 前区分“可回收耗尽”和“live-set OOM”，只能在容量规划中按高水位预留。
- `runtime.gc()` 执行 `collect` 并返回 GC 后 RSS/Wasm 字节；Wasm 线性内存不收缩，容量规划按高水位。

## 混合负载 smoke（H1.5 后）

`node scripts/bench-scheme-v2-mixed.mjs` 同时打开 static/plugin/program/ffi 四个 runtime，按 70%/20%/10% 轮转，并在每 10 次调用中插入一次 FFI。发布前 10 分钟结果：

```json
{"durationMs":600050,"calls":387037,"staticCalls":270928,"pluginCalls":77406,"programCalls":38703,"ffiCalls":38704,"errors":0,"samples":20}
```

RSS 从 358MB 升至 420MB 后 GC 回落至 174MB，末段 243MB；Wasm 恒定 60.4MB。`lastMs` 2.34–17.06ms，无持续恶化。该脚本只记录窗口内最后一批耗时，不是 p95 分位；完整混合 1h 为发布后验证。

## 解读与边界

- 1 小时长稳已完成：34,621,517 次、0 error、p50 0.068–0.107ms、Wasm 恒定 60.4MB；RSS 随 GC 波动但不单调增长。
- GC 后 RSS/Wasm 字节基本不下降；Emscripten 线性内存不收缩，容量规划必须按高水位而不是 GC 后 live set 估算。
- `runtime.metrics()` 暴露 `calls/errors/gcs/staticRules/dynamicRules/plugins/programs/restarts/errorCodes`、`latencyMs` 30 秒窗口与 `rss/wasmBytes`；按周期采样 p95 开销 0.33%，不要每次调用都读。
- 单 VM 串行调用；supervisor 重启、FFI 超时和 provider 拒绝已有测试，但未测并发队列或大规模 FFI 流量。
- 这些数据只用于容量起点，不构成生产 SLA。

## 待补

- 并发/队列压力、supervisor 重启开销、FFI 流量基线。
- 指标开销 A/B 已按周期采样测得 0.33%；未做内部计数器关闭对比。
