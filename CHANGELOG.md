# Changelog

All notable changes to `dsh-data-curation` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.3.1] — 2026-10-29

### Fixed

- **peer 范围静默排除预发布版 harness**：`>=0.1.2-rc.1 <0.3.0` 这类范围在 node-semver 下
  匹配不到 `0.2.1-rc.2`（范围内没有任何比较符落在 `0.2.1` 元组且自身带预发布标签），
  安装时 peer 校验会被静默跳过（实测 `semver.satisfies('0.2.1-rc.2', '>=0.1.2-rc.1 <0.3.0') === false`）。
  五个 `@deepseek-ai/*` peer 改为
  `>=0.1.2-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`
  —— 对 `0.2.1-rc.2` / `0.2.0-rc.3` / `0.1.3` / `0.2.5` 均成立；未来 harness 发布
  `0.2.2-*` 时需要再加一条对应分支。

## [0.3.0] — 2026-10-29

发布前加固：不新增功能，只修正确性、并发与发布工程问题。

### Fixed

- **CSV 记录源直接崩溃**：`records: { kind: 'file', path: '*.csv' }` 调 `rowsToObjects`
  时漏传表头，抛 `TypeError`。现在缺键列会报可读错误（`记录源缺少键列：<key>`）。
- **`sources: ['.']` 让基线一开始就漂移**：工作区目录被算进源基线，第一次写库后
  每个门禁都判「源基线漂移」。`buildManifest` 现在始终排除 `stateDir`，并在初始化时
  提示「sources 包含工作区目录 .curation，已从基线排除」。
- **契约含 `undefined` 键时哈希不稳**：`stableStringify` 会写出字面量 `undefined`，
  而库内存的是 JSON 往返后的对象，重读即误报「契约被手工改动」。`contractHash`
  先做 `JSON` 规范化再算哈希。
- **落表失败可能留下半截状态**：写入失败时只返回错误、事务仍提交。现在
  curated 表 + `ledger` + `applied` 在**一个事务**里提交，任何一格不一致或
  SQLite 报错都整体回滚。
- **比对结果与运行摘要分开提交**：`decision` 与 `run` 现在同一事务写入，
  不会出现「裁定引用了不存在的 run」。
- **JSONL 记录源错误没有行号**：现在报 `记录源第 N 行无法解析：<原因>`。
- **同一批里的重复记录键静默覆盖**：现在整批拒绝（`批次内重复记录：X`）。
- **打包会把符号链接指向的外部文件打进去**：被引用的脚本若为符号链接，现在跳过并警告。
- **打包条目过多/过大**：超过 65535 个条目或 4 GiB 时给出明确错误（不支持 zip64）。

### Added

- **项目锁**（`.curation/lock`）：同一项目同一时刻只允许一个写操作（init / contract /
  submit / compare / apply / exporter / pack / verify）。租约（默认 10 分钟）+ 进程判活：
  崩溃残留的锁在同机上立即失效，别的主机上等租约过期；`curation_status` 会显示持有者。
- **`busy_timeout = 5000`**：单事务相撞短暂等待，而不是立刻 `database is locked`。
- **工作区版本门**：`PRAGMA user_version` 更高或更低都拒绝打开，并给出升级/重建提示。
- **`docs/DATABASE.md`**：逐表 DDL、索引、「最新 = MAX(id)」语义、curated 表规则、
  各操作读写矩阵、备份/打包与排障命令。
- 发布元数据：`repository` / `homepage` / `bugs` / `author`；`SECURITY.md`；本 CHANGELOG。
- 测试 66 → 85 个（新增 hardening / lock / atomicity 与打包符号链接用例）。

### Changed

- `selfcheck` 现在**要求**真实 GitHub 仓库地址，并拒绝占位或本地路径形式的
  `repository` / `homepage` / `bugs`。
- 写入路径的基线校验走 `size + mtime` 快速通道（未变的文件复用旧哈希）；
  `verify` 与 `pack` 仍全量重算。

### Known limitations

- 交付表仍只支持一张（契约里的一个 `delivery`）。
- 连接仍是「每个操作新开」，未做连接复用；锁与 `busy_timeout` 已覆盖实际并发风险。
- `pending.json`、`contract.json`、`exports/` 是可重建派生物，不是权威。

## [0.2.0] — 2026-10-29

### Added

- **会话进度条**（数据抽象，不预设生命周期）：`curation_progress` 工具以
  `{ upsert, remove, clear }` 补丁更新一份 `{ bars }` 文档，经会话投影
  `curation-progress` 渲染在输入框上方（`conversation.input.dock`，order 40）。
  最多 8 条、状态 `idle/running/paused/done/error`、可用 `value/total` 或 `percent`。
- 客户端 bundle（`exports['./client']`，手写、无构建步骤、只依赖 `react`）。

## [0.1.0] — 2026-10-29

首次公开版本。

### Added

- 项目模型：只读原始材料 + 单一工作区 SQLite（`.curation/project.sqlite`）。
- 八阶段流程：`curation_init` → `curation_contract` → `curation_submit` →
  `curation_compare` → `curation_apply` → `curation_verify` → `curation_export` →
  `curation_pack`，以及 `curation_status` / `curation_exporter`。
- 三通道比对（≥2 个有效通道一致才接受）、五类待裁定原因、逐格留痕。
- 13 项验收门禁；源基线校验和闸门；落表前 `VACUUM INTO` 备份。
- 导出注册表：内置 csv/jsonl/markdown/sqlite，可注册项目导出器或外部命令。
- 三个技能（`data-curation`、`data-curation-contract`、`data-curation-audit`）、
  斜杠命令 `/curation` `/curation-status` `/curation-verify`、契约模板。
- 零第三方运行时依赖；Node ≥ 24（内置 `node:sqlite`）。

[Unreleased]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Antigen-1/dsh-data-curation/releases/tag/v0.1.0
