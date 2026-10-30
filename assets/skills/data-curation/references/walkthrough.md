# 端到端示例（合成数据）

下面用虚构记录演示完整一轮。所有值均为示例，不对应任何真实主体。

一个项目 = 只读的 `raw/`（原始材料）+ 工作区 `.curation/project.sqlite`。curated 交付表
`summary` 就在工作区里，不需要事先建库建表：

```sql
-- 由 curation_apply 首次写入时自动创建（等价结构）
CREATE TABLE summary (
  record_id TEXT PRIMARY KEY,
  size_mm   REAL,
  site      TEXT,
  note      TEXT
);
```

（缺表或 pin 字段缺列时，`curation_apply` 会自动建表/加列，并在结果里提示 `created` / `addedColumns`。）

pin 要点：`size_mm` 允许空白、必须带证据；`site` 不允许空白；通道 `text` 与 `vision`；交付表 `summary`，主键 `record_id`。

### 0 基线

```json
curation_init { "cwd": "/data/demo", "sources": ["raw"] }
```

### 1 签署 pin

```json
curation_pin {
  "cwd": "/data/demo",
  "pin": {
    "version": 5,
    "project": { "name": "demo" },
    "defaults": {
      "channels": [{ "name": "text" }, { "name": "vision" }],
      "evidence": { "required": true },
      "gates": { "minAcceptedRatio": 1 }
    },
    "tables": [{
      "table": "summary",
      "key": "record_id",
      "records": { "kind": "list", "values": ["CASE-0001", "CASE-0002"] },
      "fields": [
        { "name": "size_mm", "type": "number", "allowEmpty": true },
        { "name": "site", "type": "text", "allowEmpty": false }
      ]
    }]
  }
}
```

配置期可以先用 `"dryRun": true` 反复校验，确认后再正式签署。多表项目在这里加第二条
`tables[]`；同一记录键在两张表里互不影响，之后的 submit / compare / apply / verify
都要带 `table`。

### 2 采集（两个通道分开提交）

```json
curation_submit {
  "cwd": "/data/demo", "channel": "text", "batch": "B001",
  "records": [
    { "record_id": "CASE-0001", "status": "valid",
      "values": { "size_mm": "1.2cm", "site": "区域甲" },
      "evidence": { "size_mm": { "page": 1, "quote": "大小约 1.2cm" },
                    "site": { "page": 1, "quote": "位于区域甲" } } },
    { "record_id": "CASE-0002", "status": "uncertain",
      "values": { "site": "区域乙" } }
  ]
}
```

```json
curation_submit {
  "cwd": "/data/demo", "channel": "vision", "batch": "B001",
  "records": [
    { "record_id": "CASE-0001", "status": "valid",
      "values": { "size_mm": "12mm", "site": "区域甲" },
      "evidence": { "size_mm": { "page": 1 }, "site": { "page": 1 } } },
    { "record_id": "CASE-0002", "status": "valid",
      "values": { "site": "区域乙" },
      "evidence": { "site": { "page": 2 } } }
  ]
}
```

注意 CASE-0002：文本通道标了 `uncertain`（该票无效），视觉通道只有一票 → 不得接受。

### 3 比对

```json
curation_compare { "cwd": "/data/demo" }
```

结果：CASE-0001 两格接受（`1.2cm` 与 `12mm` 归一化后一致）；CASE-0002 的 `site` 待裁定
（`no_two_channel_agreement`，只有一票有效），`size_mm` 也是待裁定（`no_valid_channel`，
两个通道都没有有效值）。补第三个通道或交人处置。

### 4 落表

```json
curation_apply { "cwd": "/data/demo", "dryRun": true }
curation_apply { "cwd": "/data/demo" }
```

命令先做 `VACUUM INTO .curation/backups/<时间戳>__project.sqlite` 备份，再在单个事务里按键
建行（`INSERT ... ON CONFLICT DO NOTHING`）+ 逐格 `UPDATE ... WHERE record_id = ?`，写完回读比对；
任何一格对不上整体回滚。

只有 CASE-0001 的两格被写入并建行；CASE-0002 没有任何接受格，因此不会建行，全部进 `pending.json`。

### 5 验收

```json
curation_verify { "cwd": "/data/demo" }
```

`coverage` 通过（每格都有裁定，待裁定也是裁定），`pending_cells` 为 conditional，
其余检查为 pass → 总结论 `CONDITIONAL`。这时不能宣称完成，需要处置 CASE-0002。

### 6 导出（可选）

```json
curation_export { "cwd": "/data/demo", "format": "csv" }
```

导出到 `.curation/exports/summary-<时间戳>.csv`，供表格软件查看；权威数据仍是工作区里校验过的
curated 表，导出可随时重建。需要别的格式（例如 xlsx）时先用 `curation_exporter` 注册：

```json
curation_exporter {
  "cwd": "/data/demo", "action": "add", "name": "xlsx",
  "command": "node tools/export-xlsx.mjs"
}
```

### 7 打包（迁移 / 归档）

```json
curation_pack { "cwd": "/data/demo", "label": "示例批次" }
```

产出 `.curation/packs/<时间戳>.zip`：`project.sqlite` 一致性快照、`pin.json`、`exporters.json`、
`manifest.json`、`pending.json`（有时才有）、`referenced/tools/export-xlsx.mjs`（被导出器引用的脚本），
以及记录文件摘要的 `pack.json`。原始材料不复制，基线一起带走以便迁移后继续核对漂移。

### 8 报告片段

> 共 2 条记录 × 2 字段 = 4 格；接受 2 格，待裁定 2 格
> （CASE-0002.site = `no_two_channel_agreement`，CASE-0002.size_mm = `no_valid_channel`）。
> 验收 CONDITIONAL；备份在 `.curation/backups/…`；未决见 `.curation/pending.json`；归档包在 `.curation/packs/…`。
