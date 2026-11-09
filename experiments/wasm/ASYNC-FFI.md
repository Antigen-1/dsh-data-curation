# 异步 FFI 分级契约

异步 FFI 是**第三级能力**。前两级（fixed-aot、pure-dynamic）未通过时，不进入本文件；只有纯规则 corpus 全绿后，才允许启动 FFI 试验。

## 先证明挂起/恢复，再谈协议

仅有 JavaScript 消息往返不算异步 FFI 通过。必须证明 guest 在等待宿主结果时**真实释放执行栈**，拿到结果后从同一逻辑调用继续；否则同步 C/Wasm 栈会阻塞事件循环或死锁。

每候选先写 `mechanism.json`：

| 字段 | 要求 |
|---|---|
| `mechanism` | `hoot-call-async` / `asyncify` / `jspi` / `cps` / `unsupported` |
| `evidence` | 可重跑实验路径与原始日志；不能只写官方文档链接 |
| `reentrant` | 是否支持嵌套 FFI/重入 |
| `stackCost` | 栈/体积代价测量 |
| `exceptionPath` | host reject/throw 如何回到 guest |
| `cancel` | 是否支持取消；只允许 best-effort |

Hoot 的 `Procedure.call` 是同步边界；官方 `call_async` 与 Scheme 侧显式 resolve/reject 是待验证路线，不能假定 foreign Promise 会自动 await。Chibi/Chez 仅在 Asyncify/JSPI/CPS 实际可构建且通过下述测试时声明 `async-ffi`。

## 协议

```json
{
  "type": "ffi-request",
  "requestId": "r-1",
  "binding": "test.positive",
  "args": [1],
  "timeoutMs": 500
}
```

```json
{ "type": "ffi-result", "requestId": "r-1", "ok": true, "value": true }
```

```json
{ "type": "ffi-result", "requestId": "r-1", "ok": false, "error": { "code": "FFI_ERROR", "message": "..." } }
```

```json
{ "type": "ffi-cancel", "requestId": "r-1" }
```

规则：

- `requestId` 唯一且不可复用；late response 必须丢弃并记录，不得写入已取消/已销毁的 guest。
- 取消是 best-effort；已发生的宿主副作用不回滚，结果必须说明。
- 超时先由 guest 侧计时，再由父 supervisor 兜底终止；两层错误都映射 `TIMEOUT`。
- 参数和结果只能走契约 JSON；非法 JSON/超限返回 `FFI_RESULT` 或 `OUTPUT_LIMIT`。
- 单个绑定只能由宿主显式 allowlist；guest 不能枚举、反射或调用未声明 binding。
- 第一阶段 guest 的 filesystem/network/environment/process/dynamicJsEval 全为 false；runtime-internal imports 单独 allowlist，不能转成 guest capability。

## 必测故障

1. 永不返回的宿主调用 → `TIMEOUT`，主进程存活，新实例可服务。
2. 返回 `undefined`/函数/循环对象 → 结构化失败，无部分注册。
3. host throw/reject → `FFI_ERROR`，不泄漏宿主栈。
4. 返回超过 `maxOutputBytes` → `OUTPUT_LIMIT`。
5. 超时后 late result → 丢弃且有日志，不改变后续调用结果。
6. 嵌套/并发 FFI → 记录支持或明确 `UNSUPPORTED`，不死锁。

完成判据：`results/<engine>/<version>/async-ffi.json` 的每个故障都有原始日志、父进程存活证据、结构化错误和重启后的成功调用。任一失败只能标 `pure-dynamic` 或 `fixed-aot`，不能宣称完整替换现有 FFI。
