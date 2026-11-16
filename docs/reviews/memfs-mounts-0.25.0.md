# dsh-data-curation 0.25.0 MEMFS 目录挂载审阅记录

- 版本：0.25.0 candidate（未 tag，未 npm publish）
- 基线：`v0.23.1` / `54a4e1c`
- 范围：mount + rwx（0.24.0 staged）、`sync: "on-close"`（0.25.0）以及
  `flushMounts()`/跨 mount（2026-11-17 delta）改动。上一轮候选快照为
  `f2c1b55`；本轮 delta 的修复提交为 `fa4e4d9`，1h soak 工作负载提交为
  `0f60066`。
- 结论：**IMPLEMENTATION APPROVED — 0.25.0 CANDIDATE；RELEASE NOT APPROVED**。
  单 mount 1h soak 已 PASS（2026-11-16）；包含反复 `flushMounts()` 的双 mount
  1h soak 仍待跑。没有独立发布批准。

## 独立审阅

节点：两路审阅在实现完成后启动；代码/文档审阅均为只读，fix verifier
最多 1 轮。审阅针对的是未提交工作树，提交时只做机械快照，不再改变语义。

### 代码审阅

首轮结论：**REVISE — 2 HIGH, 6 MEDIUM, 2 LOW**。

| 编号 | 发现 | 处置 |
|---|---|---|
| HIGH-1 | `worker.cjs` 把逐文件 sync 错误放入 `result.errors`，`close()` 只看 rejected promise，导致 sync 失败静默成功 | `loader.js` 扫描 `syncResult.mounts[].errors`，关闭 VM 后抛 `E-MOUNT-SYNC` 并带 `details`；新增失败注入测试 |
| HIGH-2 | mount 限制 counters 在 mount 循环内，实际是每 mount 2048 files/32MiB；sync 无上限 | counters 提升到所有 mount 之外；`syncMounts()` 共享 `{files,bytes}` budget；sync 遍历时按 2048/32MiB/8MiB 拒绝；新增跨 mount 聚合测试 |
| MED-3 | mount 祖先 `rename`/`rmdir` 可绕过 guard | 拒绝 mount root 及祖先的 rename/rmdir；rename target 也检查；R6RS 无 `rename-file`，保留为静态防护，未做直接 Scheme 负测试 |
| MED-4 | sync/read TOCTOU；rename 失败回退可能丢失原文件；只对最终文件 `O_NOFOLLOW` | `writeAtomic` 在 mkdir 前做完整 containment；父目录 realpath + containment；备份/恢复；读路径残余 Windows 竞态在文档中声明 |
| MED-5 | sync 写回固定 0600 | 复用已有文件 mode；新文件按 umask |
| MED-6 | tenant mounts 未转发，但 TENANT 文档宣传支持 | `process-runtime.js`/`manager.js` 转发 `mounts` 与 `syncTimeoutMs`；新增租户挂载测试 |
| MED-7 | sync 超时固定 10s，超时后无 `syncResult` | `syncTimeoutMs` 可配置；超时仍会杀 VM，未同步/部分写入的审计限制已写入文档，未声称事务性 |
| LOW-8 | supervised 自动重启复用 open 快照 | 文档明确 restart 复用 open 快照、不 sync；重新 `open` 才读新 host |
| LOW-9 | CHANGELOG 计数、测试标题、`syncResult` shape、删除计数不一致 | 已修正文档与测试；CHANGELOG 记录 14 个 mount 用例；删除 `ENOENT` 不再计 deleted |

### 文档审阅

首轮结论：**REVISE — 2 HIGH, 5 MEDIUM, 6 LOW**。

- HIGH-D1：`docs/MEMFS-MOUNTS.md` 与 CHANGELOG 的 sync 错误契约写成“总是抛错/不静默”，与 HIGH-1 冲突。已改为：逐文件错误时关闭 VM 后抛 `E-MOUNT-SYNC`；mount 级失败无 partial；`syncResult` 保留。
- HIGH-D2：`docs/TENANT-RUNTIME.md` 宣传未实现的 tenant mounts。已接线并加测试。
- MED-D3：mount 示例 `r-x` + `sync` 非法。示例改为 `rwx`；“rwx 写只落 MEMFS”限定为未启用 sync。
- MED-D4：`syncResult` shape 写错。已改为 `{mounts:[{guestPath,written,deleted,unchanged,errors}]}`。
- MED-D5：32MiB 写成 per mount；guest path 1024 写成字节。已改为跨 mount 聚合、1024 字符。
- MED-D6：“原子”过度承诺。已改为 rename 成功时原子、fallback 非原子、无 fsync、保留 mode、可能残留 tmp。
- MED-D7：未警告 restart 丢未 sync 写。已写入 `docs/MEMFS-MOUNTS.md`。
- MED-D8：声称可列目录，但 R6RS 白名单无 `directory-list`。已声明当前规则不可达，仅 FS guard 覆盖。
- LOW：PIN-V2 的“只落 MEMFS”限定、0.24.0 staged/未 tag 的表述、CHANGELOG 计数、目录 sync 只覆盖文件、测试标题、plan 的 per-mount 限制未实现，均已修正。

### Fix verifier

首轮有限 fix verifier：**CONDITIONAL — 2 HIGH, 1 MEDIUM**，全部是本次 diff 的阻塞项：

1. sync 限制仍是每 mount，不是跨 mount 聚合。
2. `writeAtomic` 在 containment 检查前 `mkdir`；Windows drive-relative guest 名可能在拒绝前创建目录，同时误拒合法 `..notes.txt`。
3. supervised `sync-mounts` 失败回 `type:'error'`，parent 只等 `sync-result`，真实 `E-MOUNT-LIMIT` 被超时掩盖。

修复后，第二轮仅验证这四个修复点的只读 verifier 返回 **APPROVE，blocking=[]**。
第二轮是静态检查，不把其沙箱中的测试结果当作证据；测试证据来自本机
`danger-full-access` 运行。

### 第二轮 delta 审阅（flushMounts / 跨 mount，2026-11-17）

范围：`f2c1b55` 之后的 `flushMounts()`、重复 sync 基线、跨 mount rename
权限和相应测试。两路审阅仍为只读；fix verifier 最多 1 轮。

- 代码审阅：**CONDITIONAL — 1 HIGH, 1 MEDIUM, 1 LOW**。
  - HIGH：重复 `flushMounts()` 不推进基线；create → flush → delete → flush
    声称成功但 host 文件未删除。已改为每个 mount 的 `syncedManifest`，仅在
    unchanged/成功写入/成功删除后推进；失败保留旧条目以便重试。
  - MEDIUM：sync 超时只向 loader 抛错，不杀 worker、不记录 `syncError`，
    未关闭的 incarnation 可能仍在写 host。已改为 fail-closed：标记 closed、
    终止 VM、保留 `syncError`。
  - LOW：原 flush 测试使用 `buffer-mode none`，没有真正验证 `flush-output-port`；
    已改 `buffer-mode block` 并回读 MEMFS，新增重复 flush 和逐文件错误路径。
- 文档审阅：**CONDITIONAL — 1 MEDIUM**。`flushMounts()` 的错误/超时契约仍按
  close-only 描述；已补“逐文件失败保持 runtime 打开、超时 fail-closed、基线
  推进”说明。
- Fix verifier：**APPROVE，blocking=[]**；仅剩 LOW 文档措辞“close 对比
  open-time manifest”，已改为 last synced baseline。
- 用户明确要求：跨 mount 的额外限制只保留 Unix `rwx` 权限，不再要求
  source/target 同一 mount root；R6RS 当前没有 `rename-file`，跨 mount 的
  可用操作是读一个 mount、写另一个，不能原子 rename。

## 验证（delta 后）

- mount 测试：19 个用例 19/19 通过。
- 标准全量：`node --test test/*.test.js` → 434 tests / 433 pass / 1 skip / 0 fail（87.6s）。
- selfcheck：140 个发布文件通过。
- 测试命令必须带 Node 的 `PATH`，否则外部导出器/子进程测试会 EPERM 或找不到
  `node`；直接 `node --test` 会扫描 `experiments/`，不是项目标准入口。

## 单 mount 1h soak（2026-11-16）

基准脚本扩展在 `64866af`（`test: add mount runtime to mixed soak`）：mixed
benchmark 增加第五个 `mount` runtime，规则读取 `/mnt/input/data.txt` 并写
`/mnt/input/out.txt`，挂载为 `rwx` + `sync: "on-close"`；每 25 次调用执行
一次 mount 规则，结束时 close 触发 sync。生产候选代码仍是 `f2c1b55`。

证据文件（`experiments/` 本机证据，不进 Git）：

- `experiments/scheme-v2-mount-1h-2026-11-16.jsonl`（59 个 60s 样本）
- `experiments/scheme-v2-mount-1h-2026-11-16-summary.json`
- `experiments/scheme-v2-mount-1h-2026-11-16-analysis.json`
- `experiments/scheme-v2-mount-1h-2026-11-16-log.txt`

结果：**PASS**，无 failures、无 conditional。

- 运行 3,600,181ms；1,554,709 calls；62,189 次 mount 调用；0 errors；
  0 restarts；parent RSS max 190,320,640 bytes；Wasm 60,424,192 bytes。
- analyzer（59 samples）的 5 个 runtime 全部 `pass: true`；mount runtime
  baseline median 17,231,912 bytes、final median 17,176,592 bytes、
  delta -55,320、slope 1.357 KiB/min、upper95 4.704 KiB/min、
  gcPause p95 13.26ms、gcCount 46→1325 严格递增、fullCollect=true。
- sync 在 close 时写回：`written:1, deleted:0, unchanged:1, errors:[]`；
  host `out.txt` 为 4,096 bytes。
- 覆盖限制：单一 mount、4KiB 读写、每 25 次调用一次、仅在 close sync；
  未覆盖多 mount 并发 sync、反复 close/reopen 的 sync churn。该结果支持
  0.25.0 candidate，不等于生产发布批准。

## 残余风险（不阻塞 0.25.0 candidate）

- sync 读路径仍有 lstat→open 的残余 TOCTOU；Windows 上无法完全消除，文档已声明。
- sync 超时/进程被杀时没有 partial `syncResult` 审计；文档声明非事务。
- mount 祖先 rename/rmdir 防护没有直接 Scheme 负测试，因为当前 R6RS 白名单
  没有 `rename-file`。
- 单 mount 1h soak 是 candidate 级证据；双 mount + 反复 `flushMounts()` 的
  1h soak 尚未完成。0.24.0 未单独 tag，也没有发布批准。
- Wasm/Worker 不是 OS 安全边界；mount 是能力，不是沙箱。

## 发布状态

- 0.25.0 仅为 candidate；未打 annotated tag，未 npm publish。
- 发布仍需独立批准；本记录不能当作 0.25.0 的生产放行。
