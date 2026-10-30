# Changelog

All notable changes to `dsh-data-curation` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.5.0] — 2026-10-30

来自一次真实会话（999 条 × 5 字段，6 小时核对）的取证：curation API 只覆盖了前 3 小时的 40 次调用，
之后 16 小时里操作者直接开工作区库 135 次。这一版补的就是那 135 次背后的缺口。

### Added

- **`curation_query` 只读查询**：`counts` / `pending` / `cells` / `votes` / `submissions` / `runs` / `schema`；
  `limit` 默认 50 且不设硬上限；`format: "table" | "json"`（table 按 CJK 宽度对齐）。
  以 readOnly 打开工作区，不加锁、不跑门禁、不写任何东西。
- **批量裁定协议**：`compare` 命令策略可显式声明 `batch: true`，一次调用判一批
  （stdin `{kind:"compare-batch", cells:[…]}`，stdout `{results:[…]}`）。真实项目里
  逐格 spawn 曾产生约 5,000 次子进程，是单次 compare 574s 与两次 abort 的主因。
- **增量比对**：`curation_compare` 新增 `scope: "auto" | "all"`，默认只重判有新提交或从未判过的格；
  契约哈希变化时自动回到全量。run 摘要记录 `scope/recomputed/skippedCells/contractHash`。

### Fixed

- **验收失败被渲染成「操作失败」**：`doVerify` 对 `FAIL` / `CONDITIONAL` 返回 `ok:false` 但没有 `error`，
  `verifyLines` 里的 `failure()` 守卫抢先，把「3,124 格待裁定」吞成一句「✗ 操作失败」，操作者
  此后不再跑验收。现在只有没有 `checks/status` 的结果才显示「操作失败」，并在尾部输出
  待裁定原因分布。

### Changed

- 契约版本仍为 **4**：`batch` 是可选字段，旧契约合法（未声明的策略行为完全不变）。

## [0.4.1] — 2026-10-30

### Fixed

- **所有工具在真实宿主里报 `content.some is not a function`**：`output.render` 返回了单个
  content block，而宿主要求的是数组，于是工具调用在**操作已经成功之后**被判定失败（例如
  `curation_init` 已建好工作区但界面报错）。现在 `render` 统一返回 `[{ type: 'text' }]`。
- `@deepseek-ai/dsh-tools` 不可解析时（测试、桩加载）退化为恒等 `defineTool`，不再直接崩。

### Added

- `test/tools.test.js`：逐个工具断言失败结果与成功结果的渲染形状；覆盖不到宿主包时也能跑。

## [0.4.0] — 2026-10-29

判定逻辑成为契约的一部分：哪些票算「同一个事实」、写哪个通道的原文，都可以由项目声明，
也可以换成项目自己的命令。

### Added

- 契约 v4 新增可选 `adjudication` 块：`compare`（哪些票算一致）与 `select`（写哪个写法），
  支持在 `adjudication.fields.<name>` 按字段覆盖。
- 内置 `compare`：`exact`、`numeric`（`tolerance`）、`ordered-groups`（`separator`）；
  内置 `select`：`first-valid`、`longest`、`channel-order`（`order`）、`lowest`、`highest`。
- 两个钩子都可改成项目命令：stdin 收 `{ kind, record, field, values }`，`compare` 回
  `{ groups: [[…]] }`，`select` 回 `{ index }` 或 `{ value }`。
- `decision.synthesized` 留痕：由 `select` 合成出的写法可被审计；
  `curation_compare` 与 `curation_status` 显示合成值格数。
- 工作区 schema v3：v2 工作区打开时自动补 `decision.synthesized` 列（旧行按 0 处理）。

### Changed

- 契约版本 3 → 4，旧契约需重新签署；`templates/contract.example.json` 增加策略示例。
- `curation_compare` 的描述与输出说明「一致」由契约策略判定。

### Fixed

- 契约 `version` 字段此前会被静默改写为当前版本；现在旧版与未来版本都明确报错，
  避免用错误的规则解释历史结论。
- 策略命令失败、超时、输出格式不对、下标越界时，该格一律进待裁定
  （`adjudicator_error` / `adjudicator_invalid`），绝不回退到默认策略。

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

[Unreleased]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Antigen-1/dsh-data-curation/releases/tag/v0.1.0
