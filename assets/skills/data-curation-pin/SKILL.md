# 口径与字段纪律（data-curation-pin）

pin 是项目的"什么叫正确"：项目级默认 + 每张表的口径。字段清单、证据要求、归一化白名单、
通道、判定策略、交付表、验收门槛都在里面。**领域无关**：插件不认识任何具体行业；
换项目只换 pin。pin 由人审后签署，之后按哈希保护。

## 两层形状（v5）

```json
{
  "version": 5,
  "project": { "name": "esd-review", "description": "2026 年 ESD 汇总核对" },
  "defaults": {
    "channels": [
      { "name": "text", "method": "source-text-layer" },
      { "name": "vision", "method": "model-image" },
      { "name": "ocr", "method": "ocr-fallback" }
    ],
    "normalization": { "mode": "safe", "caseInsensitive": false, "synonyms": { "规范值": ["别名"] } },
    "evidence": { "required": true },
    "gates": { "minAcceptedRatio": 0, "verifyCmd": null },
    "adjudication": { "compare": { "strategy": "exact" }, "select": { "strategy": "channel-order" } }
  },
  "tables": [
    {
      "table": "esd_main",
      "key": "admission_id",
      "purpose": "主结果表",
      "status": "active",
      "records": { "kind": "list", "values": ["CASE-0001"] },
      "fields": [
        { "name": "location", "type": "text", "allowEmpty": true, "requireEvidence": true },
        { "name": "size_mm", "type": "number" },
        { "name": "note", "type": "text", "allowEmpty": true }
      ],
      "gates": { "minAcceptedRatio": 1 },
      "adjudication": { "compare": { "strategy": "numeric", "tolerance": 0.5 } }
    }
  ]
}
```

- `defaults` 只允许 `channels / normalization / evidence / gates / adjudication`；
  `project` 只允许 `name / description`。
- 每张表必须给 `table`（= 交付表名 = 库里 curated 表名）、`key`（主键列）、`records`、`fields`。
- 表可以覆盖任意默认块；合并规则：`channels` 整组替换、`normalization.synonyms` 同名合并、
  `evidence` / `gates` 叶子合并、`adjudication.compare` / `adjudication.select` 整对象替换，
  字段级覆盖在 `adjudication.fields` 里按字段合并。
- 登记：`curation_init({ tables: [...] })` 可预告；签署时自动登记。已登记的表不能在 pin 里
  省略；不再交付的表设 `"status": "retired"`（只读、默认不导出、pack 仍含）。
- 表名必须是合法 SQLite 标识符，不能占用状态表名
  （`meta / project / table_registry / pin / table_pin / submission / submission_value /
  decision / ledger / run / run_table / applied / applied_table / exporter / …`）。

## records 来源

- `{ "kind": "list", "values": [...] }`
- `{ "kind": "file", "path": "roster.csv", "key": "record_id" }`（`.csv` 或 `.jsonl`）
- `{ "kind": "db", "db": "sources/roster.sqlite", "table": "roster", "key": "record_id" }`

`records.db` 指向工作区本身会被拒绝（只读源与可写工作区必须分开）。

## 签署

配置期先 `curation_pin({ ..., dryRun: true })` 只校验不落盘，确认 hash / 字段 / 记录数后再签。
签署会写 `pin` + 每张表一条 `table_pin`（revision+1）+ 事件 + `pin.sha256` 封印 +
`pin.json` 镜像。重签已有 pin 必须 `force: true`，并**重新比对全部结果**——旧结论不会
被新 pin 自动解释。

## 字段规格

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `name` | 字段名，必须与交付表列名一致 | 必填 |
| `type` | `text` / `enum` / `number` / `date`，仅作文档与统计 | `text` |
| `allowEmpty` | 是否允许"两通道一致说未提供"的空值 | `true` |
| `requireEvidence` | 接受该字段时是否必须带页码或原文 | 取全局 `evidence.required` |
| `normalize` | 字段级覆盖：`{ "mode": "strict" }` | 取全局 |
| `synonyms` | 字段级别名映射（别名 → 规范值，精确匹配） | 无 |

## 字段口径纪律（写 pin 时逐条回答）

每个字段至少回答四问：

1. **取哪个对象的值？** 一条记录里有多个对象时（多个病灶/合同/标的/批次），先定目标，再取值。
   距离、序号是辅助定位，不能替代对象归属。
2. **值的边界在哪？** 只取这一段、这一栏、这一个对象；不得混入标本、邻近对象、背景描述、
   并发症说明。
3. **空白怎么表达？** 三态分开：`""` 明确未提供 / 缺键 该通道弃权 / `status: "uncertain"`
   看不清。pin 里写清哪种算合法空白。
4. **什么算等价？** 只登记真正等价的别名；看似相近但含义不同的是两个值。

## 容易混淆的字段类型（通用清单，按项目裁剪）

- **尺寸/大小**：只取目标对象本身；不混入距离、标本尺寸、范围描述；带单位就统一到同一单位。
- **数量**：只数目标对象；不把附带描述、合并对象重复计数。
- **部位/位置**：只取目标对象的部位；辅助距离不能替代解剖/区域名称。
- **状态/分级**：同一量表的级别 vs 分型 vs 描述性短语不能互换。
- **过程类字段**（术中/操作中）：只取该过程发生时的事实；术前评估、术后观察不算。
- **闭合/完成类**：部分 vs 完整必须分开；辅助器械不能当作完成标志。
- **合并/伴随项**：只记目标对象之外的伴随项；目标本身、正常所见不计入。
- **备注/自由文本**：不得丢失；不必人人都有；非标准情况必须写进备注而非硬套枚举。

## 归一化白名单

`safe`（默认）允许：Unicode 全半角、空白、常见标点、`cm↔mm`（写清数字）、中文数字（计数语境）、
pin 声明的同义词。`strict` 只做全半角与空白。
**禁止**把可能抹掉真实差异的项写进同义词，例如："完全/部分"、"术前/术中"、"部位A/部位B"、
"长径/短径"。

## 判定策略（adjudication）

默认规则是"两个通道归一化后一致就接受"。真实项目常常需要更细的口径，而这些口径属于 pin：

```json
"adjudication": {
  "compare": { "strategy": "exact" },
  "select": { "strategy": "channel-order" },
  "fields": { "size_mm": { "compare": { "strategy": "numeric", "tolerance": 0.5 } } }
}
```

- `compare`（哪些票算同一个事实）：`exact`、`numeric`（`tolerance`）、`ordered-groups`（`separator`），
  或 `{ "command": "node policy/compare.mjs" }`。
- `select`（写哪个通道的原文）：`channel-order`（`order`）、`longest`、`lowest`、`highest`、`first-valid`，
  或 `{ "command": "node policy/select.mjs" }`。
- 外部命令在项目根执行，stdin 收 `{ kind, table, record, field, values, options }`；`compare` 回
  `{ "groups": [[0,1]] }`，`select` 回 `{ "index": 0 }` 或 `{ "value": "…" }`。
- 字段多、记录多时给 `compare` 命令加 `"batch": true`：一次调用收
  `{ "kind": "compare-batch", "cells": [{ "record", "field", "values" }] }`，回
  `{ "results": [{ "record", "field", "groups" }] }`。逐格 spawn 在大项目里会慢到不可用。
- **策略失败不是"回到默认"**：命令非零退出、超时、输出不合法、下标越界，该格一律进待裁定
  （`adjudicator_error`）。宁可留白，不可猜。
- 换策略必须重新签署 pin；策略不改变底线：仍然需要两个有效通道、仍然需要证据。

## 验收门槛

- `minAcceptedRatio`：接受格 / 总格数的下限，默认 `0`（有未决格时整体判 `CONDITIONAL`）。
  要求"每格都必须被接受"的项目显式设为 `1`；只由人改，并在报告里说明原因。
- `verifyCmd`：项目自带验收命令（例如 `python tools/verify.py`），在项目根执行，退出码必须为 0；
  逐表执行时会带 `CURATION_TABLE` 环境变量。命令来自 pin，等同于以当前身份执行项目脚本——
  只签你信任的 pin。

## 反模式

- 用一个"全能字段"兜底：字段越少越难验收；拆到可判断。
- 把枚举字段写成自由文本：后续统计无法复核。
- 用同义词表消除业务差异：这是最常见的数据失真来源。
- pin 签完再"顺手"改：哈希会失配，全部结果需重新裁定。
- 为了多表省事把两张表塞进一张：记录键的语义会串，验收入口也会混淆。
