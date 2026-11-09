# ADR-0001: Scheme → Wasm 运行时候选

- Status: **Proposed — 仅探索结论，不批准生产迁移**
- Date: 2026-11-08
- Baseline: `dsh-data-curation` `a0d5a4d082539460a3d841764c28b6b8043567dc` / `v0.18.0`
- Scope: 执行语义、最小动态能力、隔离边界与分发形态
- Out of scope: v1 JSON AST 桥、canonical `ruleHash`、pin descriptor、生产替换

## 决策

本轮**不选择任何引擎替换生产解释器**。保留当前 JS 解释器作为唯一生产运行时。

若用户另行批准下一轮探索，优先顺序为：

1. **Chibi-Scheme 0.12**：唯一同时满足最小动态 eval、guest 内注册、基本隔离、JSON 协议和已阻断 JS 逃逸的候选；标记为 `pure-dynamic`。
2. **Guile Hoot 0.10.0**：只保留为固定可信规则的 `fixed-aot` 候选；动态 eval 未通过。
3. **ChezScheme 10.4.1**：条件候选；最小动态能力通过，但 R6RS 合同、Scheme datum 传输和 boot/VM 复杂度使其不占优；标记为 `pure-dynamic` 但建议停止继续封装，除非出现明确的 R6RS 需求。

这不是生产选型，也不是“Wasm 已完成”的声明。

## 证据摘要

全部证据位于 `experiments/wasm/results/`，原始 corpus 为 `fixtures/corpus.json`（31 项），当前解释器 oracle 为 31/31。

| 引擎 | 形态 | 最小 smoke | 完整 corpus | 结论 |
|---|---|---|---|---|
| Guile Hoot 0.10.0 | whole-program Scheme → Wasm GC | fixed-aot 通过；pure-dynamic 失败 | 未运行（动态入口失败） | `fixed-only` |
| Chibi-Scheme 0.12.0 | C VM + Emscripten Wasm | 3/3 通过 | 15/31 | `pure-dynamic` |
| ChezScheme 10.4.1 | pb bytecode VM + Emscripten Wasm | 3/3 通过 | 16/31 | `pure-dynamic`，条件候选 |

### Hoot

直接证据：

- `fixed-guest.wasm` 的 `dispatch.call` 正确返回 `true`/`false`。
- 动态 eval 在 `load_main` 中抛 `SchemeTrapError`，tag 为 `$invalid-continuation`；即使使用 `--r7rs -fruntime-modules -fmutable-defs` 也未通过。
- `results/hoot/0.10.0/smoke.json` 记录 `verdict: fixed-only`。

判断：适合固定可信规则 AOT，不适合当前“运行时接收源码并注册规则”的路径。`hoot repl` 可用不代表 compiled guest 可复用该 REPL。

### Chibi

直接证据：

- 最小 smoke 3/3：eval 41→42、guest 内注册并 call、isolated eval。
- 31 项 corpus 15/31；通过的包括 R6RS 真值、闭包、局部 `set!`、named let、尾递归、JSON roundtrip、输出/超时。
- 失败集中在插件专属库/宏、错误码映射、helper 注册、duplicate 原子性和 capture mutation，不是启动或动态 eval 失败。
- 原版 `(chibi emscripten)` 可执行任意 JS；已把该库改为无导出并重建，`eval-script!` 逃逸测试失败为 `undefined variable`。
- Wasm imports 只有 `env` 与 `wasi_snapshot_preview1`（62 项），无 eval/script imports。
- 资产约 4.2 MB；`make js` 使用 Emscripten 3.1.6。
- `results/chibi/0.12.0/smoke.json` 记录 `verdict: pure-dynamic`。

判断：动态路径最有希望，但还需要窄 ABI、库裁剪、完整错误码、跨请求状态、内存上限和异步 FFI。

### Chez

直接证据：

- 最小 smoke 3/3：eval 41→42、guest 内注册并 call、isolated eval。
- 31 项 corpus 16/31；比 Chibi 多通过一项，但仍缺少当前 DSL 库和稳定错误码。
- `(eval ... (interaction-environment))` 在完整 `petite.boot` + `scheme.boot` 下可用；资产约 4.0 MB。
- 官方 Emscripten 路线是 pb VM，不是原生 Wasm 代码生成器。
- 当前 host→guest 传输是 Scheme datum，不是 guest 内 JSON parser；这弱于统一 JSON contract，已在 smoke 中记录。
- 安全 imports 只有 `env`/`wasi_snapshot_preview1`（50 项），未发现 eval/script import。
- `results/chez/10.4.1/smoke.json` 记录 `verdict: pure-dynamic`。

判断：能跑动态 eval，但传输协议和 R6RS 取向不符合当前 R7RS/JSON 合同；没有 Akku 库依赖，因此未引入空 `Akku.manifest`。若没有明确 R6RS 需求，建议停止。

## 硬门禁状态

| 门禁 | Hoot | Chibi | Chez |
|---|---|---|---|
| Node 24 加载 | 通过（fixed） | 通过 | 通过 |
| 无默认宿主 JS 逃逸 | 未发现 guest eval import | 已阻断 `(chibi emscripten)` | 未发现 eval import |
| 动态 eval | 失败 | 通过 | 通过 |
| guest 内注册 | 未验证（动态入口失败） | 通过 | 通过 |
| 死循环/输出超时 | 未测 | 通过（进程边界） | 通过（进程边界） |
| 内存上限/OOM supervisor | 未测 | 未测 | 未测 |
| 异步 FFI | 未测 | 未测 | 未测 |
| 完整资产可离线运行 | 未验证 | 本地资产可运行 | 本地资产可运行 |
| 双构建可复现 | 未验证 | 未验证 | 未验证；环境有仓库外调整 |
| 许可证/NOTICE 审计 | 未完成 | 未完成 | 未完成 |

因此没有引擎通过全部 `pure-dynamic` 硬门禁，故不能进入生产。

## 未决问题

1. **内存治理**：三引擎都还没有按 `LIMITS.md` 固定 `memoryBytes`，也没有 OOM supervisor 实测。
2. **异步 FFI**：Hoot `call_async`、Chibi/Chez Asyncify/JSPI/CPS 都未实测；不得靠消息协议推断支持。
3. **协议一致性**：Chez 的 host→guest 传输不是 JSON；Chibi/Chez 都还是一次请求一个子进程，缺少跨请求状态。
4. **语义桥**：本轮刻意不生成 v1 AST/pin；任何生产替换都必须另做 v1 桥或 source-native 身份迁移。
5. **可复现构建**：Chibi/Chez 使用容器 apt 的 Emscripten 3.1.6；Chez 还修改了容器内 Emscripten 缓存配置和 `Mf-config` 输出后缀。这些调整尚未形成仓库内可重放脚本。
6. **供应链**：资产尚未做双构建 hash、完整许可/NOTICE、SBOM 和离线消费验证。

## 追加结论：独立 RPC server / worker（2026-11-08）

用户要求进一步测试：能否把 Chibi/Chez 做成独立 RPC server（独立进程或 worker），由它接管整个规则层向上层提供服务。结论是：

**可以做出“每请求无状态的 Wasm 执行 RPC 服务”原型，但当前不能接管整个规则层。**

### 已经实测可用的部分

原型：

- [rpc/service.mjs](rpc/service.mjs)：Node HTTP 服务，`POST /rpc`，按 `engine` 选择 Chibi 或 Chez；复用现有 adapter，每次请求启动一个 runtime。
- [rpc/test.mjs](rpc/test.mjs)：真实启动服务并发出 HTTP 请求。

实测结果：**PASS**，9 项检查通过。

| 检查 | 结果 |
|---|---|
| `GET /health` 列出 chibi/chez | 通过 |
| Chibi eval `(lambda (x) (+ x 1))` 41 | 42 |
| Chez eval 同一表达式 41 | 42 |
| Chibi `load-module` 注册并调用 | 7 |
| Chez `load-module` 注册并调用 | 7 |
| 下一个 Chibi 请求读取上一条规则 | `UNBOUND_RULE`，状态丢失 |
| Chibi 死循环，wall timeout 150ms | `TIMEOUT` |
| 超时后新 Chibi 请求 | 成功 |
| 两个 Chibi 请求并发 | 都返回 42 |

因此，“独立 Node 进程 + HTTP/JSON RPC + 子进程隔离 + 超时后重启”的**执行服务**形态可行。

### REPL 作为 RPC 协议栈：不可直接使用

实测了两种方式：

- [chibi/rpc-server.mjs](chibi/rpc-server.mjs)：保持一个 Chibi Wasm VM，循环读取 stdin 的 JSON 行。
- [chez/repl-probe.mjs](chez/repl-probe.mjs)：保持一个 Chez REPL，向 stdin 写 Scheme 表达式。

结果：

- **批量输入可以保持状态**：把 5 条请求一次性写入并关闭 stdin，Chibi 同一个 VM 返回 5 条响应；规则计数器依次为 1、2、3，重复注册被拒绝且原规则状态保留（[chibi/rpc-batch-test.mjs](chibi/rpc-batch-test.mjs)）。
- **交互式行协议不可用**：stdin 管道保持打开时，Chibi 和 Chez 都不返回任何响应；直到关闭 stdin（EOF）才一次性输出。Chez 即使显式 `flush-output-port` 并同时写 stderr，也仍然只在 EOF 后输出。

结论：当前 Emscripten 构建下，REPL 只能当**批量 VM**，不能直接作为逐请求 RPC 协议栈。若坚持 REPL 路线，需要 PTY、定制 stdin bridge 或改写嵌入层；本轮没有证明它们在 Node/Windows 下可用。

### 不能接管“整个规则层”的原因

不是传输层单点问题，而是规则层契约缺口：

1. **pin 与哈希**：生产 pin 持久化 v1 JSON AST，并要求 `checkRule/compileRule/ruleHash/normalizePinRules`。当前 guest 只接受 Scheme 源码，不暴露 compile/check/hash/AST bridge；不能把现有 pin 直接交给它执行。
2. **库与语义**：当前 guest 是探索版，Chibi corpus 15/31、Chez 16/31；缺插件 stdlib、宏、完整错误码、duplicate/capture 语义。它还不是完整规则层。
3. **FFI**：生产解释器是 async trampoline，FFI 调用是异步的；当前两个 guest 没有 async FFI 桥，不能挂起/恢复、取消或丢弃 late response。
4. **状态与生命周期**：HTTP 服务每请求新建 runtime，注册状态丢失；批量 VM 有状态但不是 RPC。要两者兼得需要持久 VM 协议或规则重放/序列化。
5. **资源与协议**：Chibi 超时后能重启，但没有 memory/OOM supervisor；超时响应还缺 request id/protocolVersion；Chez 的嵌套 `run.cjs` 生命周期需要单独验证进程树清理。
6. **安全边界**：Chibi 的任意 JS 逃逸已阻断，但“无逃逸”不等于可安全承载不可信规则；仍需内存、CPU、输出、FFI 权限和模块加载白名单。

### 可行的分层方式

如果仍要服务化，建议先做**Node rule gateway**，而不是让 Wasm 接管全部：

```text
上层
  ↓ JSON RPC / Worker
Node rule gateway
  ├─ 规则注册、compile/check、source/normalize、hash
  ├─ pin descriptor 与角色约束
  ├─ FFI 编排、超时、取消、审计
  └─ Wasm guest（只做纯求值/纯谓词执行）
```

这样能保留现有 pin/hash 合同和 async FFI，Wasm 只承担无副作用的执行；它仍不是“整个规则层替换”。真正的整层接管需要另立 source-native 规则格式（v2）、source hash、FFI 挂起/恢复协议、持久 VM 和新的验收套件，工作量与风险都高于本轮探索。

### RPC 结论对选型的影响

不改变前文决策：

- 生产继续使用当前 JS 解释器。
- Chibi 仍是 pure-dynamic 的首选探索对象，但必须先补 JSON C ABI、持久/重放协议、内存/OOM、异步 FFI 和完整 stdlib。
- Hoot 仍是 fixed-aot 候选；Chez 仍是 R6RS 条件候选。
- “独立 RPC server 原型可运行”不等于“规则层可迁移”。

证据汇总：[results/rpc-feasibility.json](results/rpc-feasibility.json)。

## 后果

- 生产 `lib/rules/`、pin、hash、发布流程保持不变。
- 本轮只能作为运行时探索证据，不能作为“Wasm 替换完成”。
- RPC 原型只支持无状态执行服务；状态化规则服务、pin 迁移和异步 FFI 仍未实现。
- 若继续，先批准一个更窄的 Chibi 硬化阶段：JSON C ABI、最小库集合、内存/OOM、异步 FFI、双构建与许可审计。
- 若目标是固定可信规则，可另立 Hoot fixed-aot 探索，但不得混入动态注册路径。
