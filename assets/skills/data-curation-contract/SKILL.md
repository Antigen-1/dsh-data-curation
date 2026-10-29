# 契约与字段口径（data-curation-contract）

契约是项目的"什么叫正确"：字段清单、证据要求、归一化白名单、通道、判定策略、交付表、验收门槛。
**领域无关**：插件不认识任何具体行业；换项目只换契约。契约由人审后冻结，之后按哈希保护。

## 最小契约

```json
{
  "version": 4,
  "fields": [
    { "name": "field_a", "type": "text", "allowEmpty": true, "requireEvidence": true },
    { "name": "field_b", "type": "enum", "allowEmpty": false },
    { "name": "field_c", "type": "number" }
  ],
  "records": { "kind": "list", "values": ["CASE-0001", "CASE-0002"] },
  "delivery": { "table": "summary", "key": "record_id" },
  "channels": [
    { "name": "text", "method": "source-text-layer" },
    { "name": "vision", "method": "model-image" },
    { "name": "ocr", "method": "ocr-fallback" }
  ],
  "normalization": {
    "mode": "safe",
    "caseInsensitive": false,
    "synonyms": { "规范值": ["别名1", "别名2"] }
  },
  "evidence": { "required": true },
  "gates": { "minAcceptedRatio": 1, "verifyCmd": null }
}
```

`records` 有三种来源：`{ "kind": "list", "values": [...] }`、`{ "kind": "file", "path": "roster.csv", "key": "record_id" }`（`.csv` 或 `.jsonl`）、`{ "kind": "db", "db": "sources/roster.sqlite", "table": "roster", "key": "record_id" }`。
`delivery` 只写 `{ "table": "...", "key": "主键列" }`：curated 表固定建在项目工作区 `.curation/project.sqlite` 里（缺表/缺列由 `curation_apply` 自动创建），落表只按 `key` 与字段名定位，绝不按行号。表名必须是合法 SQLite 标识符且不能占用插件状态表（`meta/submission/submission_value/decision/ledger/run/applied/contract/exporter`）。
`records.db` 若指向工作区本身会被拒绝（只读源与可写工作区必须分开）。需要 CSV/JSONL/markdown 时用 `curation_export` 导出派生物；导出器是用 `curation_exporter` 注册的项目状态，**不要**写进契约。
配置期可先 `curation_contract({..., dryRun: true})` 只校验不冻结，确认无误后再正式签署。

## 字段规格

| 键 | 作用 | 默认 |
| --- | --- | --- |
| `name` | 字段名，必须与交付表列名一致 | 必填 |
| `type` | `text` / `enum` / `number` / `date`，仅作文档与统计 | `text` |
| `allowEmpty` | 是否允许"两通道一致说未提供"的空值 | `true` |
| `requireEvidence` | 接受该字段时是否必须带页码或原文 | 取全局 `evidence.required` |
| `normalize` | 字段级覆盖：`{ "mode": "strict" }` | 取全局 |
| `synonyms` | 字段级别名映射（别名 → 规范值，精确匹配） | 无 |

## 字段口径纪律（写契约时逐条回答）

每个字段至少回答四问：

1. **取哪个对象的值？** 一条记录里有多个对象时（多个病灶/合同/标的/批次），先定目标，再取值。距离、序号是辅助定位，不能替代对象归属。
2. **值的边界在哪？** 只取这一段、这一栏、这一个对象；不得混入标本、邻近对象、背景描述、并发症说明。
3. **空白怎么表达？** 三态分开：`""` 明确未提供 / 缺键 该通道弃权 / `status: "uncertain"` 看不清。契约里写清哪种算合法空白。
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

`safe`（默认）允许：Unicode 全半角、空白、常见标点、`cm↔mm`（写清数字）、中文数字（计数语境）、契约声明的同义词。
`strict` 只做全半角与空白。
**禁止**把可能抹掉真实差异的项写进同义词，例如："完全/部分"、"术前/术中"、"部位A/部位B"、"长径/短径"。

## 判定策略（adjudication）

默认规则是"两个通道归一化后一致就接受"。真实项目常常需要更细的口径，而这些口径属于契约，
不属于代码：

```json
"adjudication": {
  "compare": { "builtin": "exact" },
  "select": { "builtin": "first-valid" },
  "fields": {
    "size": { "compare": { "builtin": "numeric", "tolerance": 0 } },
    "note": { "select": { "builtin": "longest" } }
  }
}
```

- `compare`（哪些票算同一个事实）：`exact`、`numeric`（`tolerance`）、`ordered-groups`（`separator`），
  或 `{ "command": "node policy/compare.mjs" }`。
- `select`（写哪个通道的原文）：`first-valid`、`longest`、`channel-order`（`order`）、`lowest`、`highest`，
  或 `{ "command": "node policy/select.mjs" }`。
- 外部命令在项目根执行，stdin 收 `{ kind, record, field, values }`；`compare` 回 `{ "groups": [[0,1]] }`，
  `select` 回 `{ "index": 0 }` 或 `{ "value": "…" }`。
- **策略失败不是"回到默认"**：命令非零退出、超时、输出不合法、下标越界，该格一律进待裁定
  （`adjudicator_error` / `adjudicator_invalid`）。宁可留白，不可猜。
- 换了策略必须重新签署契约：否则历史结论会按另一套规则被解释。
- 策略不改变底线：仍然需要两个有效通道、仍然需要证据。

## 验收门槛

- `minAcceptedRatio`：接受格 / 总格数的下限，默认 `0`（有未决格时整体判 `CONDITIONAL`）。要求"每格都必须被接受"的项目显式设为 `1`；只由人改，并在报告里说明原因。
- `verifyCmd`：项目自带验收命令（例如 `python tools/verify.py`），在项目根执行，退出码必须为 0。命令来自契约，等同于以当前身份执行项目脚本——只签你信任的契约。

## 反模式

- 用一个"全能字段"兜底：字段越少越难验收；拆到可判断。
- 把枚举字段写成自由文本：后续统计无法复核。
- 用同义词表消除业务差异：这是最常见的数据失真来源。
- 契约签完再"顺手"改：哈希会失配，全部结果需重新裁定。
