# Chez 实验证据台账（G0）

**Purpose:** 把“有文件”与“目标已证明”分开。任何后续结论必须能追到本表中的证据、命令和证明边界。
**Baseline:** `a0d5a4d082539460a3d841764c28b6b8043567dc`（v0.18.0）
**Ledger updated:** 2026-11-09
**Engine:** Chez Scheme `v10.4.1`, source commit `e95a7efbafa2cf3bd5343ea542e6bc909a7ab2c4`, Chez pb-wasm.
**Runtime environment:** Windows 11 x64; Node `v24.21.0`; bundled Node path `C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`.
**Workspace:** repository root `dsh-data-curation`; all paths below are repository-relative.

## Status vocabulary

| Status | Meaning |
|---|---|
| PASS | 所述范围有独立结果文件或可重复命令，且结果覆盖该范围。 |
| PARTIAL | 有真实结果，但只覆盖窄范围；不得外推到生产目标。 |
| FAIL | 在指定门禁上失败；不得用其他窄测试抵消。 |
| UNVERIFIED | 只有源码、计划或终端回显，没有独立结果文件。 |
| BLOCKED | 当前环境无法执行；必须记录具体阻塞，不得记作通过。 |

## Evidence ledger

| Evidence | Status | Proven | Not proven / next action |
|---|---|---|---|
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/evidence/sha-vectors.json:1-17` | PASS (narrow) | 空串、`abc`、长向量的 Scheme SHA-256 与 expected 一致。 | 不证明 canonical tree、reader 或生产 loader。 |
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/evidence/source-tree-plugin.json:1-32` | PARTIAL | 少量 canonical 向量、简单规则/插件调用、重复 id 计数。 | 未覆盖完整 tag/数值/Unicode/依赖图/隔离/pin。 |
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/code/test-source-tree.mjs:70-78` | PARTIAL | 对 guest 输出的 `canonicalHex` 做 Node SHA-256，与 guest hash 比较。 | 不是独立 canonicalizer；AC-T4 未满足。 |
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/code/source-tree.scm:3,75-87,245-274` | PARTIAL / 不符合目标 | 原型能读取、注册、eval、调用。 | 使用 `(chezscheme)`、Chez `read`、`interaction-environment`；registry 实际签名 `(id version api)` 与计划不一致。 |
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/evidence/namespace.json:1-10` | PARTIAL | 一个窄 environment 中 `+` 可用，部分 binding unbound。 | 不证明完整 R6RS 或统一 resolver。 |
| `experiments/wasm/results/chez/10.4.1/r6rs-coverage.json` | PARTIAL | 少量 `(rnrs)`/`(rnrs eval)` binding 探测，列 25 个分项库 + 复合库名。 | 不是逐库 import/行为 matrix；该结果未进入原审阅包 MANIFEST 的文件清单。 |
| `experiments/wasm/results/chez/10.4.1/corpus.json` | FAIL (compatibility gate) | 31 项中 16 通过、15 失败；失败类别见该文件。 | 必须逐项 triage；G2 未过前禁止任何 FFI 试验。 |
| `experiments/wasm/results/rpc-feasibility.json:24-30,40-60` | 不满足在线目标 | one-process/request RPC 可行；Chez REPL 在 stdin EOF 后才输出。 | 无长期在线、FFI、memory limit；不能接管规则层。 |
| `experiments/wasm/chez/probe-fs.scm`, `experiments/wasm/chez/probe-libdir.scm` | UNVERIFIED | 存在 MEMFS/library path probe 源码。 | 未找到独立结果 JSON；不得写成“已通过”。 |
| `experiments/wasm/reviews/chez-source-tree-plugin-2026-11-08/MANIFEST.json:1-150` | baseline | 原包资产、代码、plan 哈希和未验证项。 | Revision 5 不在原包内；原包不得静默改写。 |
| `experiments/wasm/results/chez/10.4.1/online-vm.json` | PASS (observable semantics) | 同一 Chez WASM 实例连续处理 4 个请求，无 EOF；状态 42→42→43→43；requestId 唯一；显式长度帧；只在响应后见 eof；worker exit 0、stderr 空。 | 传输层是 Node Worker + SharedArrayBuffer 设备桥，不是计划中的 C ABI `dsh_dispatch`；payload 当前限 ASCII；不能宣称 C ABI 已实现。 |
| `experiments/wasm/results/chez/10.4.1/limits.json` | PASS (bounded scope) | 同一 host 进程内 5 次 fresh Worker 启动，idle RSS 最大 117719040 B，Wasm heap 16777216 B；按 LIMITS 公式冻结 `memoryBytes=151322624`、`wallTimeoutMs=2000`、`maxOutputBytes=1000000`。 | 5 次不是 5 个独立 OS 进程；RSS 是 host+worker 进程值；生产 OS supervisor 仍需在 Phase 6 复测。 |
| `experiments/wasm/results/chez/10.4.1/supervision.json` | PASS (timeout/crash) | timeout 后 terminate（约 2269 ms），主测试进程存活；guest `(exit 7)` 后新实例 state=0 并可继续 set=11；timeout 后新实例同样 state=0。 | OOM 另见 `oom.json`；timeout 是 host 2.2 s 主动 terminate，不是 guest 自行超时。 |
| `experiments/wasm/results/chez/10.4.1/oom.json` | PASS (memory-capped) | 把 Wasm memory max 从 32768 页裁到 1024 页（64 MiB）后，`make-vector 100000000` 触发 `RuntimeError: Aborted()`；host 存活，新 capped 实例 `get` 返回 0。 | 这是人工裁剪 Wasm 的内存上限；生产 build 的 memory cap/supervisor 仍需 Phase 4/6 决定；不是自然 OS OOM。 |
| `experiments/wasm/chez/online-vm.scm`, `online-vm-worker.cjs`, `online-vm-client.mjs`, `test-online-vm.mjs`, `measure-limits.mjs`, `test-supervision.mjs`, `test-oom.mjs` | implemented (legacy transport) | 同进程在线 VM、帧协议、SAB 设备桥、limits、timeout/crash/OOM 测试脚本。 | 这是 C ABI 之前的过渡传输；正式 C ABI 证据见下一行。 |
| `experiments/wasm/chez/online-vm.c`, `online-vm-c.scm`, `build-online-vm-c.sh`, `test-online-vm-c.mjs`, `online-vm-c-worker.cjs`, `test-online-vm-c-supervision.mjs`, `measure-limits-c.mjs` | PASS (C ABI transport) | `dsh_init`/`dsh_dispatch`/`dsh_out_ptr`/`dsh_out_len` 导出并由 Node 直接调用；同一实例 4 请求 `42→42→43→43`，stderr 空；timeout 后 worker terminate 且新实例 state=0；guest `(exit 7)` 报 code 7，新实例 state=0 后可 set=11；5 次 fresh Worker，idlePeak=131563520 B，按公式冻结 `memoryBytes=165150720`。 | C ABI 是 JS→Wasm 导出，不是原生 ABI；同步 dispatch 无抢占，timeout 依赖 Worker terminate；C ABI 的 OOM 尚未单独测；payload 目前是 Scheme request datum，非 JSON 请求。 |
| `experiments/wasm/chez/source-tree-reader.scm` | implemented | 使用 Chez `read` 读成 datum，再校验类型、proper list、cycle、深度/长度/节点数；canonical tags 与 `treeHash` 域固定。 | 资源限制是 `read` 后检查；reader-time 崩溃只能靠 supervisor containment。 |
| `experiments/wasm/results/chez/10.4.1/reader-oracle.json` | PASS (valid + edge) | 独立 Node parser/encoder 生成 expected；valid 29/29、edge 20/20；29 个相同 datum 的 `treeHash` 与旧 reader 一致；guest stderr 空；每个 edge 带 `(source-error code message rule-id line column "v2")` 诊断。 | edge 只覆盖已列 20 个案例；不证明完整 R6RS 或生产 loader；line/column 是 form 起点，不是精确 token 位置。 |
| `experiments/wasm/chez/SOURCE-TREE.md`, `experiments/wasm/results/chez/10.4.1/source-tree.json`, `experiments/wasm/results/chez/10.4.1/reader-negative.json` | PASS (spec + negative) | 固化 tag/长度/real/char/quote 归一、hash domain、资源限制、诊断字段；负例覆盖 E-READ/E-DOTTED/E-DATUM 与 readable 边界；20/20 诊断字段通过。 | `SOURCE-TREE.md` 明确 null 不是 Scheme read datum；JSON null 仅是 guest 运行时哨兵，不进入 source tree。 |
| `experiments/wasm/chez/gc-probe.scm` | PASS (GC present) | `collect` 已绑定；40 轮 × 10,000 个 1000 元素 vector 的分配/回收完成，输出 `GC-PROBE-OK`。 | 仅证明 Chez runtime GC 在跑；Wasm linear memory 上限与 Chez heap 是两层，`oom.json` 仍是人工 64 MiB cap 的结果。 |
| `experiments/wasm/chez/guest-v2.scm`, `experiments/wasm/chez/run-corpus-v2.mjs` | PASS (experimental corpus) | 31/31 corpus 通过；读入为 `read`+validator，JSON null 用独立标记，对象/组合子/注册表回滚/排序均覆盖；`semantic.error.unbound` 输出 `UNBOUND_VARIABLE` 且 path 为 `$[2][0]`。 | `resource.timeout` 的 150 ms 与 `resource.output-limit` 的 64 B 由 host runner 强制执行，不是 guest 自证；`$[2][0]` 是 eval 源包络路径，不是精确 AST 位置；不构成 v1 生产语义批准。 |
| `experiments/wasm/chez/plugin-loader.scm`, `plugin-loader-test.scm`, `run-plugin-isolation.mjs` | PASS (experimental plugin isolation) | 23/23 loader cases 通过：重复 plugin/library、拒绝 `(chezscheme)`、missing export、treeHash mismatch、失败后 registry 不增长、跨 library import、bundleHash 的 source/import/version 变化检测、poison 后 `plugin-call` 拒绝；A/B 同 id 不同版本在两个独立 incarnation 分别返回 42/43。结果 `experiments/wasm/results/chez/10.4.1/plugin-isolation.json`。 | 使用 legacy Worker/SAB transport；`interaction-environment` 仍用于注册 `library` form（项目调用走不可变 environment）；项目插件禁止 `(rnrs (6))`（会重新导出 raw eval），只能显式 import 分项库；动态 `(rnrs eval)` 已改写为 safe wrapper，见下一行；不构成生产 loader 批准。 |
| `experiments/wasm/chez/plugin-loader.scm`（safe eval） | PASS (scoped) | 项目源码中的 `(rnrs eval (6))` 改写为 `(dsh safe eval (6))`；`environment` 只接受 25 个显式 R6RS 库与 `(dsh ...)` 项目库；`(chezscheme)` 动态导入被拒；允许 `(rnrs base (6))` 的 eval 返回 3。 | `(rnrs (6))` 复合库在项目插件中被拒绝；这是为避免 raw `eval`/`environment` 泄漏的显式 scope 限制。safe wrapper 不是原生 OS 边界。 |
| `experiments/wasm/results/chez/10.4.1/r6rs-library-matrix.json` | PASS (matrix scope) | 25 个分项库 + `(rnrs (6))` 复合库共 26 项，每项独立 Worker import 并执行代表表达式，26/26 PASS。 | 只证明 import 与代表行为；不证明每库完整语义、资源边界或项目插件可用全部库。 |
| `experiments/wasm/results/chez/10.4.1-c/memfs.json` | PASS (C ABI MEMFS, write-containment scope) | 项目文件由 JS 挂载后可见、项目根写入被拒、`/out` 写读成功、`outSize=2`、`outCount=1`；host FS guard 对 `/project` 写入、unlink/rename/chmod 等拒绝。 | 读范围是“仅看到 JS 显式挂载的 MEMFS 文件”，不是跨根读拒绝；secret/穿越/跨项目读的旧断言因文件未挂载、实际靠 ENOENT 通过，已从测试移除。只读/写拦截来自 host JS 守卫；C `dsh_mount_file` 的 chmod 未被 Emscripten 强制执行，不能把 C 函数本身当作边界。 |
| `experiments/wasm/results/chez/10.4.1-c/memfs-quota.json` | PASS (quota negative) | `/out` 写入在 65536 B 处被 host FS guard 拒绝（ENOSPC），文件数为 1，guest 捕获为 `quotaDenied=true`。 | 配额是 host 侧写拦截，不是 guest 自证；文件数上限 8 尚无负例。 |
| `experiments/wasm/results/chez/10.4.1-c/plugin-ab-c.json` | PASS (C ABI A/B) | 同一 C ABI engine 的两个独立 Worker incarnation 分别加载 `demo` v1/v2，返回 42/43，registry 不共享。 | A/B 只覆盖单进程内 Worker 隔离；不证明跨 OS 进程或生产项目级隔离。 |
| `experiments/wasm/chez/online-vm-c.scm`（阻塞 `ffi-call`） | PASS (blocking scope) | `dsh-dispatch` 写出严格 JSON 的 `DSH-FFI` 帧后在 stdin 阻塞；宿主解析 JSON、校验字段 schema、生成 requestId 并写回 `(ok ...)`/`(error ...)`；同一 C `dsh_dispatch` 调用栈继续并返回最终 JSON。`math.add`=3、`delay.echo`=hello、`math.fail`=E-FFI-HOST、`delay.slow` 在 100 ms 超时=E-TIMEOUT；注入 `id="id\tx"`、`rid="rid\ny"`、`rule="rule\tz"` 保持单帧。结果 `experiments/wasm/results/chez/10.4.1-c/{host-bridge,blocking-ffi,blocking-broker,incarnation-timeout}.json`。 | 不是 continuation resume：同一 VM 阻塞期间不能处理第二个 dispatch；timeout 由 host broker/Worker 监督并销毁 incarnation，不是 guest 抢占；未单独证明 nested FFI 或 FFI 内 guest crash。最终资产 hash（F1–F8 整改完成）：js `5957c85d022a55058ae4e94668ce792010834f77065f8439cde3e967b0eb7713`，wasm `b0aa6503c7642f3b09da229569b1cc5f9ff8ec8e01b18fb5a57b90ab5e6deceb`，data `0a510371bf6c352840c78c971ea47815cc7014dc568155f1751162a9de71538a`。`engineArtifactHash=sha256:c9b7e03d8f26bb7343c4c83594c6c10407be23e69713ce51149515dee139da9a`；`pin-v2.json` 基于该闭包。 |
| `experiments/wasm/chez/online-vm-c.scm`（旧 two-phase，历史） | SUPERSEDED | 旧实现保存 pending 并返回 `status=suspended`，`dsh-resume` 恢复；`mechanism.json` 证明跨 `Scall1` 的 live continuation 会终止进程。 | 保留仅作历史证据，不再作为 G4 口径。 |
| `experiments/wasm/chez/host-capabilities.mjs` | PASS (three capabilities) | `project.read` 只接受 `/project/` allowlist；`log.write` 写审计；`clock.now` 返回时间且标记 `nondeterministic=true`；每条审计含 requestId/ruleHash/argsHash/resultHash/duration/error。 | 不是 OS capability 边界；`log.write` 只写实验审计，不接生产日志；`project.read` 的 allowlist 由测试注入。 |
| `experiments/wasm/chez/ffi-manifest.json`, `ffi-registry.mjs` | PASS (manifest scope) | manifest 只含逻辑 module/function/arity/mode；含 `path`/`module` 的 manifest 被拒绝；未知 module/function、arity 错误、缺失 handler 均拒绝；handler 绝不从项目路径 import。 | 仅实验 registry；未接生产 `lib/ffi-loader.js`，未做真实原生 FFI。 |
| `experiments/wasm/chez/ffi-broker.mjs`, `c-vm-client.mjs`, `test-host-capabilities.mjs`, `results/chez/10.4.1-c/{capabilities,ffi,async-faults}.json` | PASS (fault scope) | 三项 capability、同步 FFI、异步 success/error、双 VM 并发、同 VM reentrant 拒绝、late response 拒绝、timeout 丢 late、cancel 均通过；manifest 负例通过。 | 双 VM 并发不是同 VM 并发；nested 调用未单独证明；guest crash 在 FFI 中未单独注入；timeout 依赖 host broker，不是 guest 抢占。 |
| `experiments/wasm/results/chez/10.4.1-c/mechanism.json`, `suspend-c.log` | SUPERSEDED (historical) | 记录 `dsh_dispatch` 返回 suspended 后，跨 `Scall1` 调用 continuation 会让 Node 进程在 final response 前退出；旧实现改用 pending/requestId 状态机。 | 用户已选择阻塞模型；G4 口径改为阻塞 host bridge，不再要求 continuation resume。 |
| `experiments/wasm/chez/pin-v2-loader.mjs`, `pin-v2-lib.mjs`, `engine-registry.json`, `pin-v2-fixtures/pin-v2-a.json`, `pin-v2-fixtures/pin-v2-b.json` | PASS (pin v2 metadata scope) | 严格 base64/UTF-8 解码；engine 闭包先验证；由 C ABI VM 重算 tree/bundle/plugin/ffi/rule hash；fresh/repeat 一致，A/B ruleHash 不同；treeHash 篡改、无效 UTF-8、未批准 engine、registry manifest 篡改均拒绝；`pin-load` 解析规则/项目库、校验 import 图闭包并原子替换 registry；失败后仍可加载原始 pin。结果 `experiments/wasm/results/chez/10.4.1-c/pin-v2.json`。 | 只验证单个 rule + 两个项目模块（base/util，非空 `only` 项目 import）；plugins/ffi 环境为空；不执行规则代码、不建立 capabilities/FFI runtime registry；不证明生产 v2 启用或多租户。 |
| `experiments/wasm/chez/PIN-V2.md`, `MIGRATION-V1-V2.md`, `migrate-v1-v2.mjs`, `pin-v2-fixtures/migration-v1-v2.json` | PASS (migration report scoped) | v1 规则 AST 不自动改写；报告逐条列 source/signature/plugin/FFI/engine 差异并要求人工确认；`automaticRewrite=false`、`v2DefaultEnabled=false`。 | 报告生成器不证明任何规则已迁移；v1 loader 仍只读；生产默认版本未改。 |

## Gate status (2026-11-09)

| Gate | Status | Evidence / remaining |
|---|---|---|
| G0 | PASS | 本台账；原审阅包保持 Revision 4 不变。 |
| G1 | PASS (C ABI scope) | `experiments/wasm/results/chez/10.4.1-c/online-vm-c.json`、`limits-c.json`、`supervision-c.json`：C ABI 同实例多请求/状态保持、timeout/exit 后新实例可服务、5 次启动内存基线。OOM 仅有旧传输的 memory-capped 证据，C ABI OOM 未测，故不把 OOM 计入 C ABI PASS。 |
| G2 | PASS (scope in §SOURCE-TREE) | `reader-oracle.json` 29/29 valid、20/20 edge（含诊断字段）；`reader-negative.json` 负例通过；`corpus-v2.json` 31/31；15 项失败 triage 无未解释项。AC-T5 仅固定生产 loader 边界，代码在 Phase 5；AC-T6 在 G5。`SOURCE-TREE.md` 明确 null 不是 Scheme read datum。 |
| G3 | PASS (scoped) | 25 个分项库 + 复合库 matrix 26/26；静态 import 与 `(rnrs eval)` 动态解析均经 allowlist；`(chezscheme)` 动态导入被拒；插件 loader/isolation 23/23，全量整改回归 26/26（24 个当前 C ABI 测试 + 2 个保留的旧资产 coverage suite）；C ABI MEMFS 写 containment、out 配额负例、C ABI A/B 均通过。F1 整改后 bundle 安装为 fail-closed：失败不发布部分 registry，并 poison 后续加载；F3 的 plugin-side 与 pin-side bundle hash 已加 C ABI cross-check。Scope：项目插件不能 import `(rnrs (6))`（会重新导出 raw eval），必须显式 import 分项库；MEMFS 可见读集合由 JS 挂载 allowlist 决定，不是跨根读拒绝；写/链接边界由 host JS guard 提供，C `dsh_mount_file` 本身不是边界；文件数上限 8 只有正例、无负例；不证明生产项目级多租户隔离。 |
| G4 | PASS (blocking scope) | 三项 capabilities、同步/异步 FFI、超时销毁 incarnation、manifest 类型/负例通过；`blocking-ffi.json` success/error/注入单帧，`blocking-broker.json` math.add=3/delay.echo=hello/math.fail=E-FFI-HOST/delay.slow=E-TIMEOUT，`incarnation-timeout.json` E-TIMEOUT→E-VM-DEAD/late audit。Scope：异步是同一 `dsh_dispatch` 调用栈内的阻塞端口桥，不是跨 `Scall1` 的 continuation resume；同一 VM 阻塞期间不能处理第二个请求；timeout 由 host broker/Worker 监督并销毁 incarnation，不是 guest 抢占；nested FFI 与 FFI 内 guest crash 未单独证明；clock.now 已标记非确定性。 |
| G5 | PASS (metadata scope) | `pin-v2.json`：fresh/repeat、A/B、treeHash 篡改、无效 UTF-8、未批准 engine、engine 闭包/manifest 篡改、失败回滚均有结果；`pin-v2-loader.mjs` 先验 engine，再由 VM 重算 hash，并在 `pin-load` 内解析规则/项目库、校验 import 图闭包，全部通过后原子替换内存 registry；响应 `registry` 计数与规则数一致。v1 迁移仅生成人工确认报告。Scope：单 rule + 两个项目模块（base/math，源文件 `util.scm`，非空 `only` 项目 import）、plugins/ffi 为空、不执行规则代码/不建立 capabilities/FFI runtime registry、未改生产默认 pin。 |
| G6 | PENDING | 生产候选、发布/许可/跨平台/二进制 selfcheck 与人工迁移 pilot 均未开始。 |

## F1–F8 remediation (2026-11-09)

All rows below are experimental-scope regression evidence after the final C asset rebuild; they do not approve production use. Raw outputs are under `experiments/wasm/results/chez/10.4.1-c/` and the tracker is `experiments/wasm/chez/REMEDIATION-TRACKER.md`.

| ID | Status | Evidence |
|---|---|---|
| F1 | PASS (experimental) | `plugin-loader.scm` installs then publishes its own registry in one step; eval failure restores snapshots and poisons the VM. `PluginRuntime` destroys/recreates the incarnation on failure and replays committed bundles; `test-plugin-runtime.mjs` 4/4 covers global-library leak, restart, replay, and automatic recovery. Chez's process-global namespace still requires host destroy; that integration is now tested experimentally. |
| F2 | PASS (experimental, archive inventory scope) | `verifyEngine` requires exactly four closure files, rejects duplicate/extra/missing/path/size/hash/aggregate errors, parses `online-vm-abi.json`, and recomputes the data archive inventory (`files`, offsets, sizes, SHA-256, package size) against the registry; `test-engine-registry-negative.mjs` 13/13. Boot provenance/reproducible source build remains P3. |
| F3 | PASS (experimental) | `bundleHash` covers module name/version/treeHash and normalized project import edges; plugin loader and pin verifier now use the same `emit-datum` record and domain, with a C ABI cross-check (`plugin-pin-bundle` vs `plugin-load`); `test-bundle-hash.mjs` repeat stable/import edge/version; `test-pin-v2.mjs` A/B distinct plus module kind/name/version negatives; `test-cross-side-bundle.mjs` compares the pin-side and plugin-side hash for the same two-module bundle (base/math) with a non-empty `only` project import; plugin and pin use separate normalization functions; `test-pin-load-imports.mjs` rejects a module importing a declared rule (with a valid rule tuple, so the old rule-inclusive allowlist would reach `E-PIN-MISMATCH-BUNDLE` instead); `test-plugin-runtime.mjs` cross-checks the plugin-side hash. |
| F4 | PASS (experimental) | Timeout kills the Worker; later request returns `E-VM-DEAD`; broker aborts once, records late results and rejects re-used requestIds with `E-FFI-REQUEST-REUSED`. `test-ffi-abort-c.mjs` drives a real C ABI dispatch, terminates the worker, and proves a new incarnation serves. Production host incarnationId remains P2. |
| F5 | PASS (experimental write-containment scope) | Paths are normalized before containment; non-string FS node objects pass through; symlink creation and cross-project rename are denied; `test-memfs-c.mjs` covers project read/write denial, out read/write, mount visibility; quota 65536 bytes and file count pass; `test-memfs-links-c.mjs` symlink/rename=EPERM, `FS.link` is not implemented by this Emscripten build. Read containment is only the mounted-file visibility set; the earlier secret/traversal/cross-project read-denial assertions were vacuous (the files were not mounted) and were removed. It does not prove arbitrary cross-root read denial; that remains a P2 boundary task. |
| F6 | PASS (experimental frame scope) | `DSH-FFI` body is strict JSON; C0 controls are escaped, non-ASCII characters remain valid UTF-8 JSON, non-finite values are rejected; the test harness validates exact keys/types, generates requestId, and ignores project-supplied rid; frame length is capped at 65536 UTF-8 bytes with `E-FFI-FRAME-TOO-LARGE`; `test-blocking-ffi-c.mjs` covers injection, ASCII cap, and multibyte cap (40,000 chars/80,000 bytes). Production host schema/requestId wiring remains P2. |
| F7 | PASS (experimental) | Manifest declares scalar arg and return types; non-finite numbers are rejected; async rejection maps to `E-FFI-HOST`; sync/async results are validated before resume; `test-ffi-types.mjs` covers manifest, arg, sync value, and return-type negatives. Production host ABI contract remains P2. |
| F8 | PASS (experimental) | Worker checks max output/heap bounds before copying and exits incarnation with 70; `test-output-cap-c.mjs` gets `E-OUTPUT-LIMIT` at 1,000,032 bytes and exit 70; `CvmClient` now preserves the worker `code`. |

## Environment and execution notes

- `experiments/wasm/chez/test-source-tree.mjs` 试图 `spawn` Node 子进程；当前 DSH 文件沙箱下返回 `spawn EPERM`。这不是 Scheme 失败，也不构成 G1 证据。Phase 1 改用同进程加载 Emscripten 模块，避免用子进程冒充“长期在线”。
- 现有 `tests`/smoke 结果来自 2026-11-08 的历史快照；本轮不得把它们复制成新结果。每条 Phase 1+ 证据必须记录生成命令、时间、engine 资产 hash 和结果路径。
- Node oracle 只用于测试；生产信任路径只允许固定 Chez loader 重算并与 pin 比对。
- `hostVerified=true` 的原口径仅是“guest canonical bytes 的 SHA-256 与 Node 一致”，**不是**独立 canonicalizer 一致。

## Chez source packaging constraint (user directive 2026-11-08)

- 不把 Chez Scheme 源码树（`s/`, `m/`, `mats/`, `boot/` 的完整 upstream checkout、tarball 或 vendored copy）提交进本项目。
- Chez 源码只能在仓库外的临时/build 目录中获取和构建；仓库保留的内容限于：本项目新增的 boot 源文件、boot 构建脚本、生成/选定的 boot 资产 manifest 与结果。
- 后续 `build-boot.sh` 必须默认源 checkout/install 到仓库外，并在结束时删除或留在外部目录；任何 `git status` 都不能出现 upstream Chez source。
- 现有 `experiments/wasm/chez/10.4.1/{scheme.cjs,scheme.wasm,scheme.data}` 是实验运行时资产，不是 Chez 源码；其 hash 以 `experiments/wasm/results/chez/10.4.1/smoke.json` 记录的历史值为准，Phase 1 重测时重新记录。

## Next evidence to produce

1. ~~`experiments/wasm/results/chez/10.4.1/online-vm.json`~~：PASS（2026-11-08T14:23:25Z）；C ABI 偏差已记录。
2. ~~`experiments/wasm/results/chez/10.4.1/limits.json`~~：PASS（2026-11-08T14:24:54Z）；5 次 fresh Worker，非 5 个 OS 进程。
3. ~~`experiments/wasm/results/chez/10.4.1/supervision.json`~~：PASS timeout/crash（2026-11-08T14:25:53Z）。
4. ~~`experiments/wasm/results/chez/10.4.1/oom.json`~~：PASS memory-capped（2026-11-08T14:27:30Z）。
5. ~~G1 C ABI~~：`online-vm.c`/`dsh_dispatch` 已实现并跑通；证据见 `experiments/wasm/results/chez/10.4.1-c/{online-vm-c,limits-c,supervision-c}.json`。C ABI OOM 仍未单独测，不作为 G1 通过项。
6. ~~G2 corpus triage~~：`guest-v2.scm` + `run-corpus-v2.mjs` 31/31 通过（2026-11-08）；`resource.timeout`/`output-limit` 由 host runner 强制，边界见上表。独立 Node canonicalizer oracle 29 valid + 19 edge 已完成；G2 全绿前禁止任何 FFI 试验。
7. GC 证据：`experiments/wasm/chez/gc-probe.scm` 已确认 `collect` 在 wasm Chez 中可用并能完成多轮回收；不要把人工 64 MiB cap 的 `oom.json` 解释成“没有 GC”。
8. ~~插件隔离~~：`run-plugin-isolation.mjs` 23/23 loader cases + A/B 42/43；结果 `plugin-isolation.json`。动态 resolver、MEMFS、C ABI A/B 见下。
9. ~~G3 R6RS matrix~~：`r6rs-library-matrix.json` 26/26（25 分项 + 复合库），仅 matrix scope。
10. ~~G3 C ABI MEMFS/quota/A-B~~：`10.4.1-c/{memfs,memfs-quota,plugin-ab-c}.json` 全绿；边界见证据表。
11. ~~Phase 4 capabilities/FFI~~：`10.4.1-c/{capabilities,ffi,async-faults}.json` 全绿；`host-bridge.json` 32 ms 阻塞，`blocking-ffi.json` success/error，`blocking-broker.json` 四项全绿。`mechanism.json` 记录 live continuation 不可用，已由 m02582 的阻塞模型取代。
12. ~~Phase 4 阻塞 FFI 收口~~：G4 改为 PASS (blocking scope)；旧 two-phase 行标 SUPERSEDED。不是 continuation resume，timeout 非 guest 抢占，nested/FFI 内 guest crash 未单独证明。
13. ~~Phase 5 pin v2 实验 loader~~：`pin-v2.json` 全绿；`pin-load` 已做规则/项目库解析、import 图闭包校验和原子 metadata registry 发布；`migration-v1-v2.json` 仅生成人工确认报告。Scope 为 metadata-only，未改生产默认 pin。

## Phase 1 commands (reproducible)

```powershell
$node='C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node experiments/wasm/chez/test-online-vm.mjs
& $node experiments/wasm/chez/measure-limits.mjs
& $node experiments/wasm/chez/test-supervision.mjs
& $node experiments/wasm/chez/test-oom.mjs
& $node experiments/wasm/chez/test-online-vm-c.mjs
& $node experiments/wasm/chez/measure-limits-c.mjs
& $node experiments/wasm/chez/test-online-vm-c-supervision.mjs
```

Runtime asset SHA-256 (2026-11-08 recheck):
- `scheme.wasm` = `451b62ba5e8ff29dda887df3361af71a5f48a83d210ecb5e4845ae4ba45073a5`
- `scheme.data` = `2899aa16e06e6a42d3e2c7d81caf7e616848cd5d4a8476cbc8f58aa24fd487bc`
- `scheme.cjs` = `fa7979d987e212d932b5f78ea58bc13edbf4b6e862029ea3e485ff2c32ff6fe4`

## Phase 3–5 commands (reproducible)

```powershell
$node='C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node experiments/wasm/chez/test-r6rs-matrix.mjs
& $node experiments/wasm/chez/run-plugin-isolation.mjs
& $node experiments/wasm/chez/test-memfs-c.mjs
& $node experiments/wasm/chez/test-memfs-quota-c.mjs
& $node experiments/wasm/chez/test-plugin-ab-c.mjs
& $node experiments/wasm/chez/test-host-bridge-c.mjs
& $node experiments/wasm/chez/test-blocking-broker-c.mjs
& $node experiments/wasm/chez/test-pin-v2.mjs
```

C ABI rebuild (assets under `experiments/wasm/chez/10.4.1-c/`):

```powershell
& 'C:\Users\29436\AppData\Local\Programs\Podman\podman.exe' exec guix-work bash /work/experiments/wasm/chez/build-online-vm-c.sh /work /src/ChezScheme /tmp/dsh-c
& 'C:\Users\29436\AppData\Local\Programs\Podman\podman.exe' cp guix-work:/tmp/dsh-c/scheme-c.js experiments/wasm/chez/10.4.1-c/scheme-c.js
& 'C:\Users\29436\AppData\Local\Programs\Podman\podman.exe' cp guix-work:/tmp/dsh-c/scheme-c.wasm experiments/wasm/chez/10.4.1-c/scheme-c.wasm
& 'C:\Users\29436\AppData\Local\Programs\Podman\podman.exe' cp guix-work:/tmp/dsh-c/scheme-c.data experiments/wasm/chez/10.4.1-c/scheme-c.data
& $node experiments/wasm/chez/refresh-engine.mjs
```
