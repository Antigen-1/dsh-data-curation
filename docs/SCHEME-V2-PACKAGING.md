# Scheme v2 发布包边界

0.21.1 指当前候选包；候选版本号可自由 bump，只有 annotated tag 才算正式发布。本次 0.21.1 是候选，不是正式发布。本文的包/闭包结论对候选和最终版本同样适用。

## 平台

- 运行时要求：Node.js 24 或更新（`engines.node`）。
- 引擎形态：wasm32 + JS glue；没有 native addon，也没有 Win32 API 调用，因此不绑定 CPU 架构或操作系统。
- 当前发布验证基线：`win32-x64` + Node.js 24。
- Linux x64 + Node.js 24 已跑通全量测试（388/388）；macOS 尚未验证；Windows x64 + Node.js 24 仍是验证基线。包不再用 `os`/`cpu` 阻止安装，运行时也不再按平台直接拒绝。
- 构建工具链：Emscripten 3.1.6、Chez Scheme 10.4.1。

## 发布闭包

`assets/chez-wasm/10.4.1-c/` 只包含以下文件：

- `scheme-c.js`
- `scheme-c.wasm`
- `scheme-c.data`
- `online-vm-abi.json`

`assets/chez-wasm/engine-registry.json` 固定 `engineArtifactHash`、四个文件的 hash/size，以及 data archive 内的 `petite.boot`、`scheme.boot`、`online-vm-c.scm`、`plugin-loader.scm`、`source-tree-reader.scm`。运行时只按 registry 校验，不从外部路径加载引擎。

不包含 Chez Scheme 源码树。`native/chez/` 只保留本项目自己的 guest/C/构建脚本。

## 许可

- 项目：MIT（`LICENSE`）。
- Chez Scheme 10.4.1：Apache-2.0，副本 `LICENSES/Apache-2.0.txt`。
- Emscripten 3.1.6 生成的 glue/runtime：MIT/UIUC，副本 `LICENSES/MIT.txt`，上游 LICENSE 链接见 `NOTICE`。
- lz4：BSD-2-Clause，副本 `LICENSES/BSD-2-Clause.txt`。
- Node.js 不随包分发，由宿主提供；运行时要求 Node >=24（`engines.node` 是声明，默认不阻止安装；Scheme v2 `open` 时仍会检查并抛 `E-UNSUPPORTED-PLATFORM`）。

二进制分发同样触发这些许可的 notice/source-offer 义务；不能因为“没有分发源码”而省略。

## 可复现性结论

- `scheme-c.wasm` 与 `scheme-c.data` 在相同 Chez/Emscripten 输入下稳定；此前多次构建观察到一致 hash。
- `scheme-c.js` 的字节不可复现：Emscripten 3.1.6 生成的 glue 包含构建期路径/顺序差异。不同构建会得到不同 JS hash。
- 因此引擎身份不由“重新构建得到同一 JS”定义，而由 **checked-in artifact + `engine-registry.json` 的 hash** 定义。任何重建都必须 refresh registry 并重新生成 fixture；不能把旧 fixture 配新 engine。
- 重建后的 fixture 生成顺序：
  - `node scripts/make-scheme-v2-pin-fixture.mjs`
  - `node scripts/make-scheme-v2-plugin-fixture.mjs`
  - `node scripts/make-scheme-v2-program-fixture.mjs`
  - `node scripts/make-scheme-v2-program-static-fixture.mjs`
- 若后续要求 bit-reproducible 发布，需要先修复 Emscripten glue 的路径/顺序差异，或改为只发布 wasm/data、由审核过的固定 glue 加载；0.21.1 不宣称已做到。

## 自检

`node scripts/selfcheck.mjs` 扫描 `package.json#files` 的发布文件（含二进制 magic、`assets/SHA256SUMS`、engine registry 闭包），通过时输出实际扫描文件数；以该输出为准。
