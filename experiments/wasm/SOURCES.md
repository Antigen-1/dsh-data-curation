# 固定来源与未知项

本文件只记录构建/复核时必须固定的上游身份。仓库事实以 baseline `a0d5a4d082539460a3d841764c28b6b8043567dc` 为准；运行时官方文档见对应链接。任何未在这里出现的版本都不算已锁定。

## Hoot

| 项 | 固定值 |
|---|---|
| 官方仓库 | https://codeberg.org/spritely/hoot |
| tag | `v0.10.0` |
| tag object | `c8b6070275f2bcb34edc5f93d038d27eec9c0237` |
| source commit | `945240fe7ebda8dee09e3036ce8661f4878b3877` |
| 发布时间 | 2026-10-28（上游 tag 元数据） |
| 运行时模型 | whole-program Scheme → Wasm GC |
| 官方兼容性 | Node.js 22+；Node 24 属目标测试平台；WASI 不支持 |
| 许可证 | Apache-2.0，另有 LGPL-3.0-or-later 文件；交付前按实际文件审计 |

官方入口：

- README：https://codeberg.org/spritely/hoot/raw/branch/main/README.md
- 文档：https://spritely.institute/files/docs/guile-hoot/latest/
- 项目模板：https://codeberg.org/spritely/hoot/src/branch/main/examples/project-template

构建注意：README 说明需要 bleeding-edge Guile；Guix 是官方推荐路径。必须用 `channels.scm` + `manifest.scm` 固定环境，不能只运行未锁版本的 `guix shell guile guile-hoot`。

## Chibi-Scheme

| 项 | 固定值 |
|---|---|
| 官方仓库 | https://github.com/ashinn/chibi-scheme |
| tag | `0.12` |
| source commit | `08e23be118e7de8cf29d606bc4793371c0ace680` |
| 运行时模型 | C VM 编译为 Emscripten Wasm；动态源码由 VM `eval` |
| 许可证 | BSD-3-Clause（交付前按实际文件审计） |

官方入口：

- 仓库：https://github.com/ashinn/chibi-scheme/tree/0.12
- Emscripten 构建目录：https://github.com/ashinn/chibi-scheme/tree/0.12/contrib/emscripten
- 手册：https://github.com/ashinn/chibi-scheme/blob/0.12/doc/chibi.scrbl

硬约束：不假设 WASI；必须移除 stock `(chibi emscripten)` 的任意 JS 通道、NODEFS、动态 `.so` 与 process/file 能力。构建前阅读该 tag 的实际 Emscripten 脚本，不引用其他版本的行为。

## Chez Scheme

| 项 | 固定值 |
|---|---|
| 官方仓库 | https://github.com/cisco/ChezScheme |
| tag | `v10.4.1` |
| source commit | `e95a7efbafa2cf3bd5343ea542e6bc909a7ab2c4` |
| 运行时模型 | Chez C runtime + portable bytecode (pb) VM + boot files；通过 Emscripten 运行 |
| 语言合同 | R6RS 超集；R7RS 差异必须单列 |
| 许可证 | Apache-2.0（含 NOTICE；交付前审计） |

官方入口：

- README：https://raw.githubusercontent.com/cisco/ChezScheme/v10.4.1/README.md
- BUILDING：https://raw.githubusercontent.com/cisco/ChezScheme/v10.4.1/BUILDING
- IMPLEMENTATION：https://raw.githubusercontent.com/cisco/ChezScheme/v10.4.1/IMPLEMENTATION.md
- CSUG：https://cisco.github.io/ChezScheme/csug/use.html
- Foreign Interface：https://cisco.github.io/ChezScheme/csug/foreign.html

硬约束：不能称为原生 Wasm code generator。动态 compiled `eval` 需要 `petite.boot + scheme.boot`；只有 `--empetite` 的 Petite 路线必须标为降级配置。

## 构建与隔离工具

| 工具 | 官方入口 | 固定策略 |
|---|---|---|
| Guix time-machine | https://guix.gnu.org/manual/en/html_node/Invoking-guix-time_002dmachine.html | `channels.scm` + `manifest.scm`；首次进入环境时记录 channel commit 与实际包版本 |
| Akku | https://gitlab.com/akkuscm/akku | `Akku.manifest` + `Akku.lock`；恢复只 `akku install` |
| Emscripten Asyncify | https://emscripten.org/docs/porting/asyncify.html | 只在实测可构建且通过挂起/恢复测试时声明 async-ffi |
| Node Worker limits | https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerresourcelimits | 只作外层 wall/JS heap 参考，不冒充 Wasm 内存上限 |
| Node 24 WebAssembly | https://nodejs.org/docs/latest-v24.x/api/ | 逐项探测 GC、tail-call、exception 等能力；缺失必须返回能力错误 |

## 尚未锁定（禁止当作已知）

- Guix channel commit 与 Hoot 的 Guile 依赖 commit：必须进入 Guix 环境后由 `guix describe -f channels` 生成并提交。
- Emscripten SDK 精确版本与构建 flags：Chibi/Chez 构建前写入各自 `toolchain.json`。
- Hoot 生成的 helper Wasm/`reflect.js` 精确文件清单：构建后按实际产物记录。
- Chez 的 boot 文件哈希与完整资产字节数：构建后记录。
- Podman Desktop 只有 GUI 时的 engine/CLI 状态：Phase 0 不需要；构建前记录 `podman version`、machine 状态或明确缺失。
- Windows/Linux/macOS × x64/arm64 中未实测的平台：结果必须写 `unknown`，不得用上游 README 推断通过。
