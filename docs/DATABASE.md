# 工作区数据库布局（`project.sqlite`）

一个项目 = **只读原始材料** + **一个工作区 SQLite 文件**。这个文件是本插件唯一会写的地方，
pin、导出器、通道提交、结论、落表留痕、事件、curated 交付表全部在它里面。

本文描述「现在的布局」：0.7.0，`STATE_SCHEMA_VERSION = 5`。改表结构必须同时改这里的
版本号与本文档。

## 1. 文件与目录

```
<项目根>/.curation/                     工作区目录（可由 stateDir 改名）
├── project.sqlite                      工作区主库（本文主角）
├── project.sqlite-wal                   WAL 日志（存在即正常）
├── project.sqlite-shm                   WAL 共享内存
├── lock                                 项目锁（JSON：op/owner/pid/host/租约；仅写操作期间存在）
├── manifest.json                       源基线（只读源的文件清单 + 大小 + mtime + sha256）
├── pin.json                            最近一次 pin 的只读镜像（权威在库里，见 §4）
├── pin.sha256                          封印（一行哈希；与库内的哈希互为校验）
├── pending.json                        待裁定清单的人读镜像（权威在 decision 表）
├── schema.sql                          当前 schema 的导出（派生物，user_version 过期即重建）
├── migration-report.json               v3/v4 迁移报告（占位 pin、records 漂移、回填计数）
├── provenance-repair.json              0.6.0 旧库的 provenance 回填报告（一次性）
├── backups/<stamp>__project.sqlite     落表 / 迁移前的完整快照（VACUUM INTO）
├── packs/<name>.zip                    项目打包产物
└── exports/<table>-<stamp>.<ext>       导出文件（可重建，不是权威数据）
```

原始材料（PDF、图片、源表格）永远在 `.curation/` 之外，插件只读不写。
`manifest.json` 的 `exclude` 字段会排除工作区目录自身，避免「一写库就判源漂移」。

## 2. 版本与兼容

| 项 | 值 |
| --- | --- |
| `PRAGMA user_version` | `5`（`lib/db.js` 的 `STATE_SCHEMA_VERSION`） |
| v2 → v3 | 自动补 `decision.synthesized` 列 |
| v3 → v4 | 必须先有 `backupPath`；迁移建 project / table_registry / pin / table_pin / 事件 / run_table / applied_table，把旧 `contract` 转为 revision 1 的 `table_pin`，生成 v5 聚合 pin（占位，`migration_pending=1`），写 `pin.sha256` / `pin.json` / `meta.pin_id` / `migration-report.json`，并回填旧 decision/ledger 的 provenance |
| v4 → v5 | 给 `ledger` 补 `changed` 列（默认 1），已有行按「落过表」记为变化 |
| v1 | 拒绝打开：备份后删除 `.curation/` 重新 `curation_init` |
| 版本更高 | 拒绝打开并提示升级插件 |
| 建库时机 | 第一次 `curation_init`（或任何需要写库的操作） |

引擎：Node 内置 `node:sqlite`（要求 Node ≥ 24）。每个连接：

```
PRAGMA journal_mode = WAL      -- 读不阻塞写
PRAGMA foreign_keys = ON       -- DatabaseSync 的 enableForeignKeyConstraints
PRAGMA busy_timeout = 5000     -- 写冲突等待 5 秒再报 database is locked
```

## 3. 表一览

全局表：

| 表 | 角色 | 写入方式 |
| --- | --- | --- |
| `meta` | 键值元数据 | 覆盖写（`pin_hash`、`pin_id`…） |
| `project` | 项目描述（单行） | 覆盖写（init） |
| `table_registry` | 表登记与状态（active / retired） | init / pin 时登记，retire 时更新 |
| `pin` | 每次签署的聚合 pin（追加型） | 只追加 |
| `table_pin` | 每张表每次签署的 effective 配置（追加型） | 只追加，revision 递增 |
| `project_event` | 项目级事件（auto / note） | 只追加 |
| `table_event` | 表级事件（auto / note） | 只追加 |
| `exporter` | 项目级导出器注册表 | 增删 |

表维度（都带 `table_id`）：

| 表 | 角色 | 写入方式 |
| --- | --- | --- |
| `submission` | 一次通道提交（表 × 通道 × 批次 × 记录） | 覆盖写（同键重提替换） |
| `submission_value` | 提交里每个字段的原始值与页码证据 | 随 submission 一起替换 |
| `decision` | 逐格结论（追加型） | 只追加，取最新 |
| `ledger` | 逐格落表留痕 | 只追加，取最新 |
| `run_table` | 每次 compare 在每张表上的摘要 | 每次每表一行 |
| `applied_table` | 每次落表在每张表上的结果 | 每次每表一行 |
| `<curated 表>` | pin 里 `tables[].table` 指定的交付表 | 按记录键 upsert（见 §5） |

另外 `run` / `applied` 保留为「一次操作一行」的全局表；每表明细在 `run_table` /
`applied_table` 里。

「追加型」= 只 INSERT、不 UPDATE；「最新」按 `MAX(id)` / `MAX(revision)` 取，见 §4。

## 4. 逐表结构

### 4.1 `meta`

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

当前写入的键：

| 键 | 含义 |
| --- | --- |
| `pin_hash` | 当前聚合 pin 的哈希（与 `pin.sha256` 互为校验） |
| `pin_id` | 当前 pin 的 id（迁移时由迁移器写入，签署时由 `writePin` 写入） |
| `pinned_at` | 当前 pin 的签署时间 |
| `migration_pending` | `1` = 迁移占位 pin 尚未重签；重签后删除 |
| `migration_at` | 迁移发生时间 |
| `migration_records_added` / `migration_records_removed` | 迁移时交付表与旧契约 `records` 的差异（JSON 数组，最多各 50 条样例） |
| `legacy_contract_hash` / `legacy_contract_signed_at` | v3 旧契约的封印与签署时间（只读留存，供审计） |
| `provenance_repaired` | `1` = 已执行过一次 legacy provenance 回填（幂等门控） |

旧键 `contract_hash` / `contract_signed_at` 会在迁移或一次性修复时改名，不再表示当前口径。

### 4.2 `project`（单行）

```sql
CREATE TABLE project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

### 4.3 `table_registry`

```sql
CREATE TABLE table_registry (
  table_id       TEXT PRIMARY KEY,
  delivery_table TEXT NOT NULL UNIQUE,
  purpose        TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

`table_id` 同时是交付表名，必须是合法 SQL 标识符且不能占用状态表名
（`lib/db.js` 的 `RESERVED_TABLES`）。`retired` 表只读：submit / compare / apply
拒绝，verify 默认跳过，export 默认跳过（可用 `includeRetired`）。

### 4.4 `pin`（聚合，追加型）

```sql
CREATE TABLE pin (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,     -- pinHash(canonical(pin))
  json       TEXT NOT NULL,     -- v5 pin 全文（含每表 effective 配置）
  algorithm  TEXT NOT NULL,     -- 'sha256/canonical-json'
  pinned_at  TEXT NOT NULL
);
```

一次签署 = 一行 `pin` + 每张表一行 `table_pin`。`pin.json` / `pin.sha256` 是库外镜像与
封印；三者不一致时写操作被门禁挡住（`pin_intact`）。

### 4.5 `table_pin`（每表，追加型）

```sql
CREATE TABLE table_pin (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_pin_id    TEXT NOT NULL REFERENCES pin(id),
  table_id            TEXT NOT NULL REFERENCES table_registry(table_id),
  revision            INTEGER NOT NULL,
  hash                TEXT NOT NULL,     -- tableHash(effective table config)
  json                TEXT NOT NULL,     -- effective 配置（defaults 合并后的结果）
  legacy_contract_hash TEXT,             -- v3→v4 迁移时保留的旧契约哈希
  created_at          TEXT NOT NULL,
  UNIQUE (aggregate_pin_id, table_id),
  UNIQUE (table_id, revision)
);
```

`decision` 绑 `pin_id` 与 `table_pin_id`；apply 拒绝 `pin_id` 与当前 pin 不一致的接受格。

### 4.6 事件表

```sql
CREATE TABLE project_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','note')),
  actor TEXT, text TEXT NOT NULL, pin_id TEXT
);

CREATE TABLE table_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL REFERENCES table_registry(table_id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','note')),
  text TEXT NOT NULL, pin_id TEXT, actor TEXT
);
```

`kind = auto` 由插件写（签署 pin、登记表）；`kind = note` 来自 `curation_note`。

### 4.7 `exporter`

```sql
CREATE TABLE exporter (
  name TEXT PRIMARY KEY, command TEXT NOT NULL,
  args TEXT, created_at TEXT NOT NULL
);
```

内置导出器（csv/jsonl/markdown/sqlite）在代码里，不在这张表；内置名不可被覆盖。

### 4.8 `submission` + `submission_value`

```sql
CREATE TABLE submission (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id     TEXT NOT NULL REFERENCES table_registry(table_id),
  channel      TEXT NOT NULL,
  batch        TEXT NOT NULL,
  record       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('valid','uncertain','invalid')),
  submitted_at TEXT NOT NULL,
  notes        TEXT,
  UNIQUE (table_id, channel, batch, record)
);

CREATE TABLE submission_value (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value TEXT NOT NULL,   -- 原始写法（不做归一化替换）
  evidence TEXT,         -- JSON：{page, quote}
  PRIMARY KEY (submission_id, field)
);
```

同一 `table + channel + batch + record` 重新提交 = 替换。`uncertain/invalid` 是弃权票。
字段没出现 = 该通道对该格弃权；出现且为空串 = 明确「未提供」。

### 4.9 `decision`（追加型）

```sql
CREATE TABLE decision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id   TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  pin_id     TEXT, table_pin_id INTEGER,
  record     TEXT NOT NULL, field TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('accepted','pending')),
  value TEXT, normalized TEXT, adopted TEXT, dissent TEXT, votes TEXT,
  reason TEXT, evidence TEXT,
  synthesized INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT NOT NULL
);
CREATE INDEX decision_cell ON decision (table_id, record, field, id);
```

**当前有效结论 = 每个 `(table_id, record, field)` 上 `id` 最大的那一行。**
`run_id` 必须能在 `run` 表找到（verify 的 `decision_runs_recorded`）。

### 4.10 `ledger`（追加型）

```sql
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL, applied_at TEXT NOT NULL,
  record TEXT NOT NULL, field TEXT NOT NULL,
  old_value TEXT, new_value TEXT,
  adopted TEXT, dissent TEXT, evidence TEXT,
  run_id TEXT, decision_id INTEGER, apply_run_id TEXT,
  changed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ledger_cell ON ledger (table_id, record, field, id);
```

落表只对**真实变化**的格子追加一行（`changed = 1`）；重复落表是 no-op，不写行。
verify 的 `ledger_complete` 只要求接受值中"实际被改动"的格有留痕。

### 4.11 `run` / `run_table`

```sql
CREATE TABLE run (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
                  created_at TEXT NOT NULL, summary TEXT NOT NULL);
CREATE TABLE run_table (run_id TEXT NOT NULL, table_id TEXT NOT NULL,
                        pin_id TEXT, summary TEXT NOT NULL,
                        PRIMARY KEY (run_id, table_id));
```

`run.summary` 是全局摘要，`run_table.summary` 是该表的 `{scope,recomputed,accepted,…}`。

### 4.12 `applied` / `applied_table`

```sql
CREATE TABLE applied (run_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL,
                      ops INTEGER NOT NULL, backup TEXT, delivery_table TEXT);
CREATE TABLE applied_table (run_id TEXT NOT NULL, table_id TEXT NOT NULL,
                            ops INTEGER NOT NULL, delivery_table TEXT,
                            PRIMARY KEY (run_id, table_id));
```

## 5. curated 交付表（pin 定义，插件创建）

名字来自 pin：`tables[].table`，主键 `tables[].key`。

```sql
CREATE TABLE "<table>" (
  "<key>" TEXT PRIMARY KEY,
  "<field1>" TEXT | REAL,     -- number 字段 → REAL，其余 TEXT
  ...
);
```

规则：

- 表不存在 → 第一次 `curation_apply` 时创建；缺列 → `ALTER TABLE ADD COLUMN`。
- 行不存在 → 按记录键 `INSERT ... ON CONFLICT DO NOTHING` 建行（upsert 语义）。
- 一次落表 = **一个 `BEGIN IMMEDIATE` 事务**：建行 + 逐格 UPDATE + 回读比对，
  任何一格不一致整体回滚。
- 空串写成 `NULL`；number 字段的纯数字写成数值，其余按原文存。
- 多表之间按 `table_id` 隔离；同一个记录键可以出现在不同表里。

## 6. 各操作读写什么

| 操作 | 读 | 写 |
| --- | --- | --- |
| `curation_init` | 源文件（算基线） | `manifest.json`；建 `project.sqlite` 与全部状态表；`project` 行 + 预告的表登记 |
| `curation_pin` | `manifest.json`、旧 pin | `pin` + `table_pin`（每表 revision+1）+ 事件 + `meta` 两个键 + 封印 + 镜像 |
| `curation_submit` | effective 配置、库里的提交 | `submission` + `submission_value` |
| `curation_compare` | 最新提交、effective 配置 | `decision`（追加）+ `run` / `run_table` + `pending.json` 镜像 |
| `curation_apply` | 最新接受结论、curated 表旧值 | 备份 → curated 表 + `ledger` + `applied` / `applied_table` |
| `curation_verify` | 全部 | 只读（不动库） |
| `curation_export` | curated 表 | 只写导出文件（多表 sqlite 快照另建临时库） |
| `curation_exporter` | `exporter` | `exporter` 行 |
| `curation_note` | registry / pin | `project_event` / `table_event` |
| `curation_pack` | 全部 | `VACUUM INTO` 快照 + zip（不动主库） |
| `curation_query` / `curation_status` | 全部 | 只读 |

## 7. 备份与打包

- 落表前：`VACUUM INTO .curation/backups/<stamp>__project.sqlite`；no-op 落表不备份。
- 备份保留：`curation_apply` 的 `keepBackups`（默认 5）在成功后按文件名倒序清理旧快照；`0` 表示保留全部。
- v3 → v4 迁移前：`.curation/backups/<stamp>__pre-v4.sqlite`。
- 打包：`curation_pack` 先 `VACUUM INTO` 临时快照，再连同 `pin.json`、`exporters.json`、
  `manifest.json`、`pending.json`、被引用的外部脚本（verifyCmd / adjudication 命令）写进 zip。
- 快照可直接用任何 SQLite 客户端打开，用于复盘或恢复。

## 8. 并发与原子性

- **单事务**：一次落表 = curated 表 + `ledger` + `applied` 在同一个 `BEGIN IMMEDIATE`；
  一次比对 = `decision` + `run` + `run_table` 同事务。失败整体回滚。
- **操作级互斥**：`.curation/lock` 文件锁（`lib/lock.js`）覆盖 init / pin / submit /
  compare / apply / exporter / pack / verify；租约默认 10 分钟，verify 与 pack 更长。
- **写冲突等待**：`busy_timeout = 5000`。
- **协作而非安全边界**：锁防两个会话互相踩，不阻止人为删锁文件。

## 9. 检查与排障

```bash
sqlite3 .curation/project.sqlite "PRAGMA user_version;"        # 应为 5
sqlite3 .curation/project.sqlite ".tables"
sqlite3 .curation/project.sqlite "SELECT id, hash, pinned_at FROM pin ORDER BY pinned_at DESC LIMIT 3;"
sqlite3 .curation/project.sqlite "SELECT table_id, revision FROM table_pin ORDER BY table_id, revision;"
sqlite3 .curation/project.sqlite "SELECT table_id, record, field, status, reason FROM decision ORDER BY id DESC LIMIT 10;"
sqlite3 .curation/project.sqlite "SELECT table_id, ops FROM applied_table ORDER BY rowid DESC LIMIT 5;"
```

- `database is locked`：等 5 秒后仍失败就检查 `.curation/lock` 与 `curation_status`。
- `工作区由旧版本创建`：v1 需备份后重建；v3 会先要求备份再自动迁移。
- `pin 封印与工作区存储不一致`：有人手改 `pin.json` 或库里的 `pin` 行；重签即可。
- `已登记的表：X`：pin 少了 registry 里的表，补上或改 retired。

## 10. 体量参考

10^3 记录 × 20 字段 ≈ 2 万格：`decision` 与 `ledger` 各约 2 万行（重跑会更多），
库文件通常 10–50 MB；`backups/` 随每次有变化的落表增长，`keepBackups` 会自动保留最近几份。
WAL 异常增长通常意味着长事务或崩溃残留。
