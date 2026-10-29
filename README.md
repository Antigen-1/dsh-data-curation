# dsh-data-curation

契约驱动的数据核对 / 清洗模式，作为 DeepSeek Harness 插件运行。

> **English TL;DR** — A contract-driven curation mode for DeepSeek Harness.
> A project is **read-only source material + one workspace SQLite**
> (`.curation/project.sqlite`, built-in `node:sqlite`, no third-party dependency):
> contract, exporters, channel submissions, decisions, ledger and the curated
> delivery table all live in that single file. Each extraction channel reports
> independently; a cell is accepted only when **two valid channels agree** after
> safe normalization; writes are keyed by record id + field, backed up with
> `VACUUM INTO`, executed in one transaction and re-read; a project can be packed
> into a single zip for archival. `curation_verify` is the single gate that says
> PASS / CONDITIONAL / FAIL. Local files only, no network, no telemetry.
> Requires Node >= 24.

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

一个项目就是**只读源 + 一个工作区数据库**：契约、导出器、通道提交、比对结果、
逐格留痕、curated 交付表全在 `.curation/project.sqlite` 里，导出文件只是派生物。

- 单事务写入 + 回读比对，崩溃只会留下旧表或新表，不会有半张表；
- 验收用 SQL 复算（覆盖、双通道、留痕、一致性、留痕与裁定 run 对账）；
- 交付表是库里一张普通表，按主键逐格更新，不重写整张表；
- 迁移/归档用 `curation_pack` 打成一个 zip：工作区快照 + 契约 + 导出器 + 源基线 +
  被引用的外部脚本，换个地方解开就能继续核对漂移。

用的是 Node 内置 `node:sqlite`：**不引第三方依赖**。该模块自 Node 23.4 起无需
flag，因此本包要求 **Node >= 24**（`engines` 已声明）。

## 八阶段

```
0 立项    curation_init        源文件逐个 sha256 → .curation/manifest.json + project.sqlite
1 契约    curation_contract    字段/证据/通道/交付表/门槛 → 存进工作区并哈希封印
2 采集    curation_submit      每个通道独立提交（禁止先合并再提交）
3 比对    curation_compare     逐格比对，≥2 有效一致 → 接受；否则待裁定
4 落表    curation_apply       VACUUM INTO 备份 → 单事务 upsert + 逐格回读
5 验收    curation_verify      基线/契约/覆盖/双通道/证据/交付一致/留痕/比例/验收命令
6 导出    curation_export      内置 csv/jsonl/markdown/sqlite，或项目注册的导出器
7 打包    curation_pack        工作区快照 + 契约 + 导出器 + 基线 + 被引用脚本 → zip
8 汇报    curation_status      只读汇总（未决清单见 pending.json）

可选项：长任务用 curation_progress 在输入框上方挂进度条（纯数据，见下文）。
```

## 安装

```bash
# npm（发布后）
dsh plugin --profile <profile> add dsh-data-curation

# 本地目录
dsh plugin --profile <profile> add ./dsh-data-curation
```

安装后插件的 `cordis.patch.yml` 会插入一个 bundle 条目，默认状态目录
`.curation`（可用 `stateDir` 配置改成项目内其他相对目录）。

## 快速开始

在项目根目录：

1. `/curation` —— 看阶段说明与当前状态。
2. 建立基线：`curation_init({ cwd, sources: ["raw"] })`。
   `sources` 必须是**项目内相对路径**；绝对路径会被拒绝。
3. 冻结契约：`curation_contract({ cwd, contract })`，模板见
   [`templates/contract.example.json`](templates/contract.example.json)。
   配置期可先 `dryRun: true` 只校验。
4. 每个通道单独提交：`curation_submit({ cwd, channel: "text", batch: "B001", records })`。
5. `curation_compare({ cwd })` → `curation_apply({ cwd, dryRun: true })` →
   `curation_apply({ cwd })` → `curation_verify({ cwd })`。
6. 需要给表格软件时：`curation_export({ cwd, format: "csv" })`；
   要别的格式先 `curation_exporter({ cwd, action: "add", name, command })`。
7. 归档/迁移：`curation_pack({ cwd, label })`。

完整合成示例见
[`assets/skills/data-curation/references/walkthrough.md`](assets/skills/data-curation/references/walkthrough.md)
（全部使用 `CASE-0001` 之类的虚构记录）。

## 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `curation_init` | 建立源基线（只读材料） | `cwd`、`sources[]`、`force` |
| `curation_contract` | 冻结口径契约（`dryRun` 只校验） | `cwd`、`contract`、`force`、`dryRun` |
| `curation_submit` | 提交某通道某批结果 | `cwd`、`channel`、`batch`、`records[]` |
| `curation_compare` | 逐格比对与裁定 | `cwd`、`records[]?`、`fields[]?` |
| `curation_apply` | 按键落表（upsert） | `cwd`、`dryRun` |
| `curation_verify` | 门禁验收 | `cwd` |
| `curation_export` | 导出派生物 | `cwd`、`format`、`out` |
| `curation_exporter` | 注册/删除项目导出器 | `cwd`、`action`、`name`、`command`、`args` |
| `curation_pack` | 打包整个项目 | `cwd`、`out`、`label` |
| `curation_progress` | 在输入框上方挂进度条（会话级，纯数据） | `upsert[]`、`remove[]`、`clear` |
| `curation_status` | 只读汇总 | `cwd` |

所有工具都接受可选 `stateDir`；`cwd` 是项目根目录的绝对路径。

### 提交格式

```json
{
  "record_id": "CASE-0001",
  "status": "valid",
  "values": { "location": "A 区", "measured_value": "1.5cm", "note": "" },
  "evidence": { "location": { "page": 1, "quote": "位于 A 区" } }
}
```

- `status`：`valid` / `uncertain` / `invalid`。**不确定必须标 uncertain**，不得猜。
- `values` 缺键 = 该通道对该字段弃权；`""` = 源材料明确未提供（仍是一票）。
- `evidence` 为接受所必需（除非字段声明 `requireEvidence: false`）。
- 同一通道同一批次的重提会**替换**该批记录，不会累加出第二份投票。

## 契约要点

| 键 | 说明 |
| --- | --- |
| `version` | 当前为 3；旧版契约会被要求重新签署 |
| `fields[]` | `name`、`type`（text/enum/number/date）、`allowEmpty`、`requireEvidence`、`synonyms` |
| `records` | `{kind:"list", values}` 或 `{kind:"file", path, key}` 或 `{kind:"db", db, table, key}` |
| `delivery` | `{table, key}` —— curated 表固定建在工作区里，`key` 是主键列 |
| `channels[]` | ≥2 个，按声明顺序决定"原文写法优先权" |
| `normalization` | `mode:"safe"`（默认）/`"strict"`、`caseInsensitive`、`synonyms` |
| `evidence` | `required`（默认 true） |
| `gates` | `minAcceptedRatio`（默认 0，即不设接受率下限）、`verifyCmd` |
| `identity` | 记录键冲突时的取值优先级，由项目写明 |

- `delivery.table` 必须是合法 SQLite 标识符，且不能占用插件状态表
  （`meta/submission/submission_value/decision/ledger/run/applied/contract/exporter`）。
- `records.db` 不能指向工作区本身（只读源与可写工作区必须分开）。
- 导出器不是契约的一部分：用 `curation_exporter` 注册（存进工作区），契约里出现
  `exporters` 会报错。
- curated 表不存在时由 `curation_apply` 新建；契约字段缺列时自动
  `ALTER TABLE ADD COLUMN`，结果里会提示 `created` / `addedColumns`。
- **归一化只用于比较，不替换入表值**：接受时写入的是被采纳通道的原始写法。

## 导出与打包

内置导出器：`csv`、`jsonl`、`markdown`、`sqlite`（输出路径默认
`.curation/exports/<table>-<时间戳>.<扩展名>`）。

项目导出器存进工作区（`exporter` 表），在项目根目录经 shell 执行：

- stdin 收到 `{ table, key, columns, rows }` 的 JSON；
- 环境变量 `CURATION_EXPORT_FORMAT / TABLE / KEY / OUT` 可用；
- 必须写出 `$CURATION_EXPORT_OUT`，退出码必须为 0。

插件作者也可以在进程内 `registerExporter({ name, run })` 注册格式。

`curation_pack` 产出 `.curation/packs/<时间戳>.zip`，内含：

```
project.sqlite          工作区一致性快照（VACUUM INTO）
contract.json           契约镜像（权威在校验过的 project.sqlite）
exporters.json          项目导出器清单
manifest.json           源基线
pending.json            待裁定清单（有时才有）
pack.json               格式版本 / 契约哈希 / 源基线哈希 / 文件摘要 / warnings
referenced/…            verifyCmd 与导出器命令引用到的项目内脚本
```

原始材料本身不复制（它们只读且通常很大），但基线与 `pack.json` 一起带走，
迁移后仍能发现源漂移。

## 进度条（可选）

长任务可以随时把进度挂到会话输入框上方：

```js
curation_progress({ upsert: [{ id: 'batch-7', label: '第 7 批', value: 12, total: 25, unit: '例' }] })
curation_progress({ upsert: [{ id: 'batch-7', value: 18 }] })   // 同 id 原位合并
curation_progress({ remove: ['batch-7'] })
curation_progress({ clear: true })
```

它只是一份会话级文档 `{ bars: [...] }`，以 plugin record
（`plugin:data-curation/progress`）写进会话日志，由客户端 dock 读同一份投影渲染。
插件**不规定**什么时候创建、更新或销毁进度条——什么时候挂、挂几条、什么时候撤，
全部由调用方按任务需要决定。

- 与项目工作区无关：不落库、不参与验收，删掉不影响任何门禁。
- 一次补丁最多 8 条；客户端最多显示 6 条，其余折成"另有 N 条进度"。
- 宿主没有 `sessionProjections` 服务时只告警，其余工具照常工作。

## 门禁与不变量

`curation_verify` 的检查项：

`state_present`、`contract_intact`、`manifest_intact`、`records_resolvable`、
`coverage`、`accepted_two_channels`、`evidence_present`、`delivery_matches`、
`decision_runs_recorded`、`ledger_complete`、`accept_ratio`、`pending_cells`、
`verify_cmd`。

- 任一硬性检查失败 → `FAIL`；只剩待裁定 → `CONDITIONAL`；全绿 → `PASS`。
- 待裁定格不写入、不计为已核实；已存在的行保持原值。
- 源基线漂移、契约被手改、curated 表被手改、裁定 run 缺失，都会阻断后续写入/验收。
- 每次比对的摘要写入工作区 `run` 表；裁定行引用的 run 必须存在，防止手改
  decision 表伪造接受。
- `minAcceptedRatio` 默认 0：允许"有未决格但其余全部接受"的项目走到
  `CONDITIONAL`；要求"每格都必须被接受"的项目把它设为 1。

## 状态目录

```
.curation/
  manifest.json          源基线（路径/大小/mtime/sha256 + 总哈希）
  project.sqlite         工作区（WAL）：状态 + curated 交付表
    contract             冻结的契约（版本/哈希/JSON/签署时间）
    exporter             项目导出器（名称/命令/参数）
    submission           每通道每批提交（同 channel+batch+record 唯一）
    submission_value     逐格取值 + 证据 JSON
    decision             逐格比对结论（追加，取每格最新）
    ledger               落表留痕（旧值/新值/采纳通道/异议/证据/run）
    run                  每次比对的摘要
    applied              最近一次落表
    meta                 契约哈希等元信息
    <delivery.table>     curated 交付表（由 curation_apply 维护）
  contract.json          契约人读镜像（派生）
  contract.sha256        契约封印（手改会被发现）
  pending.json           待裁定清单（人读镜像）
  exports/               导出派生物
  packs/                 curation_pack 归档包
  backups/<ts>__project.sqlite  落表前的 VACUUM INTO 快照
```

`.curation/` 是项目状态，**不要提交进版本库**（发布包里也没有它）。
`pending.json`、`exports/` 与 `contract.json` 都是可重建的派生物；工作区库与
`backups/` 才是审计依据。

## 隐私与安全

- 不联网、无遥测、无第三方运行时依赖；只读写 `cwd` 与 `stateDir` 下的文件。
- `stateDir`、`sources`、`records.path`、`records.db`、`out`、打包输出都做越界
  检查，拒绝 `..` 与绝对路径；表名/列名经标识符转义后插值。
- 仓库内所有示例与测试夹具均为**合成数据**（`CASE-0001` 等），不含真实
  姓名、住院号、身份证号或本机绝对路径；`npm run selfcheck` 会扫描发布文件。
- 契约里的 `verifyCmd` 与项目导出器都等同于以当前身份执行项目脚本——
  只对可信项目注册。
- 插件不内置任何 OCR / 视觉能力：通道只是标签，具体怎么抽由你调用的模型/工具做。

## 限制

- 交付表必须是工作区里的 SQLite 表；需要给表格软件时用 `curation_export`。
- 一次落表只处理一个交付表（契约里一个 `delivery`）。
- "两个通道一致"是**证据规则**，不是正确性证明；两个通道同源时它会失效——
  所以通道必须真正独立，插件只负责拒绝单通道结果，无法替你保证独立性。
- 通道同源检测、目标锚定（target_id）、字段间交叉一致性检查尚未内建。

## 开发

```bash
node --test          # 66 个测试（含 13 个端到端用例、导出器/打包用例、进度条与客户端 bundle）
npm run selfcheck    # 发布前泄漏扫描 + 语法检查 + 包清单核对
npm pack --dry-run   # 查看发布内容
```

许可证：MIT。
