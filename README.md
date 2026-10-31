# dsh-data-curation

契约驱动的数据核对 / 清洗模式，作为 DeepSeek Harness 插件运行。

> **English TL;DR** — A contract-driven curation mode for DeepSeek Harness.
> A project is **read-only source material + one workspace SQLite**
> (`.curation/project.sqlite`, built-in `node:sqlite`, no third-party dependency).
> A project-level **pin** declares defaults plus one entry per delivery table;
> the pin, channel submissions, decisions, ledger, curated tables and registered
> exporters all live in that single file. Each extraction channel reports
> independently; a cell is accepted only when the pin's comparison strategy finds
> **two valid channels agree**; writes are keyed by record id + field, backed up
> with `VACUUM INTO`, executed in one transaction and re-read. `curation_verify`
> is the single gate that says PASS / CONDITIONAL / FAIL, per table and overall.
> A project can be packed into one zip for archival. Local files only, no
> network, no telemetry. Requires Node >= 24.

它把"从原始材料里抽字段、核对、写交付表"这件事拆成八个阶段，并用工具把
**原始数据不可变、多通道独立、逐格留痕、未决不自动改表**这四条纪律固定下来，
而不是靠模型自觉。

## 它解决什么问题

表格/文档型核对里最常见的四类事故：

1. **原始数据被顺手改掉** —— 抽取时把源材料覆盖成"清洗后"的版本，之后再无法对账。
2. **单通道冒充多通道** —— 把同一份文本喂给两个"通道"，等于只有一个证据来源。
3. **冲突被静默抹平** —— 两处说法不一致时凭印象挑一个写进表，异议消失。
4. **验收只看结果不看过程** —— 表看着对，但没有证据链，无法回答"这一格凭什么"。

本插件对应的四个强制机制：源基线校验和闸门、通道独立提交、≥2 有效通道一致才
接受、逐格 ledger + 可复算验收。

## 为什么用单一 SQLite 工作区

一个项目就是**只读源 + 一个工作区数据库**：pin、导出器、通道提交、比对结果、
逐格留痕、curated 交付表全在 `.curation/project.sqlite` 里，导出文件只是派生物。

- 单事务写入 + 回读比对，崩溃只会留下旧表或新表，不会有半张表；
- 验收用 SQL 复算（覆盖、双通道、留痕、一致性、留痕与裁定 run 对账）；
- 交付表是库里普通表，按主键逐格更新，不重写整张表；多张表互不串数据；
- 迁移/归档用 `curation_pack` 打成一个 zip：工作区快照 + pin + 导出器 + 源基线 +
  被引用的外部脚本，换个地方解开就能继续核对漂移。

用的是 Node 内置 `node:sqlite`：**不引第三方依赖**。该模块自 Node 23.4 起无需
flag，因此本包要求 **Node >= 24**（`engines` 已声明）。

## 两层 pin（v5）

pin 是项目的口径快照，分两层：

```jsonc
{
  "version": 5,
  "project": { "name": "esd-review", "description": "…" },   // 只允许 name / description
  "defaults": {                                               // 只允许这五项
    "channels": [{ "name": "text" }, { "name": "vision" }],
    "normalization": { "mode": "safe" },
    "evidence": { "required": true },
    "gates": { "minAcceptedRatio": 0 },
    "adjudication": { "compare": { "strategy": "exact" }, "select": { "strategy": "channel-order" } }
  },
  "tables": [{
    "table": "esd_main",                                      // 交付表名 = 库里 curated 表名
    "key": "admission_id",                                    // 主键列
    "purpose": "主结果表",
    "status": "active",                                       // active | retired
    "records": { "kind": "db", "db": "raw/source.sqlite", "table": "patients", "key": "admission_id" },
    "fields": [ { "name": "location", "type": "text" } ],
    "gates": { "minAcceptedRatio": 1 }                        // 表级覆盖，逐键合并
  }]
}
```

- `defaults` 是默认值，表可以按块覆盖；`mergeTable` 的规则：channels 整组替换、
  synonyms 同名合并、evidence/gates 叶子合并、adjudication.compare/select 整对象
  替换 + fields 按字段合并。effective 配置只物化一次，落在 `table_pin` 里。
- pin 一次冻结整个项目：`pin_hash = sha256(canonical-json)`，同时写
  `.curation/pin.sha256` 封印与 `pin.json` 人读镜像；库里的 `pin` 行是权威。
- 改口径 = 重新签署（`force: true`），所有表 revision+1，旧 `table_pin` 保留为历史；
  旧结论与新 pin 不再混用（decision 绑 `pin_id` / `table_pin_id`）。
- 表登记：`curation_init({ tables })` 可预告；签署 pin 时自动登记；已登记的表
  不得从 pin 里省略；不再交付的表改 `status: "retired"`（只读、导出默认跳过、
  pack 仍含）。

## 八阶段

```
0 立项    curation_init        源文件逐个 sha256 → .curation/manifest.json + project.sqlite
                               （可用 tables 预告表名）
1 签署    curation_pin         项目默认 + 每表口径 → 哈希封印（dryRun 只校验）
2 采集    curation_submit      每张表、每个通道独立提交（禁止先合并再提交）
3 比对    curation_compare     逐格比对（策略由 pin 决定）→ 接受 / 待裁定
4 落表    curation_apply       VACUUM INTO 备份 → 单事务 upsert + 逐格回读（只留真实变化）
5 验收    curation_verify      项目级 5 项 + 每表 13 项门禁，FAIL > CONDITIONAL > PASS
6 导出    curation_export      内置 csv/jsonl/markdown/sqlite，或多表 sqlite 快照
7 打包    curation_pack        工作区快照 + pin + 导出器 + 基线 + 被引用脚本 → zip
8 汇报    curation_status      只读汇总；细查用 curation_query，备注用 curation_note
```

可选项：长任务用 `curation_progress` 在输入框上方挂进度条（纯数据，见下文）。

## 工具（13 个）

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `curation_init` | 建立项目、记录源基线、预告表 | `sources`、`tables`、`force` |
| `curation_pin` | 签署/校验项目 pin | `pin`、`dryRun`、`force`、`reason` |
| `curation_submit` | 提交一个通道对一批记录的抽取 | `table`、`channel`、`batch`、`records` |
| `curation_compare` | 逐格比对，写入结论 | `table`、`records`、`fields`、`scope`、`full` |
| `curation_apply` | 把接受值写进 curated 表 | `table`、`dryRun`、`keepBackups` |
| `curation_verify` | 项目级 + 表级验收门禁 | `table`、`includeRetired` |
| `curation_status` | 只读汇总（项目 / pin / 表 / 最近落表 / 锁） | — |
| `curation_query` | 只读查询：counts / pending / cells / votes / submissions / runs / meta / events / schema | `what`、`table`、`record`、`field`、`status`、`channel`、`reason`、`limit`、`format` |
| `curation_note` | 追加项目级 / 表级备注（只追加事件） | `text`、`table` |
| `curation_export` | 导出 curated 表 | `format`、`out`、`table`、`includeRetired` |
| `curation_exporter` | 注册 / 移除项目导出器 | `action`、`name`、`command`、`args` |
| `curation_pack` | 打包整个项目（含被引用脚本） | `out`、`label` |
| `curation_progress` | 输入框上方进度条（纯数据） | `upsert`、`remove`、`clear` |

流程里所有 `cwd` 都是项目根绝对路径；`stateDir` 默认 `.curation`。

## 多表

- 一张表一个 `tables[]` 条目；`table` 同时是交付表名，必须是合法 SQL 标识符且不能
  占用状态表名（`meta`、`submission`、`pin`、`ledger`…）。
- 记录键只在表内唯一：同一个 `record_id` 可以同时出现在两张表里，提交、结论、
  留痕、验收都按 `(table_id, …)` 隔离，互不串数据。
- 多表项目调用 `curation_submit/compare/apply/verify/export` 必须给 `table`；
  单表项目可省略。
- `curation_verify` 不传 `table` 时验全部 active 表，项目状态是"项目级检查 +
  每张表状态"的合取：任何一张表 FAIL 就是 FAIL；只有待裁定才是 CONDITIONAL。
- 导出：`format: "sqlite"` 可一次导出全部 active 表（快照是一个新库，逐表建表）；
  csv/jsonl/markdown 是单表格式，多表必须指定 `table`。

## 判定策略（adjudication）

"一致"由 pin 的 `adjudication` 决定，不是写死的：

- `compare` 决定"哪些票算同一个事实"：`exact`（默认）/ `numeric`（容差）/ `ordered-groups`；
- `select` 决定"写哪个通道的原始写法"：`channel-order`（默认）/ `longest` / `lowest` / `highest` / `first`；
- 单字段可覆盖：`{ "strategy": "numeric", "fields": { "size_mm": { "tolerance": 0.5 } } }`；
- 外部命令：`{ "command": "node", "args": ["tools/policy.mjs"] }`，stdin 收
  `{kind:"compare"|"select", table, field, record, values, options}`，stdout 返回
  `{groups}` 或 `{index}` / `{value}`；非零退出或输出不合法 → 该格进待裁定
  （`adjudicator_error`），**不回落默认策略**；
- 批量：compare 与 select 策略都支持 `"batch": true`：一次命令判一批格（stdin
  `{kind:"compare-batch", cells:[…]}` / `{kind:"select-batch", cells:[…]}`，stdout
  `{results:[…]}`），用于避免逐格 spawn；单格结果缺失或非法只影响那一格；
- 合成值（如 `ordered-groups`）会标 `synthesized`，验收会单独计数。

## 真实项目里的用法

1. 建项目：`curation_init({ cwd, sources: ["raw/"], tables: ["esd_main"] })`；
2. 写 pin（先 `dryRun: true` 看 hash / 字段 / 记录数；dryRun 的 `hash` 与正式签署后的封印一致），确认后正式签；
3. 每个通道跑自己的抽取（**不要**把文本通道的结果喂给视觉通道），
   `curation_submit({ table: "esd_main", channel: "text", batch: "B001", records: [...] })`；
4. `curation_compare({ table: "esd_main" })`；`curation_query({ what: "pending" })`
   看未决原因，逐条补证或由人裁定；
5. `curation_apply({ table: "esd_main" })`（先 `dryRun` 看会写哪几格；重复落表是
   no-op，不备份也不新增 ledger 行；`keepBackups` 控制备份保留数，默认 5）；
6. `curation_verify()` 看项目级 + 各表状态；PASS 前不要宣称"核对完成"；
7. `curation_export({ format: "sqlite" })` 或指定表导出 csv；
8. `curation_pack()` 归档；换机器后先 `curation_init` 的记录仍在 manifest 里，
   可复算漂移。

## 验收门禁

项目级：

| 检查 | 含义 |
| --- | --- |
| `state_present` | 工作区存在、版本可读 |
| `pin_intact` | pin 内容与封印、库内哈希一致 |
| `manifest_intact` | 源基线未漂移（路径集合与 sha256） |
| `migration_pending` | 迁移占位 pin 是否已重签（未重签 → CONDITIONAL） |
| `schema_snapshot` | `.curation/schema.sql` 是否与 `user_version` 一致（派生物不一致 → CONDITIONAL） |

表级（每张 active 表各跑一遍）：

`records_resolvable`、`coverage`（每格都有结论）、`accepted_two_channels`、
`evidence_present`、`delivery_matches`（curated 表与结论一致）、
`decision_runs_recorded`、`ledger_complete`、`accept_ratio`、`pending_cells`、
`verify_cmd`。`ledger_complete` 只要求"真实变化"的格有 ledger 行（no-op 不写行）。

结论：`FAIL > CONDITIONAL > PASS`；`pending_cells` 只把结果降为 CONDITIONAL。

## 查询与备注

- `curation_query` 是只读面（不加锁、不要求封印）：`counts` 看总览、
  `pending` 看待裁定原因与通道原值、`votes` 看某格逐票、`cells` 看最新结论、
  `submissions` / `runs` / `schema` 看过程，`meta` 看项目与 pin、`events` 看事件流。
  `limit` 默认 50、不设上限；`format: "json"` 便于脚本消费。
- `curation_note` 往项目或表追加备注（append-only），不改任何数据与 pin。

## 进度条（可选）

`curation_progress` 只维护一份纯数据：`{ bars: [...] }`，补丁语义
`{ upsert, remove, clear }`，插件不规定何时创建 / 更新 / 删除。渲染在 Web UI
输入框上方（`conversation.input.dock`）。它不是验收证据，不参与任何门禁。

## 工作区布局

```
.curation/
├── project.sqlite        权威：project / table_registry / pin / table_pin / submission /
│                         decision / ledger / run / applied / exporter / events /
│                         curated 交付表（每张表一张）
├── project.sqlite-wal    运行期 WAL（-shm 同理）
├── manifest.json         源基线（只读材料的 sha256 清单）
├── pin.json              pin 人读镜像（权威在库里）
├── pin.sha256            封印（手改会被验收发现）
├── pending.json          待裁定清单（人读镜像，可重建）
├── lock                  写操作期间的项目锁（协作锁，不是安全边界）
├── backups/              VACUUM INTO 备份（每次落表 / 迁移前）
├── packs/                curation_pack 产物
└── exports/              curation_export 产物
```

## 迁移

- **schema**：`user_version` 现在是 `5`；从 v3/v4 打开时先要求备份，再按版本逐级
  迁移（v3 的旧 `contract` 转为 revision 1 的 `table_pin`，`legacy_contract_hash` 保留
  原哈希，同时写封印 / `meta.pin_id` / `migration-report.json` 并置
  `migration_pending`；v4→v5 只补 `ledger.changed` 列）。
- **迁移中间态**：占位 pin 需要重签（`force` + `reason`）才退出中间态；记录口径
  漂移会在 `curation_status` 里列出多/少的记录号，不会静默改 `records`。
- **0.6.0 旧库**：打开时一次性回填 decision/ledger 的 provenance（`provenance-repair.json`）。
- **pin 格式**：v4 契约已停用；按 [`docs/MIGRATION.md`](docs/MIGRATION.md) 转成
  v5 的 `{ project, defaults, tables[] }`。错误消息会指向这份文档。
- 数据库结构细节见 [`docs/DATABASE.md`](docs/DATABASE.md)。

## 安全与隐私

- 只读写本地文件；无网络、无遥测。
- pin 里的 `gates.verifyCmd`、`adjudication.*.command`、项目导出器都会以当前用户
  身份执行项目里的脚本 —— 只放你信任的项目。
- `curation_pack` 只收项目内的相对路径；符号链接跳过；单文件超过 10 MB 会警告。
- 工作区是否加密由你自己决定；本插件不做加密。

## 限制

- 一次写操作期间持有 `.curation/lock`（同一项目建议单写者）。
- 交付表必须是 SQLite 表；需要表格软件请用 `curation_export`。
- 一次 pin 覆盖整个项目；不存在"只改一张表而不重签"的路径。
- 多表导出成 csv 需要逐表调用，或直接用 `format: "sqlite"`。
- 通道同源检测、OCR 自动触发、target 级锚定、字段间交叉一致性仍未内建。

## 开发

```bash
node --test          # 153 个测试
npm run selfcheck    # 发布前泄漏 / 结构检查
npm pack --dry-run   # 打包检查（本机需 npm_config_cache=$PWD/.npm-cache）
```

版本与变更见 [`CHANGELOG.md`](CHANGELOG.md)；安全报告见 [`SECURITY.md`](SECURITY.md)。

## 仓库与发布

- 源码：<https://github.com/Antigen-1/dsh-data-curation>
- 当前版本 0.7.1（GitHub tag `v0.7.1`）；尚未发布到 npm。
