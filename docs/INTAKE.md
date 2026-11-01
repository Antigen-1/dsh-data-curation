# 低门槛起步：导入、身份归一与 pin 草稿（0.15.0）

这组工具解决“签 pin 之前”的成本：先把真实记录和字段样本拿进来，再生成可编辑的
pin 草稿。它们**不写工作区数据库、不签署 pin**，所有产物都在 `.curation/` 下，可删除
重建。

## 1. 导入记录（CSV / JSONL）

```text
curation_records_import({
  cwd: "/path/to/project",
  path: "input/records.csv",
  key: "record_id",
  table: "summary"
})
```

输入是项目内相对路径，支持 `.csv`（逗号分隔、带表头）和 `.jsonl`（每行一个对象）。
输出：

- `.curation/records/summary.jsonl`：原始行（含全部列），供后续复用；
- `fields`：除键列外的字段推断（`text` / `number` / `date`，有空格 → `allowEmpty:true`）；
- `records`：`{kind:"list", values:[...]}`，去重后的记录键；
- `duplicates` / `missing`：重复键保留首次出现；缺键行跳过并计数。

Excel 不直接支持：先导出为 CSV/JSONL。这样避免引入 xlsx 依赖和隐藏的格式假设。

## 2. 身份归一

```text
curation_identity({
  path: "input/records.csv",
  rename: { "OLD-1": "CASE-1" },
  exclude: ["OLD-9"],
  fileMap: { "CASE-1": "raw/001.pdf" }
})
```

- `rename`：旧键 → 新键；改号后出现重复键会整体拒绝，不会静默丢数据；
- `exclude`：按旧键或新键排除；
- `fileMap`：给记录附加 `__source`（源文件路径），字段推断会自动跳过它。
- 输出 `.curation/records/<table>.jsonl` 与 `.curation/identity/<table>.json` 审计；
  审计文件记录改号、排除和文件映射，便于复核。

## 3. 生成 pin 草稿

```text
curation_pin_draft({
  recordsPath: ".curation/records/summary.jsonl",
  key: "record_id",
  table: "summary",
  project: "ESD"
})
```

输出 `.curation/pin.draft.json`：

```json
{
  "version": 5,
  "project": { "name": "ESD", "description": "由 curation_pin_draft 根据样本生成..." },
  "defaults": {
    "channels": [{ "name": "text" }, { "name": "vision" }],
    "evidence": { "required": true },
    "gates": { "minAcceptedRatio": 1 }
  },
  "tables": [{
    "table": "summary",
    "key": "record_id",
    "records": { "kind": "list", "values": ["CASE-1", "CASE-2"] },
    "fields": [
      { "name": "location", "type": "text", "allowEmpty": false },
      { "name": "note", "type": "text", "allowEmpty": true }
    ]
  }]
}
```

草稿可以手改，然后用草稿路径签署：

```text
curation_pin({ draftPath: ".curation/pin.draft.json" })
```

草稿不会自动签署；没有提供 `recordsPath` 时只生成项目级默认和空记录集，并给出警告。
记录集用 `kind:"list"` 写进 pin，因此 pin 自包含，不依赖 `.curation/records/` 继续存在。

## 4. 当前边界

- 只支持 CSV/JSONL；Excel 需先导出。
- 字段类型只做 `text` / `number` / `date` 的轻量推断；`enum`、归一化规则、证据要求仍需
  在草稿里手动补充。
- 记录键必须非空；重复键保留首次出现并计数，不自动合并。
- 这些工具不替代 `curation_pin` 的正式校验；签署前仍要跑 pin 校验和规则。
