# Scheme → Wasm 探索

本目录是**隔离探索区**。它不改变生产解释器、`lib/rules/`、v1 AST、pin、golden hash 或发布流程。结果只用于运行时选型，ADR 不会自动批准生产迁移。

## 先做什么

1. 读 [CONTRACT.md](CONTRACT.md) 与 `contract/contract.json`，确认统一请求/响应和语义边界。
2. 读 [LIMITS.md](LIMITS.md)、[SUPERVISION.md](SUPERVISION.md)、[ASYNC-FFI.md](ASYNC-FFI.md)，再开始任何 guest 构建。
3. 用 `node/oracle.mjs` 在当前解释器上跑 `fixtures/corpus.json`，得到基线结果。
4. 每个候选先过最小 smoke：启动 → 动态 eval → guest 内动态注册 → 基本隔离。任一失败即停在该候选，不进入完整供应链或跨平台投入。
5. 只有 smoke 通过后，才按 [SOURCES.md](SOURCES.md) 固定工具链、构建完整资产并把原始日志写入 `results/<engine>/<version>/`。

完成判据：`results/node-oracle.json` 存在且 `ok: true`；`results/phase0-evidence.json` 记录生产回归与边界；`results/<engine>/<version>/smoke.json` 给出 `continue | fixed-only | stop`；任何生产文件未被本目录代码写入。

## 边界

- 本轮只探索**执行语义**；guest 不产出 v1 AST、pin descriptor 或 canonical ruleHash。
- 禁止把宿主 `process`、`require`、文件、网络、环境变量或任意 JS eval 暴露给 guest。
- 动态注册必须在 guest 内可观察；不能用固定 AOT 结果替代动态源码结果。
- 所有候选共用同一 corpus 和错误码；差异写进结果，不静默归一化。
- Windows 宿主只负责编辑与 Node 基线；Linux/Guix 构建通过 Podman 时须记录容器镜像/工具链，且 Podman 不替代 Guix/Akku 锁文件。

## 目录

| 路径 | 作用 |
|---|---|
| `contract/` | 机器可读协议 |
| `fixtures/` | 引擎无关 corpus 与最小 smoke 选择 |
| `node/` | 当前解释器 oracle 与结果比较器 |
| `hoot/`、`chibi/`、`chez/` | 各候选的构建与适配器 |
| `results/` | 原始日志、环境、测量、smoke 判定 |

## 运行基线

```powershell
$node = 'C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node experiments/wasm/node/oracle.mjs --baseline
```

完成判据：命令退出码 0，并打印 `baseline: <n>/<n> passed, 0 failed`；结果写入 `results/node-oracle.json`，其中 `ok: true`。

候选适配器只需导出 `createAdapter({repoRoot, experimentsRoot})`，并实现 `invoke(request)`：

```powershell
& $node experiments/wasm/node/oracle.mjs --adapter hoot/adapter.mjs --out results/hoot/corpus.json
& $node experiments/wasm/node/oracle.mjs --compare results/node-oracle.json results/hoot/corpus.json
```

## 当前状态

- Phase 0：完成（contract、31 项 corpus、production oracle、资源/监督/异步 FFI 文档、`results/phase0-evidence.json`）。
- Hoot 0.10.0：`fixed-only`；fixed-aot 通过，动态 eval 在 `load_main` 中报 `$invalid-continuation`。
- Chibi 0.12.0：`pure-dynamic`；最小 smoke 3/3，完整 corpus 15/31，`(chibi emscripten)` JS 逃逸已阻断。
- Chez 10.4.1：`pure-dynamic`；最小 smoke 3/3，完整 corpus 16/31，host→guest 当前使用 Scheme datum 而非 JSON。
- 选型结论见 [ADR-0001](ADR-0001-wasm-runtime-selection.md)：本轮不替换生产解释器；若继续，优先 Chibi 硬化。内存/OOM、异步 FFI、双构建和许可审计仍未完成。
- Podman 容器 `guix-work` 可用于复现构建；WSL 仍可用，但本轮不再修改工作区外环境。
