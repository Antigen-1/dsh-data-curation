# ChezScheme 源码树身份与插件方案 — 审阅包

日期：2026-11-08  
状态：计划 pending approval；仅原型实验，生产 `lib/`、pin、发布物未修改。

## 包内容

```text
plan/
  chez-source-tree-plugin-plan.md      # 待审阅计划（Revision 4）
evidence/
  source-tree-plugin.json              # treeHash + host oracle + 插件/规则
  sha-vectors.json                     # SHA-256 标准向量
  namespace.json                       # 窄 namespace 隔离证据
  r6rs-coverage.json                   # (rnrs) 覆盖缺口与完整库清单
  smoke.json / corpus.json             # Chez pb-wasm 动态执行基线
code/
  10.4.1/                              # Chez 10.4.1 pb-wasm 运行时与 runner
  source-tree.scm                      # Scheme 侧 canonical tree/SHA/plugin registry
  test-tree-and-plugins.scm
  test-source-tree.mjs
  test-namespace.mjs
  test-sha-vectors.mjs
  probe-r6rs.scm
  probe-rnrs-coverage.scm
  guest.scm / boot.mjs / adapter.mjs   # 现有 one-shot 原型
results/chez/10.4.1/                   # 本包内复现时生成的结果
```

运行时二进制：`code/10.4.1/scheme.{cjs,wasm,data}`，用于复现；不是生产依赖。

## 核心证据

- **treeHash**：`dsh-rule-tree/v1` 规范化二进制编码 + Scheme SHA-256；注释/空白、quote 糖、`#xFF`/`255`、字符串转义归一化；代码、symbol/string、列表顺序变化。
- **Scheme/宿主一致**：`baseTreeHash=d98c8a188996ffa7bbcfdd21d536b9695a7cccbc2f872e43d7a3ae01855a549e`，`hostVerified=true`。宿主 oracle 仅测试用，生产不重算。
- **插件/规则**：`register-plugin!`、`plugin-call`、`register-rule-source!`、`rule-call` 均返回 42；重复/未知操作不产生部分写入。
- **SHA-256**：空串、`abc`、long 向量通过。
- **MEMFS/library-directories**：`/tmp` 可写可读；library 目录可配置。
- **namespace**：窄 allowlist 可阻断文件/import；`(rnrs)` 可执行 `(+ 1 2)`、`open-input-file`/`exit` 可用，但 `eval`、`environment`、`set-car!`、`string-set!`、`syntax-case` 在 `(rnrs)` 中不可用；显式 `(rnrs eval (6))` 才提供 `eval`。详见 `evidence/r6rs-coverage.json`。

## 未完成/未验证

- 尚未实现 Chez 官方 R6RS 库清单的逐库 import/行为矩阵（计划的 AC-P8）。
- 尚未实现长期在线 VM 协议；现有 `run.cjs -q` 是 stdin batch-only。
- 尚未实现宿主 C/JS capability 回调、同步/异步 FFI ABI。
- 尚未实现 v2 pin schema、迁移指南、完整 library resolver。
- 因此计划仍为 **pending approval**，不能据此批准生产迁移。

## 复现

使用 Node.js 24：

```powershell
$node = 'C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd C:\Users\29436\Desktop\Projects\dsh-data-curation\experiments\wasm\reviews\chez-source-tree-plugin-2026-11-08\code
& $node test-source-tree.mjs
& $node test-namespace.mjs
& $node test-sha-vectors.mjs
```

测试会在包内 `../results/chez/10.4.1/` 重新生成结果；`evidence/` 是本次审阅的快照副本。

## 关键设计结论

1. 源码语法树 hash 作为稳定身份；宿主不维护生产 canonicalizer。
2. v2 pin 不兼容旧 AST，只保存项目规则/项目插件/项目 FFI 源码；解释器与内置库由 engine artifact 固定。
3. 插件默认 namespace 是 **完整 R6RS 库清单**，不是单独的 `(rnrs)`；`(chezscheme)`/专有扩展由 library resolver 阻断。
4. 安全边界是独立 VM + MEMFS + capability；不能把“裁剪 namespace”当作文件/eval 隔离。
5. 长期在线与异步 FFI 同期交付；未通过硬门禁不进入生产。
