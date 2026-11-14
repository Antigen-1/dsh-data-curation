# 多租户 Runtime（选项 B）

状态：实现与基线验证完成，独立审阅待做。此文档描述当前代码实际提供的 API 与隔离边界，不把计划中的能力写成已实现。

## 1. 模型

一个 Node.js 管理进程持有多个租户；每个租户是一个独立的 Worker 线程，Worker 内运行一个独立 Scheme VM。

```text
TenantManager (Node main thread)
  ├─ TenantRuntime alpha
  │    └─ Worker ── SchemeV2Runtime ── VM
  │         ├─ project root: <projectRoot>/tenants/alpha
  │         ├─ FFI modules (Worker 内 import)
  │         └─ bounded command queue (one in flight)
  ├─ TenantRuntime beta
  │    └─ Worker ── SchemeV2Runtime ── VM
  └─ ...
```

这不是共享 VM 的 environment 分区。`environment` 只隔离 Scheme 绑定可见性，不隔离资源、故障或宿主内存；选项 B 用 Worker/VM 提供更强的隔离。

### 1.1 continuation 结论

Chez 官方 User's Guide 没有 `Scall_continuation`；Foreign Interface 的 stale-context 规则不允许 C 调用返回后再用新的 C 调用恢复旧 continuation。`with-exit-proc` 只是在仍存活的 C 帧内复位 C 栈。因此本实现不做跨调用 continuation 调度，也不提供 `dsh-dispatch`/`dsh-resume`。详见 `docs/TENANT-RUNTIME-SPIKE.md`。

## 2. API

### 2.1 打开管理器

```js
import { TenantManager } from 'dsh-data-curation/rules'

const manager = await TenantManager.open({
  projectRoot: '/abs/path/to/project',
  maxTenants: 16,          // 可选，默认 64
  maxQueue: 32,            // 可选，默认 32；0 表示不允许排队
  commandTimeoutMs: 30000, // 可选，manager 侧命令截止时间
  tenants: [
    {
      id: 'alpha',
      pin,                 // 已解析的 dsh-pin/v2 对象
      ffiModules,          // 可选：{ math: 'file:///abs/ffi/math.mjs' }
      timeoutMs: 5000,     // 可选，规则/命令超时
      ffiTimeoutMs: 2000,  // 可选，FFI provider 超时
      supervised: true,    // 可选，VM 是否在租户 Worker 内再 fork 子进程
      resourceLimits: { maxOldGenerationSizeMb: 256 }, // 可选，Worker 堆限制
    },
  ],
})
```

每个租户的根是 `<projectRoot>/tenants/<id>`；`id` 必须匹配 `^[A-Za-z][A-Za-z0-9._-]{0,63}$`，且按大小写不敏感去重，尾点会被拒绝。不会把租户根之外的项目文件挂载给该租户。使用 plugin/program pin 时，调用方必须先在该根下准备 `rules/scheme`（通常从项目模板复制一份只读快照）；空目录只能打开无插件 pin。

### 2.2 调用

```js
await manager.call('alpha', 'rule.example', [1, 2], { timeoutMs: 1000 })
await manager.callRule('alpha', 'total', [1, 0, 0], [21])
await manager.callPlugin('alpha', 'demo', [1, 0, 0], 'answer', [])
await manager.programResult('alpha', 'bootstrap', [1, 0, 0])
await manager.metrics('alpha')
await manager.gc('alpha', 5000)
await manager.restart('alpha')       // 同一个租户，新的 VM/Worker
await manager.terminate('alpha')     // 模拟崩溃；随后必须 restart
await manager.closeTenant('alpha')   // 注销并关闭
await manager.close()                // 关闭全部
```

`manager.list()` 返回 `[{ id, root, status }]`。`manager.get(id)` 返回运行时或 `null`。

### 2.3 错误码

| 错误码 | 含义 |
|---|---|
| `E-TENANT-ID` | 调用时找不到租户（未注册或已注销） |
| `E-TENANT-CONFIG` | 配置非法/重复租户/id 非法 |
| `E-TENANT-LIMIT` | 超过 `maxTenants` |
| `E-TENANT-CLOSED` | 租户正在关闭 |
| `E-TENANT-BUSY` | 同租户队列满，或已有 restart 在进行 |
| `E-TENANT-RESTART` | restart 窗口内收到命令 |
| `E-TENANT-CRASH` | Worker 崩溃/被终止/命令超时后终止 |
| `E-TENANT-TIMEOUT` | manager 侧命令截止时间到 |
| `E-TENANT-OPEN` / `E-TENANT-OPEN-TIMEOUT` | Worker/VM 初始化失败 |
| `E-TENANT-COMMAND` / `E-TENANT-WORKER` | 命令无法发送 / Worker 未编码错误 |

VM/规则/FFI 的底层错误码（`E-RULE-*`、`E-FFI-*`、`E-PLUGIN-*`）在可提取时由 Worker 回传（优先 `.code`，否则从消息前缀提取）；无法提取时回退到 `E-TENANT-WORKER`。

## 3. 隔离与资源边界

### 3.1 已提供

- **VM/环境隔离**：每租户独立 `SchemeV2Runtime`，不共享 `dynamic-rules`、`rule-options`、FFI 授权表。
- **文件根隔离**：每租户独立 `tenants/<id>`；pin 的固定搜索路径相对该根解析。
- **命令串行**：每个 Worker 同一时刻只执行一个命令；后续命令进有界队列，满则 `E-TENANT-BUSY`。
- **故障隔离**：关闭、崩溃、`terminate()` 只影响该租户；其他 Worker 继续运行。
- **重启**：`restart()` 终止旧 Worker 并重新打开 pin/program；不残留旧动态规则。
- **FFI 授权**：pin 的 `ffi` 采用 `{id, subjects}`，Worker 内按 subject/target 校验；provider 在该租户 Worker 内执行。
- **超时**：manager 侧 `commandTimeoutMs` 到点会把租户标记为 crashed 并终止 Worker；VM 内部超时仍可能先返回 `E-TIMEOUT`，该租户随后同样不可继续调用，需 `restart()`。

### 3.2 不提供

- **OS 级隔离**：Worker 线程共享宿主进程内存；不可信租户必须使用独立子进程/容器（选项 C）。
- **CPU/内存硬配额**：`resourceLimits` 只约束 Worker 堆，不是 OS RSS 上限；没有 cgroup/Job Object。
- **跨租户调用**：`manager` 只按 tenantId 路由，未注册的 tenant 直接拒绝；没有共享句柄表。
- **共享 VM 的异步调度**：见 continuation 结论。
- **Node 对象句柄**：当前 FFI 值是 JSON 数据，不把 Node 对象作为能力暴露给 Scheme。
- **生产 SLA**：1h 混合负载是发布后验证；当前只有 10 分钟 smoke。

## 4. 威胁模型

当前模型是 **单租户可信规则** 的扩展：多个租户共享一个 Node 进程，但规则来源仍应可信。

- Scheme 层没有任意 JS 路径：禁 `(chezscheme)`/`interaction-environment`；`(dsh safe eval (6))` 只允许 R6RS 标准库；无 libffi/`foreign-procedure` 可用路径；FFI 只能通过 `/dev` TLV channel。
- 因此 FFI target/subject 的权威校验点在 Worker JS 层；随机设备名只是传输层标识，不是认证。
- Chez/Emscripten 的内存安全漏洞导致的 Wasm escape 仍是残余风险；不能宣称 OS 隔离。
- 不可信租户（多组织、多用户、可上传规则）必须使用独立进程/容器，并加 OS 级配额；本实现不满足该场景。

## 5. 运维

- `close()`/`closeTenant()` 幂等；关闭后租户从 manager 注销，再调用返回 `E-TENANT-ID`。`close()` 先发 `{type:'close'}` 并等待 Worker 的 `closed` 回执，超时才 terminate。
- `terminate()` 立即把租户标记为 crashed，拒绝排队/在途命令，然后终止 Worker；之后必须 `restart()`。
- `metrics()` 返回该租户 VM 的 calls/errors/gcs/延迟窗口/内存；不会聚合其他租户。
- 日志：当前 manager/worker 不输出审计日志；不要把日志作为可用的可观测性承诺。
- 平台：要求 Node >= 24；不再按 OS/CPU 拒绝。当前验证基线是 Windows x64，Linux/macOS 为实验性平台。

## 6. 验证

- `test/scheme-v2-tenant.test.js`：两租户独立调用、队列满、关闭隔离、restart/terminate、FFI 租户、非法 id、插件根、restart 窗口、gc。
- 全量：Windows 388 tests / 387 pass / 1 skip（symlink 权限）；Linux x64 + Node 24 388/388。
- selfcheck：106 个发布文件。
- 独立审阅与 fix-verification 已完成，最终审阅记录见 `docs/reviews/scheme-v2-plugins-0.20.0.md` 后续租户段落。
