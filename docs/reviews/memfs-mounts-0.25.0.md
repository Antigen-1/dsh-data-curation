# dsh-data-curation 0.25.0 MEMFS 目录挂载审阅记录

- 版本：0.25.0 candidate（未 tag，未 npm publish）
- 基线：`v0.23.1` / `54a4e1c`
- 范围：未提交工作树中的 mount + rwx（0.24.0 staged）与 `sync: "on-close"`
  （0.25.0）改动。
- 结论：**IMPLEMENTATION APPROVED — 0.25.0 CANDIDATE；RELEASE NOT APPROVED**。
  没有独立发布批准，也没有 mount 相关 1h soak。

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

## 验证

- mount 测试：14 个用例；与 tenant 测试一起 25/25 通过。
- 标准全量：`node --test test/*.test.js` → 429 tests / 428 pass / 1 skip / 0 fail（78.0s）。
- selfcheck：140 个发布文件通过。
- 测试命令必须带 Node 的 `PATH`，否则外部导出器/子进程测试会 EPERM 或找不到
  `node`；直接 `node --test` 会扫描 `experiments/`，不是项目标准入口。

## 残余风险（不阻塞 0.25.0 candidate）

- sync 读路径仍有 lstat→open 的残余 TOCTOU；Windows 上无法完全消除，文档已声明。
- sync 超时/进程被杀时没有 partial `syncResult` 审计；文档声明非事务。
- mount 祖先 rename/rmdir 防护没有直接 Scheme 负测试，因为当前 R6RS 白名单
  没有 `rename-file`。
- 没有 mount 相关 1h soak；本次改动不进入生产发布门禁。
- Wasm/Worker 不是 OS 安全边界；mount 是能力，不是沙箱。

## 发布状态

- 0.25.0 仅为 candidate；未打 annotated tag，未 npm publish。
- 发布仍需独立批准；本记录不能当作 0.25.0 的生产放行。
