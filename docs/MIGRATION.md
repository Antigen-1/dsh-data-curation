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
- 一份 v5 聚合 pin（`project` + `defaults` + 这一张表），id 以 `-migrate` 结尾，
  同时写 `pin.sha256`、`pin.json`、`meta.pin_id`，并置 `meta.migration_pending=1`；
- 旧结论的追溯链：`decision.pin_id` / `decision.table_pin_id` 指回这份占位 pin，
  `ledger.decision_id` / `ledger.apply_run_id` 指回对应 decision 与 apply；
  **`legacy_contract_hash` 只出现在 `table_pin` 上**，decision 行没有这一列
  （0.6.0 文档这里说错了，0.6.1 已改正）。
- 迁移报告写到 `.curation/migration-report.json`（pin id/hash、project、records 漂移、回填计数）。

0.6.0 只做了结构转换，没有写封印与 `meta.pin_id`，也没有回填 provenance。
用 0.6.1 打开这类工作区时，会一次性执行幂等修复（`meta.provenance_repaired` 门控），
并写 `.curation/provenance-repair.json`；仍在迁移中间态的工作区会继续保留
`migration_pending`，直到重新签署 pin。

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
   `curation_pin({ cwd, pin, dryRun: true })` 看校验结果；**dryRun 返回的
   `hash` 与正式签署后的封印一致**（同一 aggregate），`declaredHash` 只是
   声明部分的哈希，不要拿它去比对封印；
4. 确认无误后 `curation_pin({ cwd, pin })` 正式签署（旧 pin 未签署过则不需要
   `force`；重签已有 pin 需要 `force: true` **并给 `reason`**，原因会写入项目事件）；
5. 重签会清除 `migration_pending`。若迁移时检测到记录口径漂移（交付表里的键与
   旧契约 `records` 不一致），`curation_status` 会列出多/少的记录号；确认后
   在 pin 里修正 `records`，再重签；
6. 占位 pin 下的旧结论不参与新 pin 验收：`curation_compare({ scope: "all" })`
   重新比对，再 `curation_apply`；
7. `curation_verify({ cwd })` 复核项目级状态；`migration_pending` 与
   `schema_snapshot` 是 CONDITIONAL 项，重签并刷新后才会转绿。

## 4. 常见错误

- `v4 契约格式已停用：请按 docs/MIGRATION.md 迁移`：传了 `version: 4` 或旧形状。
- `已登记的表：X`：pin 里少了 `curation_init` 预告过的表；补上或改 `retired`。
- `pin 封印与工作区存储不一致`：有人手改了 `pin.json` 或库里的 `pin` 行；
  重新签署（`force: true` + `reason`）即可。
- `force 重签必须提供 reason`：重签已有 pin 时必须说明原因（写入项目事件）。
- `工作区需要从 v3 迁移到 v4：迁移前必须先创建备份`：先复制
  `.curation/project.sqlite`（或整个目录）再重试。
- `schema.sql 头与当前 user_version 不一致`：`schema.sql` 是派生物，下次打开
  工作区会重建；如果一直不消失，说明有进程绕过插件改了 schema。
