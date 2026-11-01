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
表格式只支持 `csv` / `jsonl`；`name`、`pending.file`、`review.file` 必须留在交付目录内，
不接受绝对路径或 `..` 越界路径。

## 包内容

- `tables/<table>.jsonl`（或 `.csv`）：该表的 curated 行，通过既有 exporter 生成；
- `pending.csv`：所有待裁定格（table, record, field, reason）；
- `review.md`：表状态、接受/待裁定计数和发布提醒；
- `delivery.json`：清单（生成时间、当前 pin 封印 hash、表与行数、待裁定行数）；
  其中表、待裁定清单和复核摘要的 `file` 均为**交付包内相对路径**，复制或移动整包后仍可验收。

生成目录默认 `.curation/deliveries/<name>-<时间>`，可以用 `out` 指定项目内相对目录。

## 验收

```text
curation_verify_delivery({ path: ".curation/deliveries/esd-delivery-..." })
```

检查：`delivery.json` 存在、`pinHash` 与当前 `.curation/pin.sha256` 一致、每张表行数与
清单一致、`pending.csv` 行数一致、`review.md` 存在。CSV 按解析后的数据行计数，支持
引号内换行；所有内容均从 `path` 指定的包内读取。任何一项不一致即 FAIL。

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

## 0.17.0 修复后重新验收结论（2026-11-01）

**结论：PASS。** 本结论针对 HEAD `5199cf1` 上的本轮修复工作区；原始 HEAD 的首次
重新验收为 FAIL，不能把这个结论回溯到未修复代码。

### 首轮缺陷与修复

1. **CSV 行数误判。** 原实现把表头和引号内换行计入物理行数。现由 `csvParse` 按 CSV
   记录解析，表与 pending 均扣除一条表头后计数。
2. **副本验收误查原包。** 原 manifest 保存构建时的项目相对路径。现保存交付包内相对路径，
   验收时相对 `path` 指定的包目录解析并限制越界，完整副本可以独立验收。
3. **计划路径越界。** `name`、`pending.file`、`review.file` 现经 `resolveInside` 校验和
   规范化，拒绝绝对路径与 `..` 越界路径，构建写文件时再次约束。
4. **未知格式静默降级。** 表现仅接受 `csv` / `jsonl`，未知格式在 `write` 和 `build`
   均明确拒绝，不再静默按 JSONL 构建。

### 验证证据

- `node --test test/delivery.test.js`：5/5 通过；新增 CSV 引号内换行、副本/移动包、
  路径越界与未知格式回归测试，既有默认 JSONL 和原包篡改测试继续通过。
- `npm test`：221/221 通过，无失败、跳过或取消。
- `npm run selfcheck`：通过，扫描 65 个发布文件。
- `npm pack --dry-run --ignore-scripts`：通过，包含 66 个文件。
- `git diff --check`：通过。
- 独立只读复核：四项修复均为 VERIFIED，总体 PASS。独立探针确认篡改副本 FAIL、
  原包 PASS，删除原包后的完整移动副本 PASS，越界路径与 `yaml` 在 write/build 均拒绝。
- 受保护列端到端复验通过：两次自动落表均保留人工值，`protectedSkipped=[1,1]`，
  `curation_verify=PASS`，默认 JSONL 交付导出保留人工值且 `verify_delivery=PASS`。

### 范围

验收阶段未安装到真实宿主、未执行 live MCP 验收，也未发布 npm。上述 PASS 是源码、
交付包与发布内容的验收结论，不代表真实宿主安装验收已经完成。
