# ChezScheme 源码树身份、插件系统与项目级 VM 计划

Status: pending approval — 已按 2026-11-08 审阅意见修订，仅供审阅，未授权施工  
Date: 2026-11-08  
Related goal: `goal-f1c32775-9aad-4a89-9091-dddd15a27b04`（仅覆盖测试与规划；本计划获批准后才另建实施 goal）  
Base commit: `a0d5a4d082539460a3d841764c28b6b8043567dc`（v0.18.0）  
Revision: 2026-11-08 — 根据用户反馈，生产宿主不再独立重算规则 hash；独立重算仅保留为测试 oracle。  
Revision 2: 2026-11-08 — 用户确认：v2 与旧 AST 不兼容并提供迁移指南；v2 pin 只保存项目扩展源码，Scheme 解释器属于插件；必须提供 FFI 接口；必须支持长期在线 VM。  
Revision 3: 2026-11-08 — 用户确认：插件 namespace 包含完整 R6RS；v2 pin 默认启用；异步 FFI 与长期在线 VM 同期交付；首批 JS capability 仅 `project.read`/`log.write`/`clock.now`。  
Revision 4: 2026-11-08 — 用户纠正：`(rnrs)` 不是完整 R6RS。已以 Chez Scheme 官方文档的 R6RS 库清单为准，明确 `(rnrs)` 会漏掉 `(rnrs eval)`、mutable-pairs、mutable-strings、syntax-case 等；计划改为逐库 allowlist/matrix，不再用 `(rnrs)` 代表完整 R6RS。  
Scope: `experiments/wasm/chez/` 内的可行性验证与设计；生产 `lib/`、pin 格式、发布物暂不修改。

## 1. 结论摘要

ChezScheme 10.4.1 的 pb-wasm 运行时适合作为下一阶段的**源码规则引擎候选**：

- 可以用 Scheme 自己完成受限 reader、语法树规范化编码、SHA-256、源码规则注册和纯 Scheme 插件调用；原型已跑通。
- 语法树 hash 比“编译器 AST hash”稳定，且不受注释、空白、quote 语法糖影响；原始源码字节仍单独保留用于取证。
- 插件 namespace 采用**完整 R6RS**，但实现上必须逐项允许 Chez 文档列出的全部 R6RS 库（包括 `(rnrs eval)`、`(rnrs mutable-pairs)`、`(rnrs mutable-strings)`、`(rnrs syntax-case)` 等）；**`(rnrs)` 只是复合库，不能代表完整 R6RS**。不暴露 `(chezscheme)` 与 Chez 专有扩展；安全边界依赖独立 VM、MEMFS 和 capability，不依赖裁剪 namespace。MEMFS 可写 `/tmp`，`library-directories` 可配置。
- 用户已确认：每个项目必须支持**长期在线 VM**，必须提供 FFI 接口；这两项从“可选探索”提升为硬需求，必须先验证 Chez pb-wasm 能否通过自定义宿主循环/ABI 实现，否则本方案不能进入生产。**本计划批准的是继续验证和原型，不是直接替换生产解释器。**

推荐路线：先完成 Scheme 侧的源码树身份与测试期独立校验，再做纯 Scheme 插件；JS 能力模块和项目级 VM 作为受门禁约束的第二阶段。生产宿主不维护第二套 canonicalizer，也不重算规则 hash。

## 2. 已完成的测试证据

测试代码和结果均在 `experiments/wasm/chez/`，未改生产：

| 测试 | 结果 | 证据 |
|---|---|---|
| Scheme SHA-256 标准向量 | 空串、`abc`、long 向量全部正确 | `results/chez/10.4.1/sha-vectors.json` |
| 语法树规范化 | 注释/空白、quote 糖、`#xFF` vs 255、字符串转义一致；代码、symbol vs string、列表顺序不同 | `results/chez/10.4.1/source-tree-plugin.json` |
| 测试期独立验证 | Chez 输出 canonical bytes，测试脚本用 Node 重新 SHA-256，`hostVerified=true`；生产不启用第二套实现 | 同上 |
| 插件调用 | `register-plugin!` + `plugin-call` 返回 42；重复/未知操作报错且计数不增 | 同上 |
| 源码规则注册 | `register-rule-source!` 保存 treeHash 并调用返回 42；重复/坏源码不部分写入 | 同上 |
| namespace 能力 | 窄 allowlist 可阻断文件/import；`(rnrs)` 可 eval `(+ 1 2)`、`open-input-file`/`exit` 可用，但 `eval`、`environment`、`set-car!`、`string-set!`、`syntax-case` 均 unbound；显式 `(rnrs eval (6))` 可 eval；`foreign-procedure`/`load` 不在 `(rnrs)` | `results/chez/10.4.1/namespace.json`、`r6rs-coverage.json`、`probe-r6rs.scm`、`probe-rnrs-coverage.scm` |
| MEMFS | `/tmp/tree-probe.txt` 可写可读；根目录可见 boot/`proc`/`dev`/`home`/`tmp` | `probe-fs.scm` |
| library-directories | 可设置为 `/work/lib`、`/tmp/lib` | `probe-libdir.scm` |
| 批处理/VM 限制 | 现有 `run.cjs -q` 只能在 stdin EOF 后输出，不能直接当逐请求 REPL | `results/rpc-feasibility.json` |

原型 tree hash 示例：

```text
sourceTreeFormat: dsh-rule-tree-v1
baseTreeHash: d98c8a188996ffa7bbcfdd21d536b9695a7cccbc2f872e43d7a3ae01855a549e
```

这条 hash 的输入是**受限语法树 canonical bytes**，不是 Chez 编译器产物，也不是把语法树重新渲染后的字符串。

## 3. 设计原则

1. **源码是身份，AST 是执行缓存。** 新规则的稳定身份来自源码语法树；编译器 AST 不作为 pin 的跨版本身份。
2. **生产身份由受信任的 Chez 运行时计算。** 规则 hash 只在 Chez 的受控 loader 内计算；宿主不重算、也不解析源码树。宿主只校验格式/engineContract、比对 guest 返回的 hash 与 pin 中已保存的 hash，并持有 pin 写入权。独立实现只在测试阶段作为 oracle，用于发现编码/版本回归。
3. **两种身份分开。** `sourceBytesHash` 记录原始字节；`treeHash` 记录规范化语法树。前者取证，后者用于规则/依赖身份。
4. **旧格式冻结。** 现有 v1 JSON AST pin 不改、不静默迁移；新增源码格式与 `PIN_RULES_VERSION=2` 必须双轨。
5. **宿主能力默认拒绝，R6RS 语言完整开放。** 插件默认拥有完整 R6RS 语言与标准库；宿主 JS 能力只拿到 manifest 声明的 capability，且只能通过显式 `(dsh host)`/`(dsh ffi)` 导入。`(chezscheme)`、Chez 专有扩展、任意 JS 反射和宿主文件系统始终禁止。
6. **一个项目一个隔离运行时。** 项目间不共享可变 registry、插件表或宿主 capability 授权。
7. **先证明，再承诺。** 异步 FFI、MEMFS 真挂载、长期在线 VM 都必须先过硬门禁，不能仅凭设计假设进入生产。

## 4. 运行时身份

### 4.1 四种 hash

```text
sourceBytesHash = SHA-256("dsh/rule-source/v1\0" || raw source bytes)
treeHash        = SHA-256("dsh/rule-tree/v1\0"   || canonical tree encoding)
bundleHash      = SHA-256("dsh/rule-bundle/v1\0" || sorted(module treeHash + import edges))
ruleHash        = SHA-256("dsh/rule/v2\0"        || id || version || treeHash
                                                   || signature canonical
                                                   || pluginEnvironmentHash
                                                   || ffiEnvironmentHash)
```

`pluginEnvironmentHash` 由项目插件 id、版本、插件 treeHash、允许的 capability 集合和 host ABI 版本组成；内置插件只以内置引用/artifactHash 参与。

`ffiEnvironmentHash` 由项目 FFI manifest（id、module、export、arity、mode、capability）和实际绑定的内置 FFI 实现版本组成；FFI 声明或实现变化必须改变它。解释器/标准库源码不进入这些 hash，只由 `engineContract` + `engineArtifactHash` 固定。

`sourceBytesHash` 不参与执行身份，只用于显示/取证/审核；否则注释改动会造成无意义的规则变化。

### 4.2 规则 descriptor

```scheme
(rule-descriptor
  (id "org.example.positive")
  (version "1")
  (tree-hash "…")
  (source-bytes-hash "…")
  (signature (result boolean))
  (project-plugin-ids ())
  (ffi-environment-hash "…")
  (engine-contract "chez-pb-wasm/10.4.1")
  (engine-artifact-hash "…"))
```

descriptor 不是可信输入：加载时由 Chez loader 从 pin 中保存的源码重新计算 hash，宿主只比较返回的 hash 字符串与 pin；宿主不重算，也不把 descriptor 当作源码事实。

### 4.3 为什么不用“AST hash”

当前 v0.18.0 的 `ruleHash` 实际是 lowered v1 AST 的 hash。它适合现有解释器，但不适合作为跨编译器版本的源码身份：

- 编译器升级/重编译可能改变 AST；
- lint/宏/标准库内联策略可能改变 AST；
- 无法表达注释、模块组织或插件依赖。

源码树 hash 解决“同一份源码是否同一规则”；编译器 artifact hash 只作为缓存/诊断。

## 5. 受限 reader 与语法树规范

### 5.1 Reader 边界

原型先用 Chez `read` 验证编码；生产不能直接依赖它的全部行为，因为：

- `#!fold-case` 会改变后续 symbol 大小写；
- `#.`、循环 datum label、reader directive 不属于规则子集；
- 不同 Chez 版本的 reader 细节可能变化。

计划实现 `chez-restricted-reader-v1`，只接受：

- 注释：`;` 行注释、嵌套 `#| |#`；
- datum comment `#;`；
- proper list、固定/可变 lambda（规则入口仍固定元数）；
- symbol、string、integer/rational/real、boolean、char；
- `quote`、`quasiquote`/`unquote` 仅在后续明确批准时加入；
- 不支持 vector 作为规则字面量（如后续需要，另行定义 canonical tag）；
- 明确拒绝 `#.`、`#!`、`#N=`/`#N#`、dotted list（首版）、reader macro。

任何拒绝都产生稳定的 `SCHEME_READ_*` 错误码，不把 reader 错误信息直接当身份输入。

### 5.2 Canonical encoding（v1 原型）

每个 datum 使用 `tag + 长度/内容` 的确定性编码：

```text
0x01 list       0x02 symbol     0x03 string
0x04 integer    0x05 rational   0x06 real
0x07 boolean    0x08 char       0x09 vector
0x0A bytevector 0x10 top-level forms
```

要求：

- 整数/有理数/浮点按规范形式编码；`-0.0`、NaN、无穷必须在 reader 阶段拒绝或单独定义；
- symbol 保留大小写，不把 symbol 降级成 string；
- string 使用 UTF-8 字节，长度以字节计；
- list 顺序敏感，空表与 `null` 区分；
- 顶层 forms 顺序敏感；
- 编码器不读取源码 span/注释/文件路径。

未来改变 tag、长度单位或规范化规则，必须提升 `dsh-rule-tree-v1` 的版本，不复用旧 hash。

### 5.3 生产信任边界与测试 oracle

生产路径只有 **Scheme 实现**：canonical encoder 与 SHA-256 都在 Chez 的受控 loader 内执行，宿主不提供第二套实现，也不在加载时重算规则 hash。

信任根是：

1. 发布物中固定的 Chez Wasm 二进制及其 sha256；
2. 固定的 `engineContract`（Chez/Emscripten/reader/tree 编码版本）；
3. pin 中已保存的 `treeHash`、`bundleHash`、`ruleHash`。

宿主在加载时只做以下检查：

- `format`/`reader`/`treeFormat`/`engineContract` 是否匹配当前运行时；
- 把 pin 中保存的源码原样交给 Chez loader；
- Chez loader 返回 hash 后，与 pin 中保存的 hash 做字符串比较；
- guest 返回的 descriptor 若不匹配即整体失败。

Chez loader 必须在执行插件代码之前完成 hash 计算并固定结果；插件不能参与、覆盖或回写该结果。宿主不解析源码树，因此不会出现“宿主 canonicalizer 与 Scheme 实现漂移”的生产故障模式。若运行时二进制来源不可信，则不得使用 v2 pin，而不是在宿主补一套算法。

**测试专用 oracle**：

- `test-source-tree.mjs` 中的 Node canonical/SHA 对照只用于测试和版本升级审计；
- 生产包不得 import 该 oracle，也不得把它作为运行时依赖；
- 测试覆盖所有 tag、边界长度、Unicode、空表、quote/数字/字符串规范化；
- 新的 Chez/reader/tree 版本发布前，测试必须重新跑共享向量；未通过则不能更新 `engineContract`。

这是“测试期双实现”，不是“生产期双实现”。

### 5.4 Loader 与插件隔离

为了让“只有 Scheme 计算 hash”仍然可信，hash 计算必须位于**host 控制的 loader 命名空间**，而不是插件可改写的共享环境：

- `read`、`tree-hash`、`sha256`、`bundle-hash`、pin 校验和 registry 写入只存在于 loader 内部；
- 插件在独立 environment 中求值，拥有完整 R6RS 库；可额外 import `(dsh host)`/`(dsh ffi)` 的授权导出；library resolver 拒绝 `(chezscheme)` 和其他 Chez 专有库；
- 不向插件暴露 hash 过程、registry 内部 cell、loader 全局变量；`(rnrs eval)` 的 `eval` 是 R6RS 语言能力，但其可导入的库仍受同一 resolver 限制；
- 插件源码先由 loader 读取/计算 hash，再进入插件求值；规则源码先计算 treeHash，再执行 lambda；
- loader 的 hash 结果只通过一次性 descriptor 返回，插件不能回写；
- 任何插件对全局状态的改动只限其自身 environment/registry，不能改变已计算的 hash 或 pin descriptor。

宿主侧不重算，但仍必须校验固定 Wasm artifact、engineContract 和 loader 返回的 hash 与 pin；这是“信任固定的 Scheme 运行时”，不是“信任任意 guest 返回”。

## 6. 插件系统

### 6.1 插件形态

首版插件是**纯 Scheme 模块**：

```scheme
(library (dsh plugin math)
  (export double)
  (import (rnrs base))
  (define (double x) (* x 2)))
```

插件清单：

```json
{
  "id": "org.example.math",
  "version": "1",
  "treeHash": "…",
  "exports": ["double"],
  "capabilities": [],
  "abi": "dsh-plugin/1"
}
```

插件源进入项目 bundle，由 `library-directories` 指向项目内插件目录。插件可 import：

- **Chez 文档列出的全部 R6RS 库**（逐项 allowlist，不能用 `(rnrs)` 代替；依据 Chez Scheme User's Guide `csug/libraries.stex` 的 Built-in Libraries 清单）：

```text
(rnrs base (6))                  (rnrs arithmetic bitwise (6))
(rnrs arithmetic fixnums (6))    (rnrs arithmetic flonums (6))
(rnrs bytevectors (6))           (rnrs conditions (6))
(rnrs control (6))               (rnrs enums (6))
(rnrs eval (6))                  (rnrs exceptions (6))
(rnrs files (6))                 (rnrs hashtables (6))
(rnrs io ports (6))              (rnrs io simple (6))
(rnrs lists (6))                 (rnrs mutable-pairs (6))
(rnrs mutable-strings (6))       (rnrs programs (6))
(rnrs r5rs (6))                  (rnrs records procedural (6))
(rnrs records syntactic (6))     (rnrs records inspection (6))
(rnrs sorting (6))               (rnrs syntax-case (6))
(rnrs unicode (6))
```

- `(dsh host)` 中被授权的 capability 子集；
- `(dsh ffi)` 中被授权的 FFI 声明。

禁止 `(chezscheme)` 及其他 Chez 专有库、`foreign-procedure`、任意 JS 反射、宿主文件系统路径。R6RS 文件 I/O 只落到 guest MEMFS（项目快照只读、`/tmp` 可写）；`(rnrs programs)` 的 `exit` 会终止当前 VM，由 supervisor 重启，不影响宿主。

`(rnrs)` 可以作为便捷复合库 import，但**不得作为“完整 R6RS 已覆盖”的验收依据**；插件和验收矩阵必须逐库覆盖上述清单。R5RS 与 base 的重复绑定由 R6RS import 规则处理，插件应按需选择，不要求全部塞进同一环境。

库解析不由普通 binding 白名单完成：即使插件通过 `(rnrs eval)` 调用 `eval`/`environment`，library resolver 也必须只接受上述 R6RS 库和显式 `(dsh ...)` 库。

### 6.2 插件注册 API

```scheme
(register-plugin! id version tree-hash api)  ; 加载期，返回 id
(plugin-call id export args...)               ; 运行期
(plugin-exports id)                           ; 审计
```

约束：

- 重复 id、重复 export、hash 不匹配、未授权 capability 都整体失败；
- 失败不得留下半注册状态；
- 插件 API 只接受固定元数 closure 或显式 `(lambda args ...)` 包装；
- 插件之间依赖在 bundle 阶段解析，运行期不按名字模糊查找；
- plugin registry 只在当前 VM 内可见。

### 6.3 能力插件与 JS API

用户的“把项目 JS API 注册进 Scheme 模块”落实为**受控 capability 模块**，不是把任意 JS 对象注入 guest：

```scheme
(import (only (dsh host)
              project-read
              project-list
              log-write
              clock-now))
```

- Scheme 模块 `(dsh host)` 是稳定 ABI，导出固定 procedure；
- 每个 procedure 对应一个 capability id，如 `project.read`、`log.write`；
- Host 在 VM 启动时注册 capability handler；plugin manifest 只拿到授权子集；
- 参数/返回值只允许 JSON-like 值、string、bytevector，不允许 function/object handle；
- `(dsh host)` 本身不暴露 `require`、`fetch`、`fs`、`process`、任意 JS `eval`；`(rnrs eval)` 的 Scheme `eval` 是独立 R6RS 能力；
- 所有 host 调用有超时、输出上限和审计日志；
- 异步 capability 在 ABI 未证明前只能以“批处理请求”形式出现，不能假装同步。

**可行性门禁 H1**：必须用 Chez Wasm 实测一个宿主 C/JS 回调（字符串入、字符串出），并证明没有任意 JS 反射/文件句柄泄漏。未通过前，`(dsh host)` 仅限纯 Scheme 的 mock。

### 6.4 Namespace

用户已确认：**插件 namespace 包含完整 R6RS，且只包含 R6RS 标准能力**，不暴露 `(chezscheme)` 或 Chez 专有扩展。

Chez Scheme 文档列出的是逐库清单（见 §6.1），不是 `(rnrs)` 一个库。实测 `(environment '(rnrs))`：

- `(+ 1 2)`=3；`open-input-file`、`exit`、`make-eq-hashtable` 可用；
- `eval`、`environment`、`set-car!`、`string-set!`、`syntax-case` 均 unbound；
- 显式 `(import (rnrs eval (6)))` 后 `eval` 可用；`foreign-procedure`、`load` 不可用；
- `(environment '(chezscheme))` 可构造，因此仅靠“不导入”不足以阻断，必须由 library resolver 拒绝。

由此确认：

- **`(rnrs)` 不是完整 R6RS**，不能把它作为 namespace 或验收的完整覆盖；完整覆盖必须逐项验证 §6.1 的全部库；
- 不能把“拒绝文件 I/O/eval”作为 namespace 安全承诺；完整 R6RS 必然包含文件、`(rnrs eval)` 的 `eval`、`exit` 等能力；
- 安全边界必须依赖 **独立 VM + MEMFS + capability + 固定 Wasm/engineContract**；
- library resolver 必须在 VM 内拒绝 `(chezscheme)` 及任何非 R6RS/非 `(dsh ...)` 库，包括通过 `(rnrs eval)` 的 `environment` 构造路径；
- R6RS `eval` 可以动态求值，但只能看到 resolver 允许的库；规则注册入口只存在于 loader，插件不能直接写入 pin/registry；
- 任何文件 I/O 只在 guest MEMFS 内，项目快照只读、`/tmp` 可写，不暴露宿主路径。

namespace 只解决默认绑定可见性，不替代 VM/进程隔离；这项边界必须由 AC-P5/AC-P7/AC-P8 验证。

### 6.5 FFI 接口（必需）

FFI 是项目扩展的一等能力，不能留作“以后再补”。项目规则和项目插件通过稳定模块使用：

```scheme
(import (only (dsh ffi)
              ffi-call
              ffi-call-async
              ffi-available?))
```

Host 侧 FFI manifest 示例：

```json
{
  "id": "project.hash",
  "module": "dsh-ffi-project",
  "export": "sha256_hex",
  "arity": 1,
  "mode": "sync",
  "capability": "project.hash"
}
```

接口约定：

- `ffi-call id args...`：同步调用，返回 JSON-like 值/string/bytevector；
- `ffi-call-async id args... callback`：仅在长期在线事件循环可用时启用；必须支持挂起、恢复、取消和 late response 丢弃；
- `ffi-available? id`：运行前能力探测；
- 参数/返回值不允许 closure、host object、文件句柄；复杂数据用 bytevector/JSON；
- Host 在 VM 启动时校验 manifest 的 id、arity、版本和授权；未授权的 id 在 guest 内不可见；
- FFI 失败不得造成规则/插件部分注册；错误码稳定（`FFI_UNAVAILABLE`、`FFI_ARITY`、`FFI_TIMEOUT`、`FFI_CANCELLED`）；
- 项目 FFI 声明属于项目扩展元数据，进入 v2 pin 的 `ffi` 字段并影响 `ffiEnvironmentHash`；内置 FFI 实现属于插件发布物，只保存引用/hash；
- 现有 v1 的 FFI 声明不自动迁移，按迁移指南重写；`ffiEnvironmentHash` 变化必须改变 ruleHash。

FFI 的硬门禁：

1. 同步 FFI 必须在 Chez Wasm 内实测字符串入/字符串出，并证明无任意 JS 反射；
2. 异步 FFI 必须在长期在线 VM 上实测挂起/恢复；未证明前 `ffi-call-async` 不能标记为可用；
3. FFI 声明/实现不匹配、超时、取消都有回归测试。

## 7. 项目文件、MEMFS 与 library directory

### 7.1 只读项目快照

每个项目启动前，由 Host 将需要的文件写入 MEMFS：

```text
/project/            只读项目快照
/project/lib/        Chez library
/project/plugins/    已授权插件
/tmp/                可写临时区
/out/                显式导出区
```

首版不直接 `NODEFS` 挂载宿主项目目录，因为那会暴露真实路径和写权限；采用 Host 侧读取、写入 MEMFS 的方式。若后续需要大项目按需读取，再评估只读 mount，并加路径白名单和拒绝写。

已验证 `library-directories` 可设置：

```scheme
(library-directories '("/project/lib" "/project/plugins"))
```

仍需补测“从 MEMFS 路径实际 import 一个 library 并调用”的端到端。

### 7.2 文件能力

- 纯计算插件没有文件 capability；
- `project.read` 只读 `/project` 内路径，拒绝 `..`、绝对路径、符号链接逃逸；
- `project.write` 默认不开放；如开放，只能写 `/out`，由 Host 审核后落项目；
- 项目快照有 bundleHash，VM 启动时校验；
- 任何宿主导入/导出都记录来源 hash。

## 8. 每个项目一个 VM

### 8.1 生命周期

```text
create(projectId, limits)
  → hydrate project snapshot
  → load libraries/plugins
  → register source rules
  → seal
  → invoke
  → close
```

- 一个项目一个 Chez 实例/进程；项目 A 的 registry、插件表、capability 不进入项目 B；
- 同一项目内的规则共享只读插件库，规则注册后 registry 冻结；
- 源码/bundle hash 变化时重新创建 VM，不在旧 VM 内热替换；
- 空闲 VM 可回收，但不得把 A 的状态转交 B。

### 8.2 长期在线协议（硬需求）

用户已确认：每个项目必须支持长期在线 VM，不能把 one-shot/batch 当作最终形态。已实测当前 `run.cjs -q` 的 stdin 是批处理语义，保持管道打开时 Chez 不输出，EOF 后才返回；因此现状**不满足**长期在线要求。

Phase 3 必须先做一个独立 spike，按以下顺序验证可行路径：

1. 用 Chez 的 C/宿主嵌入路径导出可重复调用的 `dsh_dispatch`，由 Node 在同一个 Wasm 实例上同步/异步调用；
2. 若不可行，给 Emscripten guest 加自定义事件循环/长度前缀 stdin bridge，证明同一 VM 可跨请求保持 registry/插件状态且无需 EOF；
3. 若仍不可行，评估 Chez pb-wasm 是否适合该形态；不得用 PTY 或“每次请求重启”冒充在线 VM。

长期在线协议要求：

- 长度前缀帧（requestId、protocolVersion、method、payload）；
- 同一 VM 跨请求保持规则/插件状态，seal 后不热替换；
- 超时、取消、late response 丢弃；
- OOM/崩溃后 supervisor 重启，客户端可重试；
- 健康检查、优雅关闭、空闲回收与重建；
- 不允许用 PTY 作为生产协议。

硬门禁：没有可复现的“同一 VM 连续两次请求、状态保持、无 EOF”证据，Chez 方案不能进入生产；如果 Chez 无法做到，计划应回报并重新选择运行时，而不是静默降级。

### 8.3 资源边界

每个 VM 独立设置：

```json
{
  "wallTimeoutMs": 2000,
  "maxOutputBytes": 1000000,
  "memoryBytes": 268435456,
  "maxSteps": null
}
```

内存上限由 supervisor 进程/Worker 的外层限制实现；Chez 自身的 `maximum-memory` 不能单独作为 OOM 证据。必须故障注入验证：内存耗尽返回结构化错误，supervisor 和主进程存活。

## 9. Pin v2 设计

### 9.1 新格式

```json
{
  "format": "dsh-rule-source-v2",
  "reader": "chez-restricted-reader-v1",
  "treeFormat": "dsh-rule-tree-v1",
  "engineContract": "chez-pb-wasm/10.4.1",
  "engineArtifactHash": "…pinned wasm sha256…",
  "rules": {
    "org.example.positive": {
      "version": "1",
      "source": "…exact project rule source/base64…",
      "sourceBytesHash": "…",
      "treeHash": "…",
      "bundleHash": "…",
      "pluginEnvironmentHash": "…",
      "ffiEnvironmentHash": "…",
      "ruleHash": "…",
      "signature": { "result": "boolean" }
    }
  },
  "projectPlugins": [],
  "ffi": {
    "declarations": [],
    "environmentHash": "…"
  },
  "builtinPluginRefs": []
}
```

Pin 只保存**项目扩展源码**：

- 项目 rule 源码；
- 项目自带插件源码（`projectPlugins`）；
- 项目 FFI 声明/授权；
- 对内置插件/库的 id、version、artifactHash 引用，不复制其源码。

Chez 解释器、Chez 标准库、插件内置的 runtime/stdlib 源码属于插件发布物，不进项目 pin；它们由 `engineContract` + `engineArtifactHash` + `builtinPluginRefs` 固定。否则每个项目 pin 都会重复打包解释器源码，且运行时升级会造成无意义的项目 pin 变化。

`bundleHash` 只覆盖项目扩展源码及其 import 图；解释器/stdlib 的变化由 engine/builtin refs 反映。只存 treeHash 而不存项目源码会让重载依赖外部文件，无法复现。

### 9.2 不兼容与迁移

- v2 **不读取 v1 AST pin**，也不把 v1 AST 自动转换成源码；格式不兼容，遇到 v1 返回 `PIN_FORMAT_INCOMPATIBLE`；
- 旧 v0.18 AST 运行时冻结，仅用于旧 pin 的只读/回滚路径，不再扩展；
- v2 默认启用：新项目默认签署 `PIN_RULES_VERSION=2`；旧 v1 项目保留只读兼容，不自动升级；
- 提供迁移指南，明确需要人工重写，不能声称 AST 能无损还原注释、模块组织或宏展开来源；
- 旧 pin 若要升级，必须重新抽取/重写项目扩展源码并重新签署 v2 pin，不能只改 format 字段；
- `doPinLocked` 的 aggregate 必须包含 `format`、bundleHash、engineContract、engineArtifactHash；缺少任一字段拒绝锁定。

### 9.2.1 旧 AST 迁移指南（计划交付）

必须提供独立文档 `docs/MIGRATION-AST-TO-SOURCE.md`，至少覆盖：

- v1 hook 结构（merge/decision/validate/verify）如何映射成 source descriptor；
- 旧 AST 中丢失的宏/辅助函数/注释必须手工重建；
- truth（仅 `#f` 假 vs v1 false/null）与 `null` 语义差异；
- FFI 声明从 v1 形式迁移到 `(dsh ffi)` manifest；
- 一个 decision + verify 的完整重写示例；
- 迁移后必须用同一 corpus/项目 fixture 做行为对照，记录差异；
- 回滚策略：v2 pin 失败时保留旧 pin/旧运行时只读访问，不自动改写。

### 9.3 重载校验

```text
读 pin
  → 校验 format/version/engineContract 与固定 Wasm 一致
  → 启动匹配 engineContract 的 Chez VM
  → 将 pin 中保存的源码原样交给受控 loader
  → loader 在执行插件代码前计算 sourceBytes/tree/bundle hash
  → 宿主比较 loader 返回的 hash 与 pin 中保存值
  → 受限 reader + plugin imports
  → 注册规则
  → 再校验注册结果与 pin descriptor
```

任一步失败即整体失败，不执行部分规则，不更新 pin。

## 10. 公共 API（计划）

测试导出（只存在于 `experiments/`）：

```js
treeHashForTest(source)                  // 宿主 oracle，仅测试/版本审计
verifyTreeHashForTest(source, expected)  // 生产包不得引用
```

生产接入（另批批准）：

```js
loadSourceRules({ sources, projectPlugins, ffi, engine })
  // → { registry, descriptors, bundleHash, ffiEnvironmentHash, sourceMap }

createProjectRuntime({ projectId, snapshot, ffi, limits })
  // → { start, load, seal, invoke, health, close }
  // invoke 必须在同一在线 VM 内跨请求保留状态
```

生产路径中，hash 由 Chez loader 计算；Host 只校验 loader 返回的 hash 与 pin 中保存值是否一致，不重算、不解析源码树。`treeHashForTest` 和宿主 canonicalizer 不得进入生产包、生产 worker 或 pin 重载路径。内置 Scheme 解释器/标准库源码不通过 `loadSourceRules` 传入，也不写入 pin。

## 11. 验收标准

### AC-T：treeHash

- **AC-T1** 注释/空白、quote 糖、`#xFF` vs 255、字符串转义得到相同 treeHash；
- **AC-T2** 代码变化、symbol vs string、list 顺序变化得到不同 treeHash；
- **AC-T3（仅测试）** Scheme 与宿主 oracle 对所有共享向量一致；该 oracle 不得出现在生产加载路径；
- **AC-T4** SHA-256 标准向量通过；
- **AC-T5** 顶层 forms 顺序、空表、Unicode、边界长度有向量；
- **AC-T6** 不支持/非法 reader 输入稳定拒绝，不产生部分 hash；
- **AC-T7** 生产包/生产 worker 不 import 宿主 oracle；扫描生产依赖图可证明。

### AC-P：插件与源码规则

- **AC-P1** 插件注册/调用/导出查询正常；
- **AC-P2** 重复插件、重复 export、未知插件、hash 不匹配整体失败且原子；
- **AC-P3** 源码规则注册保存 treeHash，调用正确；坏 source 不部分写入；
- **AC-P4** pluginEnvironmentHash 随插件版本/hash/capability 变化；
- **AC-P5** 插件拥有完整 R6RS 标准能力；§6.1 的每个 R6RS 库都可独立 import 并通过最小 smoke；`(chezscheme)`/Chez 专有库/`foreign-procedure`/宿主文件路径被 library resolver 拒绝；R6RS 文件 I/O 只作用于 guest MEMFS；
- **AC-P6** capability 只按 manifest 授权，未授权调用失败并有审计。
- **AC-P7** 通过 `(rnrs eval)` 构造 `(chezscheme)` 或其他非 R6RS 环境同样被拒绝，不能绕过 library resolver。
- **AC-P8（完整性）** 单独的 `(rnrs)` 不能作为完整 R6RS 证据；测试矩阵必须覆盖 `(rnrs eval)`、`(rnrs mutable-pairs)`、`(rnrs mutable-strings)`、`(rnrs syntax-case)`、`(rnrs r5rs)` 等被 `(rnrs)` 漏掉的库，并记录每库的 import/最小行为结果。

### AC-F：文件与 VM

- **AC-F1** 项目快照只读，`project.read` 不能逃出 `/project`；
- **AC-F2** `library-directories` 从 MEMFS 实际 import 成功；
- **AC-F3** 项目 A/B 的 registry/插件/能力隔离，不串状态；
- **AC-F4** VM 超时、超输出、OOM 均返回结构化错误且 supervisor 存活；
- **AC-F5（硬需求）** 同一 VM 连续多次请求、无 EOF、registry/插件状态保持；不能以 batch/one-shot 代替；
- **AC-F6** 在线 VM 健康检查、取消、崩溃重启和空闲回收可验证；
- **AC-F7** 若 Chez pb-wasm 无法满足 AC-F5，方案标记为不满足需求并回报选择其他运行时，不静默降级。

### AC-H：宿主能力

- **AC-H1** JS 回调只经固定 capability ABI，guest 无法获得任意 JS 对象；
- **AC-H2** 回调超时/异常不破坏 VM/宿主；
- **AC-H3** 能力只按 manifest 授权，未授权调用失败并有审计。

### AC-FFI：FFI（必需）

- **AC-FFI1** 同步 `ffi-call` 在规则和项目插件内均可用；
- **AC-FFI2** `ffi-call-async` 在同一在线 VM 内可挂起/恢复；若未证明，必须标 UNVERIFIED 而不是假装可用；
- **AC-FFI3** FFI arity/版本/授权不匹配整体失败且不部分注册；
- **AC-FFI4** 超时、取消、late response 丢弃有回归；
- **AC-FFI5** `ffiEnvironmentHash` 随声明/实现变化；项目 FFI 声明进入 v2 pin，内置实现只存引用/hash。

### AC-PIN：v2

- **AC-PIN1** v2 pin roundtrip：写入、重载、Chez loader 重算 hash、与 pin 比较、执行一致；
- **AC-PIN2** 任一 hash/源码/bundle 被篡改，Chez 重算结果与 pin 不一致即拒绝；
- **AC-PIN3** v2 pin 只保存项目扩展源码/FFI 声明；不包含 Chez 解释器/stdlib 源码，内置插件只存引用；
- **AC-PIN4** 旧 v1 pin 与新格式不兼容：v2 runtime 拒绝 v1，旧运行时冻结；提供迁移指南和人工重写示例；
- **AC-PIN5** 不存在部分写入/部分 seal。

### AC-DOC

- 记录 `engineContract`、reader 版本、tree 编码版本、插件 ABI、限制和迁移说明；
- 结果文件可复现，测试命令固定；
- 未通过门禁的项明确标记 UNVERIFIED，不写“支持”。

## 12. 实施阶段

### Phase 0 — 冻结证据（当前已基本完成）

- 保留 `test-source-tree.mjs`、`test-namespace.mjs`、`test-sha-vectors.mjs`、`probe-*`；
- 生成 `sha-vectors.json`、`source-tree-plugin.json`、`namespace.json`；
- 记录 Chez 10.4.1/Emscripten 版本和 Wasm sha256；
- 不修改生产。

### Phase 1 — 规范与测试 oracle（2–4 工程日）

- 写 `docs/SOURCE-TREE.md`：tag、长度、数字、字符串、错误；
- 在 `experiments/wasm/chez/test-oracle/` 实现宿主 canonical encoder，仅用于测试；
- 扩展共享向量并交叉验证；
- 定义 `dsh/rule-tree/v1` 和 `sourceBytesHash`；
- 明确生产包不依赖该 oracle。

### Phase 2 — 受限 reader 与插件加载（4–7 工程日）

- 实现 `chez-restricted-reader-v1`，替换 Chez `read` 身份路径；
- 实现 `(library ...)` 插件加载和 library-directories；
- 插件 registry、原子注册、导出查询；
- 验证完整 R6RS：逐项 import §6.1 全部库（含 eval/mutable-pairs/mutable-strings/syntax-case/r5rs），不能只测 `(rnrs)`；library resolver 拒绝 `(chezscheme)`/专有库/宿主路径；文件 I/O 只在 MEMFS。

### Phase 3 — 项目在线 VM 与文件（6–10 工程日）

- 实现长期在线协议 spike（自定义 dispatch/C ABI 或长度前缀事件循环）；
- `createProjectRuntime`，MEMFS 项目快照；
- 只读路径解析、library 目录；
- 项目隔离、健康检查、取消、空闲回收和 supervisor 重启；
- 通过 AC-F5/AC-F6 才进入下一步，不接受 batch-only 作为最终形态。

### Phase 4 — Host capability 与 FFI（5–9 工程日）

- 定义 `(dsh host)` ABI，先做同步 `project-read`/`log`/`clock`；
- 定义 `(dsh ffi)`，实现 `ffi-call`/`ffi-call-async`/`ffi-available?`；
- 实测 Chez Wasm 的 C/JS 回调与异步挂起/恢复；
- FFI 授权、超时、取消、审计和 atomic 注册；
- 异步 FFI 与长期在线 VM 必须同期通过；只完成同步 FFI 不足以进入 Phase 5；
- 若同步/异步 ABI 不可行，标记为不满足需求并回报，不静默降级为纯 Scheme 插件。

### Phase 5 — Pin v2 与迁移（5–8 工程日）

- pin schema、项目扩展源码 bundle、Chez loader 重算、宿主 hash 比对；
- 固定 Wasm artifact/engineContract 校验；
- v1/v2 **不兼容**：v2 拒绝 v1；旧运行时冻结只读；
- 写 `docs/MIGRATION-AST-TO-SOURCE.md`、迁移 fixture 和人工重写示例；
- 失败注入、篡改检测和迁移验证。

### Phase 6 — 评审与试点（另批）

- 只读评审、生产门禁、选择项目试点；
- 未获用户批准不替换生产解释器。

## 13. 非目标

本计划不包含：

- 立即改生产 `lib/`、pin 版本或发布包；
- 完整 R7RS/R6RS 实现；
- 在 guest 内运行任意 JS；
- 用 PTY 冒充生产 VM 协议；
- 让插件直接读写宿主文件系统；
- 自动迁移旧 AST pin；
- 在 v2 pin 中复制 Chez 解释器/标准库源码。

## 14. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自研 reader 与 Chez reader 语义差异 | hash 不稳定 | 只让受限 reader 产生身份；Chez read 仅执行/测试 |
| 测试 oracle 与 Scheme 实现漂移 | 测试误导 | 固定向量、CI 交叉验证；oracle 不进入生产 |
| Chez Wasm artifact/engine 被替换 | 身份信任根失效 | pin 固定 Wasm sha256/engineContract；不匹配拒绝加载 |
| 把 `(rnrs)` 误当完整 R6RS | 插件缺 eval/mutable/syntax-case 等标准能力 | 逐库 allowlist + AC-P8 完整矩阵；`(rnrs)` 只作便捷复合库 |
| Chez Wasm C/JS ABI 不可用 | host capability/FFI 失败 | 先做窄字符串 ABI；失败则回报需求不满足，不静默降级 |
| MEMFS 不是真实项目目录 | 大项目不可用 | 小快照预载；后续只读 mount 需安全审查 |
| stdin 仅 batch | 不能长期在线 | Phase 3 独立 spike；不通过则更换运行时，不接受 one-shot 冒充 |
| OOM/资源限制难 | 主进程风险 | 独立 supervisor + 故障注入 |
| 插件/依赖/FFI 变化未纳入 hash | 身份漂移 | bundleHash + pluginEnvironmentHash + ffiEnvironmentHash |
| v2 与旧 AST 不兼容 | 旧项目升级成本 | 迁移指南、人工重写、fixture、冻结旧运行时只读 |
| 许可/构建链 | 发布阻塞 | 锁源 commit、记录 Emscripten/Guix、单独许可审查 |

## 15. 已确认决策与剩余问题

已确认（2026-11-08）：

1. 新规则以源码 `treeHash` 作为稳定身份；v2 与旧 AST **不兼容**，旧 AST 提供迁移指南和人工重写路径。
2. v2 pin **只保存项目扩展源码**（项目规则、项目插件、项目 FFI 声明）；Chez 解释器/stdlib/内置插件源码属于插件发布物，不写入项目 pin。
3. FFI 接口是必需交付，不是可选探索；必须覆盖同步、异步、授权、超时和错误语义。
4. 每个项目必须支持**长期在线 VM**；one-shot/batch 只能作为中间原型，不能作为最终形态。

追加确认（2026-11-08）：

5. 首批 JS capability 仅开 `project.read`、`log.write`、`clock.now`；其余能力后续按 manifest/审计扩展。
6. 插件 namespace 为**完整 R6RS**，不使用裁剪绑定白名单；完整 R6RS 指 Chez 文档列出的全部 R6RS 库（§6.1），不是单独的 `(rnrs)`。`(chezscheme)`/Chez 专有扩展由 library resolver 阻断。插件采用 R6RS `(library ...)` 形态。
7. v2 pin 默认启用；新项目默认 v2，旧 v1 只读兼容、不自动迁移。
8. 异步 FFI 与长期在线 VM 同期交付；同步 FFI 先行不能作为完成条件。

## 16. 验证命令

```powershell
$node = 'C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd C:\Users\29436\Desktop\Projects\dsh-data-curation\experiments\wasm\chez
& $node test-source-tree.mjs
& $node test-namespace.mjs
& $node test-sha-vectors.mjs
```

结果目录：

```text
experiments/wasm/results/chez/10.4.1/source-tree-plugin.json
experiments/wasm/results/chez/10.4.1/namespace.json
experiments/wasm/results/chez/10.4.1/sha-vectors.json
```

## 17. 当前状态

- 原型测试：treeHash/测试期宿主验证、插件/规则、窄 namespace、`(rnrs)` 覆盖缺口 probe、MEMFS、library-directories、SHA 向量均通过；完整 R6RS 逐库矩阵和 library resolver 尚未实现；生产宿主不重算；
- 生产未改：`lib/`、pin、发布物、`package.json` 均未改；
- 未 commit：`experiments/` 仍是未跟踪目录；
- 未实现：自定义受限 reader、测试 oracle（宿主 canonical encoder，仅测试）、JS capability ABI、FFI ABI、长期在线协议、pin v2、迁移指南；
- 长期在线与 FFI 已提升为硬需求；当前 batch-only 证据不满足，Phase 3/4 必须先过 spike；
- 本计划为 pending approval，等待审阅。
