# Chez/Wasm source-tree/plugin 生产上线评估报告

**日期：** 2026-11-09  
**结论：** **NO-GO——不批准当前上线生产，也不建议以 CONDITIONAL GO 放行。**  
**评审对象：** Chez/Wasm source-tree/plugin、pin v2、阻塞 FFI、MEMFS 及其生产接缝。  
**基线：** v0.18.0，commit `a0d5a4d082539460a3d841764c28b6b8043567dc`。  
**评审方式：** 仅阅读现有证据、文档和实现；两名独立评审分别做发布质量评估和静态代码评审。本报告没有运行探索性测试、没有修改生产代码、没有实际上线。

> 本报告中的“通过”均指已有结果文件所记录的实验结果，不表示本次重新执行。`FAIL` 在发布门禁表中表示“没有可接受的上线证据”，不表示本次运行了测试并得到失败。

> **整改更新（2026-11-09，多轮整改后）：** F1–F8 的代码级整改已完成并重建资产；当前 `run-remediation-regressions.mjs` 为 **26/26 PASS**（24 个当前 C ABI 测试 + 2 个保留的旧资产 coverage suite）。最终独立复审确认 **F1–F8 全部 experimental PASS**。P2 已实现显式 opt-in 的 v2 pin 验证与长期 VM 执行接缝（`loadSchemeV2Pin` / `SchemeV2Runtime`）；规则可 import `(dsh ffi (6))` 并调用 pin 声明且宿主 allowlist 的阻塞 FFI 目标。独立安全/代码复审发现的空 pin allow-all、未认证帧、规则逃逸读取 bridge token、exit 处理、requestId 复用和 ABI 导出缺口已修复并有回归覆盖；`test/scheme-v2-pin.test.js` 为 **17/17**，生产测试 **335 pass / 1 skipped**，`selfcheck` 扫描 88 个文件通过。P2 默认 pin/CLI 接缝、P3 完整故障矩阵与独立 OS supervisor、P4 SBOM/许可/跨平台仍未关闭，生产发布结论不变：**NO-GO**。逐项状态、最终资产 hash 和未关闭项见[整改跟踪表](../../chez/REMEDIATION-TRACKER.md)；P0 范围、审阅安排和 Q0–Q12 门禁见[Phase 6 章程](PHASE6-CHARTER.md)，该章程已批准实施、未批准发布。

## 1. 执行摘要

当前不能上线，原因有四类：

1. **生产候选尚不存在。** 生产仍只接受规则 pin v1，实验 pin v2 只验证 metadata；G6 的生产候选、发布、许可、跨平台和真人迁移试点均未开始。[EVIDENCE-LEDGER.md:60-70](../../chez/EVIDENCE-LEDGER.md#L60-L70) [pin-rules.js:12,73-100](../../../../lib/pin-rules.js#L12)
2. **初始静态复核曾确认高严重度实验实现缺陷。** 插件 bundle 非原子、engine 闭包校验不完整、bundleHash 与批准规格不一致、timeout 生命周期违反 incarnation 废弃约定等问题已按 P1 完成代码级整改；最终独立复审确认 F1–F8 为 experimental PASS，但这仍不等于生产批准。
3. **安全与故障边界不完整。** 当前 C ABI 监督是 Node Worker，不是独立 OS supervisor；C ABI OOM 未测，最终阻塞 FFI 的 late/drop/cancel/nested/crash 矩阵未闭合，pin fixture 的 plugins/FFI 均为空。[SUPERVISION.md:38-53](../../SUPERVISION.md#L38-L53) [pin-v2-a.json:8-32](../../chez/pin-v2-fixtures/pin-v2-a.json#L8-L32)
4. **发布与运营准入证据缺失。** 二进制 selfcheck、包闭包、SBOM/NOTICE、可复现构建、支持平台、容量、监控、canary 和回滚演练均未达到发布要求。

**当前生产暴露面：** 包白名单不包含 `experiments/`，生产 pin 仍为 v1，因此本实验没有形成已发布的 v2 执行面；当前不需要因这次实验紧急回滚现有 v1。[package.json:30-41](../../../../package.json#L30-L41) 真正的风险是把当前实验状态误当作可发布状态。

**路线判断：** 已有证据支持继续修复和构建生产候选，不支持现在发布。NO-GO 是对当前就绪度的判断，不是否定 Chez/Wasm 技术路线。

## 2. 原始评估资产身份

本报告的原始判断对应下列冻结实验资产；整改后的代码与资产不覆盖这段历史结论：

| 资产 | SHA-256 |
|---|---|
| `scheme-c.js` | `c29f5eb2f45c746d0ba68c2ec0b16e35b27c36fffcc8096a8c3dc962416ba99c` |
| `scheme-c.wasm` | `76f7b55921c09269604cbb67550530026cfa97a1c75bd9ea902cf1cc1a873432` |
| `scheme-c.data` | `a116f23fcbd9123a4eb47ffa060dc60878000859515b4eae93bc45166d89b73d` |
| `engineArtifactHash` | `sha256:83df3b400509b5ca71842d4c697ba335c8f2ae059a3d065b8e6c2bc3e1060d77` |

**整改后资产（F1–F8 代码级整改，2026-11-09）：**

| 资产 | SHA-256 |
|---|---|
| `scheme-c.js` | `5957c85d022a55058ae4e94668ce792010834f77065f8439cde3e967b0eb7713` |
| `scheme-c.wasm` | `b0aa6503c7642f3b09da229569b1cc5f9ff8ec8e01b18fb5a57b90ab5e6deceb` |
| `scheme-c.data` | `0a510371bf6c352840c78c971ea47815cc7014dc568155f1751162a9de71538a` |
| `engineArtifactHash` | `sha256:2e6b45625af308c7452e80273a0539b7a7dd52f2c261c0e56505f90bd211f826` |

证据来源：[EVIDENCE-LEDGER.md:51](../../chez/EVIDENCE-LEDGER.md#L51)、[engine-registry.json](../../chez/engine-registry.json)、[remediation-regressions.json](../../results/chez/10.4.1-c/remediation-regressions.json)。

## 3. 现有证据能证明什么

| 范围 | 已有正面证据 | 生产解释 |
|---|---|---|
| Reader / treeHash | 已有结果记录 valid 29/29、edge 20/20，独立 Node oracle 与 guest 一致；但 reader 的资源检查发生在 Chez `read` 之后。[EVIDENCE-LEDGER.md:40-42](../../chez/EVIDENCE-LEDGER.md#L40-L42) | 是身份与解析的可复用基础，不等于生产 loader 或完整恶意输入防护。 |
| Pure corpus | 实验 corpus 31/31，15 个旧失败均有 triage。[EVIDENCE-LEDGER.md:44](../../chez/EVIDENCE-LEDGER.md#L44) | 证明选定实验语料，不证明真实生产规则、真实 pin 和完整 compare/apply/verify。 |
| R6RS | 25 个分项库加复合库共 26/26 的 import/代表行为通过。[EVIDENCE-LEDGER.md:47](../../chez/EVIDENCE-LEDGER.md#L47) | 是 smoke matrix，不是每库完整语义、安全或资源边界证明。 |
| C ABI 在线 VM | 同实例多请求、状态保持、timeout/exit 后新实例可服务；5 次启动内存基线已记录。[EVIDENCE-LEDGER.md:39](../../chez/EVIDENCE-LEDGER.md#L39) | C ABI 是 JS→Wasm export，不提供抢占或 OS 隔离；C ABI OOM 未测。 |
| 插件与 MEMFS | 实验 loader 23/23、C ABI A/B 42/43、MEMFS 读可见性/写 containment 和配额有正面结果。[EVIDENCE-LEDGER.md:45-50](../../chez/EVIDENCE-LEDGER.md#L45-L50) | 整改后原子性与路径授权有实验覆盖；读隔离仍只是挂载 allowlist，不能直接把 scoped PASS 当成生产安全批准。 |
| 阻塞 FFI | 已有 add、echo、host error、单 timeout 结果。[blocking-broker.json](../../results/chez/10.4.1-c/blocking-broker.json) | 只覆盖基础路径；不是最终故障矩阵，且 timeout 后恢复原 incarnation 与既定契约冲突。 |
| pin v2 | fresh/repeat、A/B、篡改拒绝、两模块 bundle 的跨侧哈希与 import 闭包、metadata registry 替换有结果。[EVIDENCE-LEDGER.md:57](../../chez/EVIDENCE-LEDGER.md#L57) | 单 rule、两个项目模块、空 plugins/FFI；不执行规则，不建立 runtime bindings，loader 返回前关闭 VM。 |
| 迁移 | 只生成人工确认报告；示例两条规则仍有 blockers。[migration-v1-v2.json:1-42](../../chez/pin-v2-fixtures/migration-v1-v2.json#L1-L42) | 没有真实项目完成迁移，更没有生产回滚证据。 |

### Gate 的正确读法

[EVIDENCE-LEDGER.md:60-70](../../chez/EVIDENCE-LEDGER.md#L60-L70) 中的 G1–G5 是**限定范围的实验 PASS**，G6 是 `PENDING`。这些状态不能合并解释为“生产就绪”。初始静态评审发现的实验实现缺陷已按 P1 整改并取得 experimental PASS；G3/G4/G5 仍不能直接充当相应生产门禁的最终证据。

## 4. 已确认的实现或规格问题

**历史快照：** 以下 F1–F8 是整改前的独立静态发现，并由主评审再次阅读实现核实；未做动态复现。当前整改状态、最终资产和复审结论见[整改跟踪表](../../chez/REMEDIATION-TRACKER.md)；本节数字与代码行号保留原始评估语境。

| ID | 严重度 / 置信度 | 发现与证据 | 生产后果 | 必须采取的修复 |
|---|---|---|---|---|
| F1 | HIGH / 高 | **插件 bundle 不是失败原子的。** `install-one!` 在整包检查完成前注册并更新列表，`load-bundle!` 逐项调用；注释也要求 evaluation failure 后丢弃 VM。[plugin-loader.scm:258-275,297-331](../../chez/plugin-loader.scm#L258-L275) | 失败 bundle 可留下部分库、插件或 Chez 全局注册；后续请求观察到半加载状态。 | 在临时 incarnation 完成全部加载与检查，由宿主一次性发布；失败必须销毁 incarnation。补 library/global registry、后续同名加载和下一请求负例。 |
| F2 | HIGH / 高 | **engine 闭包没有强制实际执行资产的精确集合。** 校验只检查非空列表逐项 hash，未要求 Worker 硬编码读取的资产全部在列，也未拒绝重复项。[pin-v2-lib.mjs:70-90](../../chez/pin-v2-lib.mjs#L70-L90) [online-vm-c-worker.cjs:16-19,186-198](../../chez/online-vm-c-worker.cjs#L16-L19) | registry 可遗漏实际执行的 Wasm/JS/data，目录残留字节仍可能被执行，破坏身份绑定。 | 固定必需且唯一的规范化相对路径集合；拒绝重复、别名和计划外执行资产；解析并核对 ABI manifest，验证 data archive 的构建清单。 |
| F3 | HIGH / 高 | **bundleHash 与批准规格不一致。** 规格要求模块 `{name,version,treeHash}` 和规范化 import 边；实现只哈希 `{name,treeHash}`。[chez-source-tree-plugin-plan.md:229-247](../../../../.omd/plans/chez-source-tree-plugin-plan.md#L229-L247) [online-vm-c.scm:159-177](../../chez/online-vm-c.scm#L159-L177) | 版本或显式依赖图变化不一定改变 bundleHash 及下游 ruleHash，身份不能代表批准的环境。 | 先修 descriptor schema，再由 VM 从已验证源码和声明构造版本及 import 边；同步修公式、fixture、迁移报告和篡改负例。 |
| F4 | HIGH / 高 | **timeout 后继续恢复原 incarnation，late settlement 无审计。** broker timeout 后仍 resume；通用 client 只删除 pending，不 poison/terminate Worker。[ffi-broker.mjs:41-60](../../chez/ffi-broker.mjs#L41-L60) [c-vm-client.mjs:41-53](../../chez/c-vm-client.mjs#L41-L53) [test-blocking-broker-c.mjs:100-125](../../chez/test-blocking-broker-c.mjs#L100-L125) | 违反 timeout/crash 后废弃 incarnation 的约定；宿主副作用可迟到完成，而旧 VM 和后续规则继续运行。 | timeout/cancel 时终止并拒绝整个 incarnation；新请求进入新实例；用 requestId tombstone 和 late-settlement 审计防止串用。 |
| F5 | HIGH / 中高 | **`/project` 授权在路径规范化前做原始字符串前缀判断。** mount 也直接检查前缀。[online-vm-c-worker.cjs:63-118](../../chez/online-vm-c-worker.cjs#L63-L118) | 若底层按常规路径语义解析 `..`、rename 或链接，可能绕过只读意图；本次未动态证明具体穿越 payload。 | 所有 FS 入口共享规范化、绝对化后的授权；覆盖 link/symlink/rename 双向路径与父目录解析负例。 |
| F6 | HIGH / 高 | **阻塞 FFI 使用未转义的 tab 分隔帧。** 项目可控字段直接 `display`，宿主按 tab split。[online-vm-c.scm:62-81](../../chez/online-vm-c.scm#L62-L81) [test-blocking-broker-c.mjs:100-114](../../chez/test-blocking-broker-c.mjs#L100-L114) | 控制字符可造成字段错位、伪造额外帧或响应错配，破坏 requestId 与完成边界。 | 改成长度前缀帧或严格 JSON；宿主验证每字段 schema、目标文法和关联信息；requestId 由宿主生成并绑定 incarnation。 |
| F7 | MEDIUM / 高 | **异步 rejection 绕过稳定错误映射，窄 ABI 类型约束不足。** `call` 不 await handler；不支持值可变成 `"unsupported"`。[ffi-registry.mjs:52-63](../../chez/ffi-registry.mjs#L52-L63) [online-vm-c.scm:37-44](../../chez/online-vm-c.scm#L37-L44) | async reject 可退化为其他错误码；非法结果可能产生序列化失败或副作用已完成但 guest 收到失败的不一致。 | 在统一边界 await 并分类异常；调用前后严格验证整数、UTF-8/字节值、结果大小和 manifest 类型，拒绝任意 JS object/非有限数。 |
| F8 | MEDIUM / 高 | **C ABI 响应复制前缺少堆范围和 `maxOutputBytes` 检查。** 当前只检查指针非零、长度非负。[online-vm-c-worker.cjs:26-40](../../chez/online-vm-c-worker.cjs#L26-L40) | 超大响应先造成宿主复制/解码成本，冻结的输出限制不能在该通道生效。 | 复制前验证整数范围、`outPtr + outLen <= HEAPU8.length` 和输出上限；违规按引擎故障销毁 incarnation。 |

### 合同漂移

[ASYNC-FFI.md:5-20,46-64](../../ASYNC-FFI.md#L5-L20) 仍要求真实释放执行栈、guest/supervisor 双层 timeout 和完整异步故障矩阵；Revision 7 已选择同一 `dsh_dispatch` 内阻塞的模型。用户选择阻塞模型可以作为实验范围决定，但不能据此宣称满足旧 async-ffi 合同。生产准备时必须更新 ADR 和合同，明确阻塞模型、宿主终止语义、取消/迟到结果、副作用和运维限制。

## 5. 尚未实现的生产工作

以下是明确的生产缺口，不冒充实验代码回归：

1. **没有生产 v2 执行路径。** 生产仍为 `PIN_RULES_VERSION=1` 和 JSON AST。[pin-rules.js:12,73-100,124-179](../../../../lib/pin-rules.js#L12)
2. **实验 loader 不是在线生产 runtime。** 返回前关闭 VM，不留下可执行实例；plugins/FFI 目前只是字符串列表 hash。[pin-v2-loader.mjs:30-94](../../chez/pin-v2-loader.mjs#L30-L94)
3. **通用 Worker 没有接最终阻塞 FFI 桥。** 阻塞测试使用专用测试 Worker，不能把测试桩能力当作通用 client 能力。[online-vm-c-worker.cjs:16-21](../../chez/online-vm-c-worker.cjs#L16-L21)
4. **没有按 pin/ruleHash 授权的运行时 bindings。** 现有实验 registry 不等于生产 capability/EffectJournal 集成。[ffi-broker.mjs:12-25](../../chez/ffi-broker.mjs#L12-L25)
5. **生产 e2e 仍走 JS AST。** 现有 Scheme pin e2e 不是 Chez/Wasm v2。[scheme-pin-e2e.test.js:26-75](../../../../test/scheme-pin-e2e.test.js#L26-L75)
6. **Worker 不是 OS supervisor。** 生产要求独立进程、cgroup/Job Object 或等价边界。[SUPERVISION.md:38-53](../../SUPERVISION.md#L38-L53)
7. **包与 selfcheck 未接入。** 当前发布白名单不含实验资产，selfcheck 对文件统一按 UTF-8 文本处理。[package.json:30-41](../../../../package.json#L30-L41) [selfcheck.mjs:75-99](../../../../scripts/selfcheck.mjs#L75-L99)
8. **许可、工具链和平台未闭合。** Chez Apache-2.0/NOTICE 仍需交付审计，未测平台必须保持 unknown。[SOURCES.md:44-53,75-82](../../SOURCES.md#L44-L53)
9. **迁移只有报告生成器。** 不自动转换、不默认启用，示例仍需人工解除 blockers。[MIGRATION-V1-V2.md:1-14,43-61](../../chez/MIGRATION-V1-V2.md#L1-L14)
10. **监控、容量和 canary 不存在。** 冷启动内存采样不能替代并发、饱和、稳态 RSS、背压和告警证据。

## 6. 风险登记

`D` 表示可检测性，数值越高越容易提前发现。

| 风险 | 影响 | 可能性 | D | 当前状态 / 控制 |
|---|---|---:|---:|---|
| 错误规则或环境静默改变 compare/apply/verify 结果 | Critical | 中 | 2 | **HOLD。** 生产接缝未实现；F3 影响环境身份，真实项目 differential 未做。 |
| 失败激活留下半加载 registry 或错误 engine | Critical | 中 | 3 | **HOLD。** F1/F2；需要临时 incarnation、精确闭包和 live rollback。 |
| OOM/恶意输入拖垮主 runner 或相邻任务 | Critical | 中 | 2 | **HOLD。** Worker 非 OS 边界，C ABI OOM 未测，reader 前置分配仍需 supervisor。 |
| FFI 悬挂、响应错配、迟到副作用或重复副作用 | High | 中 | 2 | **HOLD。** F4/F6/F7；最终阻塞桥故障矩阵未闭合。 |
| 路径或 capability 授权绕过 | High | 中 | 3 | **HOLD。** F5 是静态风险；生产 runtime bindings 尚未实现。 |
| 错误/损坏二进制进入发布物 | High | 高（若直接打包） | 4 | **HOLD。** 无二进制 selfcheck、包闭包和 clean packed install 证据。 |
| 许可或支持平台声明不合规/不可兑现 | High | 未知 | 3 | **HOLD。** 目前只有 win32-x64、Node v24.21.0 结果；其他平台必须 unknown 或排除。 |
| 真实迁移产生未解释差异，故障时无法恢复 | Critical | 中 | 2 | **HOLD。** 无真人 pilot、双跑、回滚演练、监控与 canary。 |
| 并发内存放大和重启风暴 | High | 中 | 2 | **HOLD。** 单实例冻结预算 `memoryBytes=165150720`，没有生产容量数据。[limits-c.json:39-46](../../results/chez/10.4.1-c/limits-c.json#L39-L46) |

## 7. 发布门禁与当前判定

| Gate | 通过判据 | 验收/审阅 | 当前判定 |
|---|---|---|---|
| Q0 范围与批准 | Phase 6 生产 diff、更新后的 ADR、支持范围获项目 owner 实施批准。 | 项目 owner | **PASS（实施）；发布未批准。** |
| Q1 正确性与身份 | F1–F8 全部修复；bundleHash 符合批准公式；engine 实际执行集合与闭包一一对应。 | Runtime / Security | **FAIL：无生产候选；F1–F8 仅 experimental PASS。** |
| Q2 生产接缝 | 从真实生产 CLI/包产物完成 v2 compare/apply/verify；v1 默认和 golden hash 不变。 | Runtime / Test | **FAIL：生产仍是 v1。** |
| Q3 OS 监督与 OOM | 每个支持平台的 OOM、timeout、crash、kill、restart 全过，主 runner 和兄弟任务存活，错误结构化。 | Runtime / SRE | **FAIL：只有 Worker 证据。** |
| Q4 最终阻塞 FFI | 在最终 engine hash 上通过 late/drop/cancel、nested/reentrant、malformed/oversize、宿主崩溃、timeout/restart；迟到可审计。 | Security/Runtime reviewer | **FAIL：仅基础场景。** |
| Q5 Pin / 插件 / FFI 安全 | 多模块、非空 plugins/FFI 正负例、真实执行、失败原子性、live rollback、跨项目隔离全过。 | Security / Runtime | **FAIL：FFI 规则级绑定已通过，plugins 仍为空，live plugin registry 未验证。** |
| Q6 包与 selfcheck | pack 闭包准确；全部执行资产 magic/size/SHA-256 与 registry 一致；clean packed install 可执行。 | Release engineer | **FAIL：未接入。** |
| Q7 许可与可复现构建 | SBOM、LICENSE/NOTICE、精确 toolchain lock 齐备；两次干净构建 hash 一致或差异获批。 | Release / Legal | **FAIL：工件未提供。** |
| Q8 平台支持 | 所有声明支持的 OS/CPU/Node 单元通过；未测单元由包元数据和文档明确排除。 | Release / QA | **FAIL：仅单一平台结果。** |
| Q9 迁移与回滚 | 代表性真人项目 pilot；100% 规则人工审批，0 blocker、0 未解释差异；回滚恢复 v1 和原逻辑交付表。 | 项目 owner + 独立 verifier | **FAIL：只有模板报告。** |
| Q10 监控与 canary | timeout/OOM/restart/crash/FFI/pin/激活版本指标与告警齐备；故障注入触发告警；有中止阈值和回滚演练。 | SRE / Release lead | **FAIL：未提供。** |
| Q11 容量 | 并发、RSS、队列、延迟预算明确；饱和不突破预算，过载有背压，恢复无重启风暴。 | SRE / Performance | **FAIL：只有冷启动采样。** |
| Q12 v1 兼容 | `RULE_LANGUAGE_VERSION=1`、`PIN_RULES_VERSION=1`、`PIN_VERSION=5` 和 golden hash 不变；v2 不静默默认迁移。 | Runtime / Verifier | **候选出现后必须验证；当前无 v2 候选。** |

**放行规则：** Q0–Q12 任一未完成即不发布。只有全部生产阻塞门禁通过后，才可讨论受信、单租户、显式 v2 opt-in 的 limited canary；当前不满足 CONDITIONAL GO 的前提。

## 8. 修复后仍需保留的残余风险

- 共享 reader/corpus 之外的 R6RS 语义差异仍需真实项目 differential 持续控制。
- 外部 FFI 副作用不能默认 exactly-once；必须声明幂等、重试、补偿和人工对账策略。
- 首发不应宣称多租户。若未来需要多租户，必须另做威胁建模和独立安全门禁。
- 冷启动预算不代表长期并发 RSS、句柄和队列行为；需要 soak 与运行时指标持续控制。
- Chez/Emscripten 上游供应链需要持续跟踪安全公告，并保留可复现重建能力。

## 9. 生产上线前准备计划

本计划是后续执行建议，**本报告没有执行其中的修复、测试或上线步骤**。

### P0：冻结发布决定并建立整改基线

- **入口：** 当前 NO-GO。
- **工作：** 保持 v1 默认；禁止 tag/publish v2；项目 owner 已批准实施，不再设企业式实名 owner；把 F1–F8 和 Q0–Q12 纳入同一整改清单，并按边界安排独立子代理审阅。
- **交付物：** 已批准实施的 Phase 6 charter、更新后的 ADR、阻塞模型合同、支持范围与发布门禁表。
- **通过判据：** 每个发现和门禁都有验收证据路径、独立审阅记录和依赖关系；旧 async 合同与阻塞模型的冲突已书面解决。
- **相对成本 / 收益：** 低 / 防止无证据的并行返工和错误放行。

### P1：先修正确性与信任根，再接生产

- **入口：** P0 完成。
- **工作：** 修复 F1–F8；临时 incarnation 原子加载；精确 engine 执行集合；补齐 version/import hash 身份；统一规范化路径授权；替换 FFI 帧协议；timeout/cancel 销毁实例并审计 late；严格 ABI 类型、错误和输出限制。
- **验收/审阅：** 独立 code-reviewer + security-reviewer 子代理。
- **交付物：** 修复后的实现、更新后的规格/fixtures、负例矩阵、新的最终 engine hashes。
- **通过判据：** Q1 全过；失败 bundle 无可观察残留；任何实际执行字节都在闭包内；所有身份公式与批准规格一致。
- **相对成本 / 收益：** 高 / 消除会污染后续所有生产证据的基础缺陷。

### P2：构建显式 opt-in 的生产候选

- **入口：** P1 完成。
- **工作：** 接入 pin/compiler/identity/runtime/FFI/assets/package/selfcheck 接缝；保留 v1 只读和默认；建立真正在线的 v2 runtime registry 与原子 bindings；禁止从 pin 任意路径动态 import。
- **当前实现（partial）：** `loadSchemeV2Pin` 已对打包 engine 完成 pin v2 校验，`SchemeV2Runtime` 在长期 C ABI VM 中执行已验证的规则；规则可 import `(dsh ffi (6))`，FFI 目标必须同时由 pin 声明和宿主 `ffi.call` allowlist 允许。`pin.ffi=[]` 加宿主 provider 会以 `E-V2-FFI-UNDECLARED` 拒绝；每次 `ffiCall` 使用唯一 requestId，并绑定 host rule hash。`assets/chez-wasm/` 与 `assets/SHA256SUMS` 已进入包闭包。默认 pin/CLI 仍是 v1，未接入生产配置；插件执行仍拒绝。因此 P2 仍未完成。
- **验收/审阅：** 独立 code-reviewer + test-engineer 子代理。
- **交付物：** 可审查的生产 diff、候选 commit、真实 CLI 的 v2 compare/apply/verify 证据、v1 全量回归与 golden hash 证据。
- **通过判据：** Q2、Q5、Q12 全过；真实规则可执行，非空 plugins/FFI 授权与隔离通过；失败后旧 live registry 连续可用。
- **相对成本 / 收益：** 高 / 首次形成可验证的生产候选。

### P3：建立 OS 隔离和最终 FFI 故障边界

- **入口：** P2 提供生产接缝。
- **工作：** 使用独立 OS 子进程和平台资源限制；在最终 engine 上执行 OOM/timeout/crash/kill/restart、reader 前置分配、并发邻居存活；接通最终阻塞桥并跑完整 late/drop/cancel/nested/malformed/oversize/host crash 矩阵。
- **当前实现（partial）：** 生产 `CvmClient` 已接通共享环形缓冲的阻塞 FFI 帧，要求显式 `ffi.call` allowlist；严格的 frame schema、每 VM host token、host-bound rule hash、requestId 去重、宿主异常到 `E-FFI-HOST`、超时丢弃 incarnation、`(exit n)`→`E-VM-EXIT` 已实现。规则源码先经受限 reader 重写为 `(dsh safe eval (6))`，无法导入 `(chezscheme)` 或读取 bridge token；独立复审发现的空 pin allow-all、未认证/畸形帧、规则逃逸、重复 `ffiCall` requestId 和 ABI 导出缺口已修复，`test/scheme-v2-pin.test.js` 17/17。尚未实现：完整 late/drop/cancel/nested/host-crash 矩阵、独立 OS 子进程/cgroup/Job Object 资源限制与重启监督。因此 P3 仍未完成。
- **验收/审阅：** 独立 security-reviewer + performance-reviewer 子代理。
- **通过判据：** Q3、Q4 全过；任何故障不拖垮主 runner 或兄弟任务；恢复后新实例可服务；所有 late settlement 可审计。
- **相对成本 / 收益：** 高 / 防止宿主级宕机、悬挂和不可追踪副作用。

### P4：完成发布物、许可和平台准入

- **入口：** P1 后可准备，最终验证必须绑定 P2/P3 的最终 commit 和 engine hash。
- **工作：** 二进制 selfcheck；npm pack 字节闭包；clean packed install；SBOM、LICENSE/NOTICE；锁定 SDK/flags/image digest；两次干净构建；执行支持平台矩阵或在包元数据中收窄支持范围。
- **当前准备：** `scripts/selfcheck.mjs` 已支持二进制扩展名不解码 UTF-8、校验 `.wasm` magic，并要求发布的二进制在 `assets/SHA256SUMS` 中有条目；helper 为 `scripts/selfcheck-lib.mjs`，单测 3/3。v2 引擎资产已放入 `assets/chez-wasm/`（含 engine registry 与 checksums），`selfcheck` 目前扫描 88 个文件通过；SBOM、Chez/依赖许可通知、跨平台验证和 boot 可复现来源仍未完成，故 P4 未完成。另观察到相同输入重复构建的 `scheme-c.js` hash 不同（`ef0effe6…`、`578cd341…`、`dafc91a0…`、`16eda1e8…`），而 `.wasm`/`.data` 稳定；JS glue 尚未做到字节可复现，发布前必须消除。
- **验收/审阅：** 独立 dependency-expert + verifier 子代理。
- **通过判据：** Q6–Q8 全过；包内实际执行资产与批准 registry 逐字节一致；未测平台没有支持声明。
- **相对成本 / 收益：** 中高 / 消除供应链、合规和“源码可用但包不可用”的风险。

### P5：真人迁移试点与回滚演练

- **入口：** P2、P3 完成，候选可安全执行真实项目。
- **工作：** 选择有代表性的真实项目；冻结 v1 pin；逐规则恢复/确认 Scheme source、模块、插件、FFI 和 engine；v1/v2 双跑；人工审批每条规则；演练故障时恢复 v1 和原逻辑交付表。
- **验收/审阅：** 项目 owner 逐规则批准；独立 verifier 子代理核对证据。
- **通过判据：** Q9 全过；100% 规则人工批准，0 blocker、0 未解释决策差异；v1 pin 保持只读且可立即恢复。
- **相对成本 / 收益：** 高 / 发现模板 corpus 无法覆盖的真实语义和恢复问题。

### P6：监控、容量和 canary 准备

- **入口：** P3、P4 完成；可在 P5 期间准备仪表盘，但不得提前放量。
- **工作：** 建立 timeout/OOM/restart/crash/FFI late-drop-error/pin 校验失败/激活版本指标与告警；做并发阶梯、饱和、soak、背压和重启恢复；写 canary 数值中止阈值和 runbook。
- **验收/审阅：** 独立 performance-reviewer + verifier 子代理。
- **通过判据：** Q10、Q11 全过；故障注入能触发告警；容量不超预算；canary 中止和回滚已演练。
- **相对成本 / 收益：** 中高 / 把“结果 JSON 曾通过”变成可运营、可中止的发布能力。

### P7：独立终审与分阶段发布决定

- **入口：** P0–P6 证据全部绑定同一候选 commit 和最终 engine hashes。
- **工作：** 独立 critic/verifier 子代理复核实现与证据；重新评估 Q0–Q12 和残余风险。
- **通过判据：** 所有门禁有新鲜、可复现、范围明确的证据；无 HIGH/CRITICAL 未处置发现；项目 owner 做最终发布决定。
- **决策顺序：** 先考虑受信、单租户、显式 v2 opt-in 的 limited canary；canary 达标后才考虑扩大范围。任何门禁回退立即恢复 NO-GO 并回到 v1。
- **相对成本 / 收益：** 中 / 防止用旧实验结果或局部通过替代最终发布验收。

## 10. 交接清单

- **项目 owner：** 保持发布未批准；只在技术门禁和独立审阅完成后决定是否发布。
- **实现者：** 先完成 P1，再进入生产接缝；不得把 scoped PASS 当作豁免。
- **独立 verifier 子代理：** 后续测试必须绑定最终生产 commit、最终 engine hash 和真实 CLI；旧 two-phase 结果不能替代阻塞桥证据。
- **独立 dependency/release 审阅：** 核对包字节闭包、SBOM、NOTICE、可复现构建和平台支持声明。
- **独立 performance/security 审阅：** 核对 OS 隔离、容量、监控、canary 中止和恢复 runbook。
- **P5 真人迁移：** 由项目 owner 逐规则批准；独立 verifier 核对真实双跑和 v1 回滚。

**最终意见：当前不批准发布。完成实现、独立审阅和 P5/P7 人工门禁后，再重新评估。**
