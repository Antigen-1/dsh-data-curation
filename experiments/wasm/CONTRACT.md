# 执行语义契约

机器可读权威是 [contract/contract.json](contract/contract.json)。本文件解释**为什么**有这些约束；字段名、枚举和上限以 JSON 为准，不在这里重复一份。

## 目的

三个运行时必须接收同一个请求，返回同一种可比较的响应。否则“Hoot 能跑、Chibi 不能”只是两套 demo 的输出差异，不能作为选型证据。

完成判据：同一 `fixtures/corpus.json` 条目在任一候选上产生的响应，能由 `node/oracle.mjs` 的比较器直接判定 pass/fail，且失败带请求 id 与首个差异路径。

## 两种能力，不能混报

| 级别 | 能做什么 | 不能据此声称什么 |
|---|---|---|
| `fixed-aot` | 固定可信源码编译后调用 | 不能声称动态源码或动态注册可用 |
| `pure-dynamic` | guest 内 `eval` 新源码、加载模块、动态注册 | 不能声称 v1 AST/pin/canonical hash 已可用 |
| `async-ffi` | guest 发起允许的异步宿主调用并恢复 | 不能声称任意 JS/文件/网络能力安全 |

候选的最终标签取实际通过的最高级别；低级别通过必须保留，不能被以后失败覆盖。

## 请求与响应

- `eval`：`source` 是当前 Scheme-like 子集的一元/多元过程，`args` 是 JSON 数组。成功返回 `{id,ok:true,value}`。
- `load-module`：成功返回 `{id,ok:true,stateIds,ids,calls}`。`ids` 是排序后的注册 id；`calls` 逐条调用并返回各自结果。失败返回 `{id,ok:false,error,stateIds}`，`stateIds` 是失败后仍可见的注册 id，用来验证原子性。
- `isolated`：同一语义，但由父级隔离边界执行。超时/输出/内存失败使用契约错误码，不把宿主进程崩溃算作通过。
- `capabilities`：候选自报级别、imports 和限制。自报不是证据；必须有对应 corpus 通过。

`error.code` 是机器判定字段；`message` 只供人读。`path` 当前 DSL 的错误必须保留，不能因为换引擎而丢失。错误响应不得包含宿主栈、环境变量或文件路径。

## corpus

`fixtures/corpus.json` 的每条：

```json
{
  "id": "static.truth.null",
  "tier": "minimum",
  "request": { "op": "eval", "source": "...", "args": [null] },
  "expected": { "ok": true, "value": 1 }
}
```

- `tier`：`minimum` 是 smoke 门槛，`semantic` 是完整契约，`dynamic` 需要 `pure-dynamic`。
- `expected` 按子集比较；错误至少比较 `code`，若 expected 写了 `path`/`message` 才比较。
- `load-module` 的 `expected.calls` 是数组，每项用 `{rule,args,expected}` 描述。
- 任何条目都不比较 v1 AST、pin descriptor、canonical hash 或 SQLite 状态。

## 动态注册的边界

`load-module` 只观察：注册 id、每条规则的调用结果、失败后的可见 id。它不要求 guest 生成当前 `RuleRegistry` 对象，也不要求序列化 closure。这个口径避免把“运行时能力”与“现有 AST/pin 桥”混成一个阻塞项。

完成判据：`fixtures/corpus.json` 中所有 `dynamic` 条目在候选上产生与当前解释器相同的可观察结果；否则该候选最高只能标 `fixed-aot`。

## 失败语义

- 编译错误：发生在 `eval`/`load-module` 的编译阶段，返回 `ok:false`，不得先执行部分模块。
- 运行时错误：区分 `TIMEOUT`、`OUTPUT_LIMIT`、`MEMORY_LIMIT`、结构化 guest 错误；不允许静默返回 `null`。
- 原子失败：重复 id/role、捕获拒绝、FFI 声明失败后，`stateIds` 必须等于失败前状态；不得留下半条规则。
- 协议错误：未知字段、非法 JSON、非法响应形状记 `PROTOCOL_ERROR`，不是通过。

## 与生产的关系

本契约的 `scope` 固定为 `execution-semantics-only`。即使全部通过，也只说明候选能执行当前子集；v1 AST 桥、source-native 身份、pin 重签、发布资产和回滚仍需独立生产迁移计划与批准。
