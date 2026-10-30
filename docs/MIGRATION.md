# 从 v4 契约迁移到 v5 pin

0.6.0 起，项目口径从"一份单表契约"变成"项目默认 + 每张表一条"的两层 pin。
旧格式仍能被读到（`curation_pin` 会给出明确错误），但不再能签署。

## 1. 形状变化

| v4 契约 | v5 pin |
| --- | --- |
| `fields[]`、`channels[]`、`normalization`、`evidence`、`gates`、`adjudication` | 同名块移到 `defaults`，表可逐块覆盖 |
| `records`、`delivery:{table,key}` | 每张表一条：`{table, key, records, fields, …}` |
| `version: 4` | `version: 5` |
| `identity` | 移除；备注与用途写 `project.description`、`table.purpose` 或 `curation_note` |

旧的 `contract` 行、`contract.json`、`contract.sha256` 会被迁移器转成：

- 一张 `table_pin`（revision 1，`legacy_contract_hash` = 旧契约哈希）；
- 一份 v5 聚合 pin（`project` + `defaults` + 这一张表）；
- 工作区里的结论（decision）保持 `legacy_contract_hash` 可追溯。

## 2. 手工转换示例

v4：

```jsonc
{
  "version": 4,
  "fields": [{ "name": "location", "type": "text" }],
  "records": { "kind": "list", "values": ["CASE-1"] },
  "delivery": { "table": "summary", "key": "record_id" },
  "channels": [{ "name": "text" }, { "name": "vision" }],
  "gates": { "minAcceptedRatio": 1 }
}
```

v5：

```jsonc
{
  "version": 5,
  "project": { "name": "summary" },
  "defaults": {
    "channels": [{ "name": "text" }, { "name": "vision" }],
    "gates": { "minAcceptedRatio": 1 }
  },
  "tables": [{
    "table": "summary",
    "key": "record_id",
    "records": { "kind": "list", "values": ["CASE-1"] },
    "fields": [{ "name": "location", "type": "text" }]
  }]
}
```

## 3. 迁移步骤

1. 备份整个 `.curation/`（或至少 `project.sqlite` + `manifest.json`）；
2. 升级插件后第一次打开工作区时，schema 会自动从 v3 迁到 v4；
   若当前是 v3，迁移前**必须**先有备份，否则插件会拒绝打开；
3. 把旧契约按上面的形状手工展开，先跑
   `curation_pin({ cwd, pin, dryRun: true })` 看校验结果；
4. 确认无误后 `curation_pin({ cwd, pin })` 正式签署（旧 pin 未签署过则不需要
   `force`；重签已有 pin 需要 `force: true`）；
5. `curation_verify({ cwd })` 复核项目级状态；旧结论只要 `pin_id` 绑定不上，
   会被验收判为需要重新比对 —— 按提示重跑 `curation_compare`。

## 4. 常见错误

- `v4 契约格式已停用：请按 docs/MIGRATION.md 迁移`：传了 `version: 4` 或旧形状。
- `已登记的表：X`：pin 里少了 `curation_init` 预告过的表；补上或改 `retired`。
- `pin 封印与工作区存储不一致`：有人手改了 `pin.json` 或库里的 `pin` 行；
  重新签署（`force: true`）即可。
- `工作区需要从 v3 迁移到 v4：迁移前必须先创建备份`：先复制
  `.curation/project.sqlite`（或整个目录）再重试。
