# 工作区数据库布局（`project.sqlite`）

一个项目 = **只读原始材料** + **一个工作区 SQLite 文件**。这个文件是本插件唯一会写的地方，
契约、导出器、通道提交、裁定、落表留痕、curated 交付表全部在它里面。

本文描述「现在的布局」：0.2.0 的 `STATE_SCHEMA_VERSION = 2`。改表结构必须同时改这里的版本号
与本文档。

## 1. 文件与目录

```
<项目根>/.curation/                     工作区目录（可由契约/配置的 stateDir 改名）
├── project.sqlite                      工作区主库（本文主角）
├── project.sqlite-wal                   WAL 日志（存在即正常）
├── project.sqlite-shm                   WAL 共享内存
├── lock                                 项目锁（JSON：op/owner/pid/host/租约；仅写操作期间存在）
├── manifest.json                       源基线（只读源的文件清单 + 大小 + mtime + sha256）
├── contract.json                       契约的只读镜像（权威在库里，见 §4.2）
├── contract.sha256                     契约封印（一行哈希；与库内的哈希互为校验）
├── pending.json                        待裁定清单的人读镜像（权威在 decision 表）
├── backups/<stamp>__project.sqlite     每次落表前的完整快照（VACUUM INTO）
├── packs/<name>.zip                    项目打包产物
└── exports/<table>-<stamp>.<ext>       导出文件（可重建，不是权威数据）
```

原始材料（PDF、图片、源表格）永远在 `.curation/` 之外，插件只读不写。
`manifest.json` 的 `exclude` 字段会排除工作区目录自身，避免「一写库就判源漂移」。

## 2. 版本与兼容

| 项 | 值 |
| --- | --- |
| `PRAGMA user_version` | `2`（`lib/db.js` 的 `STATE_SCHEMA_VERSION`） |
| 打开时检查 | 版本更低 → 拒绝打开并提示迁移；版本更高 → 拒绝打开并提示升级插件 |
| 迁移 | **目前不自动迁移**：0.1.x（v1）的工作区需要重新 `curation_init`，或按迁移说明手工处理 |
| 建库时机 | 第一次 `curation_init`（或任何需要写库的操作） |
| 建库语句 | `lib/db.js` 的 `ensureStateSchema()`，全部 `CREATE TABLE IF NOT EXISTS` |

引擎：Node 内置 `node:sqlite`（要求 Node ≥ 24）。每个连接：

```
PRAGMA journal_mode = WAL      -- 读不阻塞写
PRAGMA foreign_keys = ON       -- DatabaseSync 的 enableForeignKeyConstraints
PRAGMA busy_timeout = 5000     -- 写冲突等待 5 秒再报 database is locked
```

## 3. 表一览

| 表 | 角色 | 写入方式 |
| --- | --- | --- |
| `meta` | 键值元数据 | 覆盖写（`contract_hash`、`contract_signed_at`） |
| `contract` | 当前冻结的口径契约（单行） | 覆盖写（重签时 `force`） |
| `exporter` | 项目级导出器注册表 | 增删（`curation_exporter`） |
| `submission` | 一次通道提交（通道 × 批次 × 记录） | 覆盖写（同键重提替换） |
| `submission_value` | 提交里每个字段的原始值与页码证据 | 随 submission 一起替换 |
| `decision` | 逐格裁定结果（追加型） | 只追加，取最新 |
| `ledger` | 逐格落表留痕（旧值/新值/采纳通道） | 只追加，取最新 |
| `run` | 每次 compare 的运行摘要 | 每次一行 |
| `applied` | 每次落表的结果（ops/备份路径/交付表） | 每次一行 |
| `<curated 表>` | 由契约 `delivery.table` 指定的交付表 | 按记录键 upsert（见 §5） |

「追加型」= 只 INSERT、不 UPDATE；「最新」按 `MAX(id)` 取，见 §4。

## 4. 逐表结构

### 4.1 `meta`

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

当前写入的键：`contract_hash`（契约哈希）、`contract_signed_at`（签署时间）。
其它键保留给将来使用；读取方不得假设键集合固定。

### 4.2 `contract`（单行）

```sql
CREATE TABLE contract (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  version   INTEGER NOT NULL,     -- 契约格式版本，当前 3
  hash      TEXT    NOT NULL,     -- contractHash(契约)
  json      TEXT    NOT NULL,     -- 契约全文（JSON）
  signed_at TEXT    NOT NULL
);
```

`CHECK (id = 1)` 保证只有一行。权威在库里；`contract.json` 只是镜像，`contract.sha256`
是库外封印。三者不一致时任何写操作都会被门禁挡住（`尚未冻结口径契约` / `契约封印与工作区存储不一致`）。

### 4.3 `exporter`

```sql
CREATE TABLE exporter (
  name       TEXT PRIMARY KEY,
  command    TEXT NOT NULL,
  args       TEXT,               -- JSON 数组
  created_at TEXT NOT NULL
);
```

内置导出器（csv/jsonl/markdown/sqlite）在代码里，不在这张表；这张表只存项目自己注册的导出器。
内置名不可被覆盖。

### 4.4 `submission` + `submission_value`

```sql
CREATE TABLE submission (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel      TEXT NOT NULL,
  batch        TEXT NOT NULL,
  record       TEXT NOT NULL,          -- 记录键（如住院号）
  status       TEXT NOT NULL CHECK (status IN ('valid','uncertain','invalid')),
  submitted_at TEXT NOT NULL,
  notes        TEXT,
  UNIQUE (channel, batch, record)      -- 同一通道同一批次同一记录只有一份
);

CREATE TABLE submission_value (
  submission_id INTEGER NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  value         TEXT NOT NULL,         -- 原始写法（不做归一化替换）
  evidence      TEXT,                  -- JSON：{page, quote}
  PRIMARY KEY (submission_id, field)
);
```

语义：**同一 `channel + batch + record` 重新提交 = 替换**（先 DELETE 再 INSERT，`submission_value`
由外键级联删除）。`status = uncertain/invalid` 的提交算「弃权票」，不参与裁定。
一个字段没出现在 `submission_value` 里 = 该通道对该格**弃权**；出现且值为空串 = 明确「报告未提供」。

### 4.5 `decision`（追加型）

```sql
CREATE TABLE decision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,      -- 对应 run.run_id
  record     TEXT NOT NULL,
  field      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('accepted','pending')),
  value      TEXT,               -- 采纳的原始写法
  normalized TEXT,               -- 归一化后的值（只用于比较，不回写）
  adopted    TEXT,               -- JSON 数组：同意的通道
  dissent    TEXT,               -- JSON 对象：少数派原值
  votes      TEXT,               -- JSON 数组：每票的通道/状态/值
  reason     TEXT,               -- pending 原因：no_valid_channel / no_two_channel_agreement / ...
  evidence   TEXT,               -- JSON：采纳通道的页码与原文
  decided_at TEXT NOT NULL
);
CREATE INDEX decision_cell ON decision (record, field, id);
```

**当前有效裁定 = 每个 `(record, field)` 上 `id` 最大的那一行。** 历史行保留，用于追溯。
`run_id` 必须能在 `run` 表里找到（`curation_verify` 的 `decision_runs_recorded` 检查）。

### 4.6 `ledger`（追加型）

```sql
CREATE TABLE ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at TEXT NOT NULL,
  record     TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,               -- 落表前的值
  new_value  TEXT,               -- 落表后的值
  adopted    TEXT,               -- JSON：采纳通道
  dissent    TEXT,               -- JSON：异议
  evidence   TEXT,               -- JSON：页码/原文
  run_id     TEXT                -- 来源裁定运行
);
CREATE INDEX ledger_cell ON ledger (record, field, id);
```

每次 `curation_apply` 对每个写过的格子追加一行；`curation_verify` 用它检查
「交付表里的每个接受值都能找到对应留痕」。

### 4.7 `run`

```sql
CREATE TABLE run (
  run_id     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,      -- 'compare' | 'apply'
  created_at TEXT NOT NULL,
  summary    TEXT NOT NULL       -- JSON：记录数/字段数/通道/接受与待裁定计数
);
```

### 4.8 `applied`

```sql
CREATE TABLE applied (
  run_id         TEXT PRIMARY KEY,
  applied_at     TEXT NOT NULL,
  ops            INTEGER NOT NULL,   -- 写入格数
  backup         TEXT,               -- 备份文件路径（相对项目根）
  delivery_table TEXT                -- 交付表名
);
```

## 5. curated 交付表（契约定义，插件创建）

名字来自契约：`delivery: { table, key }`。表名必须是合法标识符且不能占用状态表名
（`lib/db.js` 的 `RESERVED_TABLES`）。

```sql
CREATE TABLE "<table>" (
  "<key>" TEXT PRIMARY KEY,       -- 记录键
  "<field1>" TEXT | REAL,         -- 契约字段：number → REAL，其余 TEXT
  ...
);
```

规则：

- 表不存在 → 第一次 `curation_apply` 时创建；缺列 → `ALTER TABLE ADD COLUMN`。
- 行不存在 → 按记录键 `INSERT ... ON CONFLICT DO NOTHING` 建行（upsert 语义）。
- 一次落表 = **一个 `BEGIN IMMEDIATE` 事务**：建行 + 逐格 UPDATE + 回读比对，
  任何一格不一致整体回滚。
- 空串写成 `NULL`；number 字段的纯数字写成数值，其余按原文存。
- 交付表可以被 SQL 直接查询/复算——这正是选 SQLite 的原因。

## 6. 各操作读写什么

| 操作 | 读 | 写 |
| --- | --- | --- |
| `curation_init` | 源文件（算基线） | `manifest.json`；建 `project.sqlite` 与全部状态表 |
| `curation_contract` | `manifest.json` | `contract` 行 + `meta` 两个键 + `contract.sha256` + `contract.json` |
| `curation_submit` | 契约、库里的提交 | `submission` + `submission_value` |
| `curation_compare` | 最新提交、契约 | `decision`（追加）+ `run` + `pending.json` 镜像 |
| `curation_apply` | 最新裁定、curated 表旧值 | 备份 → curated 表 + `ledger`（追加）+ `applied` |
| `curation_verify` | 全部 | 只读（不动库） |
| `curation_export` | curated 表 | 只写导出文件 |
| `curation_exporter` | `exporter` | `exporter` 行 |
| `curation_pack` | 全部 | `VACUUM INTO` 快照 + zip（不动主库） |
| `curation_status` | 全部 | 只读 |

## 7. 备份与打包

- 落表前：`VACUUM INTO .curation/backups/<stamp>__project.sqlite`（一致性快照，不是文件拷贝）。
- 打包：`curation_pack` 先 `VACUUM INTO` 一个临时快照，再连同 `contract.json`、`exporters.json`、
  `manifest.json`、`pending.json`、被引用的外部脚本一起写进 zip；主库不受影响。
- 快照可以直接用任何 SQLite 客户端打开，用于复盘或恢复。

## 8. 并发与原子性（0.3.0）

- **单事务**：一次落表 = curated 表 + `ledger` + `applied` 在同一个 `BEGIN IMMEDIATE` 里提交；
  一次比对 = `decision` + `run` 同一事务。任何一步失败整体回滚，不存在「表已改、无留痕」。
- **操作级互斥**：`.curation/lock` 文件锁（`lib/lock.js`）覆盖 init / contract / submit /
  compare / apply / exporter / pack / verify；租约默认 10 分钟，verify 与 pack 用更长租约。
  锁内容记 `op/owner/pid/host/startedAt/expiresAt`；同一主机上进程已退出的锁立即失效，
  别的主机上的锁等到租约过期；`curation_status` 的 `lock` 字段显示当前持有者。
- **写冲突等待**：连接设 `busy_timeout = 5000`（Node 默认 0，会让单事务碰撞立刻失败）。
- **协作而非安全边界**：锁防止两个会话互相踩，不阻止人为删除锁文件。

0.2.0 的旧限制（已修）：`decision` 的「最新 = MAX(id)」在两个会话并发 compare 时会按格混合
两次运行；`ledger` / `applied` 与 curated 表写入不在同一事务。

## 9. 检查与排障

```bash
# 用 sqlite3 CLI（或任意客户端）打开快照或主库
sqlite3 .curation/project.sqlite "PRAGMA user_version;"           # 应为 2
sqlite3 .curation/project.sqlite ".tables"
sqlite3 .curation/project.sqlite "SELECT kind, COUNT(*) FROM run GROUP BY kind;"
sqlite3 .curation/project.sqlite "SELECT record, field, status, reason FROM decision ORDER BY id DESC LIMIT 10;"
sqlite3 .curation/project.sqlite "SELECT * FROM applied ORDER BY rowid DESC LIMIT 1;"
```

- `database is locked`：另一个进程正持有写锁；等 5 秒（busy_timeout）后仍失败就检查
  `.curation/lock` 与 `curation_status` 输出的占用信息。
- `工作区由旧版本创建`：用新版插件重新 `curation_init`（会重建状态库；原始材料不受影响）。
- `契约封印与工作区存储不一致`：有人手工改过 `contract.json` 或库里的 `contract` 行；
  重新签署即可，别手改。

## 10. 体量参考

10^3 记录 × 20 字段 ≈ 2 万格：`decision` 与 `ledger` 各约 2 万行（含历史重跑会更多），
库文件通常在 10–50 MB；`backups/` 会随每次落表线性增长，落表完成后可手工清理旧快照。
WAL 在正常情况下很小，异常增长通常意味着有长事务或崩溃残留。
