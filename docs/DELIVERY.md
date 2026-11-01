# 交付包（0.17.0）

## 计划

```text
curation_delivery_plan({
  action: "write",
  plan: {
    name: "esd-delivery",
    tables: [{ table: "esd_main", format: "jsonl" }],
    pending: { file: "pending.csv" },
    review: { file: "review.md" }
  }
})
```

`write` 只保存计划（`.curation/delivery-plan.json`），不生成文件；`show` 查看；
`build` 按计划生成交付包。省略 `plan` 时使用所有 active 表 + `pending.csv` + `review.md`。

## 包内容

- `tables/<table>.jsonl`（或 `.csv`）：该表的 curated 行，通过既有 exporter 生成；
- `pending.csv`：所有待裁定格（table, record, field, reason）；
- `review.md`：表状态、接受/待裁定计数和发布提醒；
- `delivery.json`：清单（生成时间、当前 pin 封印 hash、表与行数、待裁定行数）。

生成目录默认 `.curation/deliveries/<name>-<时间>`，可以用 `out` 指定项目内相对目录。

## 验收

```text
curation_verify_delivery({ path: ".curation/deliveries/esd-delivery-..." })
```

检查：`delivery.json` 存在、`pinHash` 与当前 `.curation/pin.sha256` 一致、每张表行数与
清单一致、`pending.csv` 行数一致、`review.md` 存在。任何一项不一致即 FAIL。

它**不**替代 `curation_verify`：交付包可以带着待裁定格生成，业务门禁仍由
`curation_verify` 判定。

## 受保护列

pin 字段可以写 `"protected": true`：

```json
{ "name": "reviewer_note", "type": "text", "allowEmpty": true, "protected": true }
```

- `curation_apply` 跳过该字段：不写 curated 表、不写 ledger，返回 `protectedSkipped`；
- `curation_verify` 的 `delivery_matches` 与 `ledger_complete` 跳过该字段；
- 其他门禁（覆盖、双通道、证据等）仍照常检查。受保护列用于人工复核/批注列，避免自动
  落表覆盖人工结果。

## 边界

- 交付包中的表必须是 active 表；已退役表会被拒绝。
- 交付包不包含源材料本身；源基线仍在 `.curation/manifest.json`，不要把它当作归档。
- 交付包可以重复生成；`delivery.json` 封印生成时的 pin，旧包不随 pin 变化自动更新。
