# Scheme v2 0.20.0 候选 — 独立审阅记录

- 日期：2026-11-10；第二轮复审与补修记录更新于 2026-11-11
- 范围：0.20.0 R6RS library/program 插件、动态规则、H1 fd+TLV、P3 supervisor/GC、P4 发布包、P6 指标容量
- 状态：**第二轮三路复审已完成并修复；候选已整理为单个 0.20.0 commit；仍为 NO-GO（无独立 APPROVE 签字）。未打 tag、未发布**
- 审阅树绑定：审阅冻结的代码树为 `793aec573c20797bd4afe6c4cf3728e8121f2703`（审阅时提交 `45eea88` 的内容；后续仅补版本政策文档并 squash，不改变审阅结论）
- 当前 engine：`sha256:8ec8aa06a20f2c0a3ea512ac39a9f1f787eca75d68dfe0481dadd040029f8c4b`
- 当前验证：v2 `63/63`；全量 `382 tests / 381 pass / 1 skip / 0 fail`；selfcheck `101` 个发布文件通过；10 分钟混合 smoke 完成（385,017 calls、0 error）
- 候选 tarball：`dsh-data-curation-0.20.0.tgz`，3,108,333 bytes，SHA-256 `0f1f542b61cef4f05ee11dc1ff9f725b4564811fdba1d8589a053b23d2d5d258`；解包后 selfcheck 101

## H1：无 stdin 的 FFI 通道

已关闭。H1 最终实现为 fd-backed stream + 二进制 TLV：

- Scheme 用 `open-file-input-port` / `open-file-output-port` 打开 `/dev/dsh-in-<suffix>`、`/dev/dsh-out-<suffix>`，不使用 custom port；suffix 每个 incarnation 随机生成。
- Worker 用 `FS.createDevice` 提供两个 char device；输出 byte 写入 SAB 环，输入阻塞在 `Atomics.wait`。
- 帧格式为 4 字节大端长度 + TLV；tag 0 null、1 false、2 true、3 int64、4 float64、5 utf8 string、6 array、7 object；`MAX_FRAME=65536`。
- 两侧不解析整包字符串；JSON 只保留在 host provider API 边界。
- 生产代码与测试中不再有 Emscripten `stdin`/`stdout` 字节函数；`test/scheme-v2-tlv.test.js` 有静态断言。

已否决的记录：

- Path A：libffi / `foreign-procedure`。注册符号后创建过程成功，但调用仍报 `protocol not supported (libffi unavailable)`。
- Path B 专用 `/dev` 设备早期版本：能写出启动标记，但 FFI dispatch 未到达 host；已由 H1 的 fd+TLV 替代。
- list/box replay：`test-suspend-c.mjs` 证明跨两次 C ABI 调用恢复 continuation 不可行。

## 2026-11-10 三路审阅结论

security、code、release/runtime 三路独立审阅一致 **NO-GO**。审阅覆盖 H1、插件加载、动态规则、supervisor、发布包、许可、P6 证据。

### 已修复并验证

- TLV null / 空 list：客侧新增 `'dsh-null` 哨兵，`all-pairs?` 只接受非空 alist，`'()` 编码为 tag 6 count 0；新增跨语言测试 `TLV preserves null and empty list across guest and host`。
- pin 总量：modules≤32、rules≤64、plugins≤16、ffi≤64、source 总解码≤8MiB；超限 `E-PIN-TOO-LARGE`；单请求 64MiB 上限。
- 平台门禁：`assertSupportedPlatform()` 要求 win32-x64、Node major≥24，否则 `E-UNSUPPORTED-PLATFORM`。
- supervisor close：`await exited` 加 5s 上限，spawn 只发 error/close 时不再永久挂起。
- supervised OOM：新增测试断言父运行时在 live-set OOM 后仍可 `restart()`，新实例能重新执行规则且 registry 只有静态规则。
- P6 延迟分位：`metrics()` 增加 `latencyMs.{windowMs,count,p50,p95,p99}`，最多保留最近 10000 个样本。
- P6 计数/结构化事件：`metrics()` 增加 `errorCodes`、`restarts`；`open(..., {onEvent})` 可接收 error/restart 结构化事件。FFI 调用与错误计数按 subject 绑定在运行时侧统计，不再暴露为全局 `ffiCalls/ffiErrors`。
- P6 30s 窗口：`latencyMs` 现在只统计最近 30000ms 的样本，并返回 `windowMs`；不再是最近 10000 次原始窗口。
- program FFI 上下文：program 初始化期间的 `subjectKind` 改为 `program`，不再伪装成 plugin。
- safe-eval：`(dsh safe eval (6))` 的 `environment` 只允许 R6RS 标准库，不再放行任意 `(dsh ...)`；新增测试确认无法经 `(rnrs eval)` 导入 `(dsh ffi (6))`。
- 发布包：`prepack` 改为 `node scripts/selfcheck.mjs && node --test test/*.test.js`；`pnpm pack` 成功生成 tarball，解包后 selfcheck 101 通过。
- duplicate error：`attempt-error-code` 保留 `plugin-error-code`；program 重复规则返回 `E-DUPLICATE-RULE`。
- `/out` rename：拒绝从 `/out` 外 rename 进 `/out`，errno 28；`/out` 内 rename 保留。
- 许可：MIT/UIUC/BSD 文本补齐；NOTICE 引用 MIT+UIUC；selfcheck 增加占位符检测。

### 审阅后补修（2026-11-11，未做第二轮审阅）

- H1.5a：`ffi` 条目改为 `{id, subjects}`，按 rule/library plugin/program 的 subjectHash 绑定 target；Worker 校验，missing subject/target 分别 `E-FFI-SUBJECT`/`E-FFI-TARGET`。
- H1.5b：删除公开 `ffi.call`，改为 `ffiModules`（绝对 `file://` URL、open 预加载、Worker 内 `import()`）；provider 超时 terminate ffi-worker；supervisor 支持 FFI。
- supervised program FFI：`setProgramAllowlist` 经 IPC 下发 child，spawn 后重放；动态规则继承所属 program 的 FFI 授权。
- plugin 源上限：单文件/总插件源 1MiB，超限 `E-PIN-TOO-LARGE:plugin:<id>`。
- TLV `__proto__`：对象 decode 用 `Object.defineProperty`；新增原型污染测试。
- canonical ffi：`canonicalFfi` 固定 key 顺序与 subjects 排序，消除哈希对 JSON 文本顺序的敏感。
- 删除死 API `ffiCall` 及 `ffiCalls/ffiErrors` metrics；selfcheck 纳入 `.cjs`。
- 10 分钟混合 smoke：387,037 calls（static 270,928 / plugin 77,406 / program 38,703 / ffi 38,704）、0 error；RSS 358→420MB 后 GC 回 174MB、末段 243MB；Wasm 恒定 60.4MB。

## 2026-11-11 第二轮复审与修复

三路只读复审（security / code / release）审查当时的暂存树 `b50868bef12866a07b3ebe85b8755a720fd50ce1`，结论为 security **NO-GO**、code **NO-GO**、release **CONDITIONAL**。按个人项目口径，不要求真实姓名或企业式签字；仍保留三方独立判断记录。

已修复并验证：

- TLV 数值：exact integer 超 safe range 报 `E-TLV-RANGE`；inexact flonum 不再走 int64；host 侧非安全整数与超范围解码返回 typed error，不再杀 VM；重复 FFI requestId 先回 `E-FFI-REQUEST-REUSED` 再 kill。
- TLV 对象：object 可双向返回，空对象使用 `'dsh-empty-object` 哨兵，不再与空 list 混淆；`__proto__` 使用自有属性解码。
- `ffiModules`：open 时检查 pin 声明的每个 namespace 均已声明，缺失报 `E-FFI-MODULE`；provider 调用传入 AbortSignal，超时 terminate ffi-worker。
- metadata-only：`loadSchemeV2Pin` 只做 `pin-verify`，不执行 `pin-load`/library 初始化；返回 `loaded:false`。
- program：非 JSON 结果报 `E-PLUGIN-RESULT`；`programResult` 在 closed 后报 `E-VM-CLOSED`；重复 module 名报 `E-DUPLICATE-LIBRARY`。
- 参数：`schemeValue` 拒绝 NaN/Infinity/非安全整数（`E-PIN-ARG`）。
- selfcheck：增加 engine registry 闭包校验；`.cjs` 纳入语法检查。
- TOCTOU：`loadSchemeV2Pin` 的 plugin 源读取改为 `openSync(O_NOFOLLOW)` + `fstat` + `readFileSync(fd)`，读取与校验同一 fd。
- 文档：PIN-V2 动态规则改为继承 program 授权；删除已移除的 `ffiCalls/ffiErrors` 指标描述；README/CHANGELOG/PACKAGING 计数与平台门禁同步。

仍未关闭：

- supervisor child 在 client 就绪前的早期 context/allowlist 消息可能被丢弃；正常 flow 会重发，失败时 fail-closed。
- 双 VM 并发设备名隔离与跨 subject forgery 仍只有静态/单 VM 测试。
- 完整 1h 混合负载按 5C 留在发布后；发布前 10 分钟混合 smoke 已通过。
- supervisor 无 OS 级心跳/RSS 硬上限；Wasm escape 与 provider 外部副作用仍是文档化残余风险。
- 第二轮复审后的 fix-verification 对应审阅时 content tree `793aec...`；最终候选已 squash 为单个 0.20.0 commit；仍无独立 APPROVE 签字。tarball 已按最终 tree 重打并解包 selfcheck。

### 未关闭

- **发布签字**：三路审阅原始结论为 NO-GO；后续修复未做第二轮独立审阅，因此没有 APPROVE 签字。
- **完整 1h 混合负载**：按 5C 决策放在发布后验证；发布前只有 10 分钟混合 smoke。
- **supervisor**：无 OS 级心跳/RSS 硬上限；Wasm escape 与 provider 外部副作用仍是文档化残余风险，不宣称 OS 隔离。
- **环境**：Windows 符号链接测试跳过（当前账户无创建权限）；未提交、未打 tag、未发布。

## 最终验证

- v2：`scheme-v2-pin.test.js` + `scheme-v2-program.test.js` + `scheme-v2-tlv.test.js` 63/63。
- 全量：382 tests / 381 pass / 1 skip（Windows symlink 权限）/ 0 fail，51.8s。
- selfcheck：101 个发布文件通过（含 engine registry 闭包）。
- 1h 串行 soak：120 个 30s 样本、34,621,517 次调用、0 error；p50 0.068–0.107ms、p95 0.11–0.433ms、p99 最大 1.066ms；RSS 64.8–219.4MB，Wasm 恒定 60.4MB；首末 p50 0.081→0.093ms。
- 10 分钟混合 smoke（最终代码）：385,017 calls（static 269,514 / plugin 77,002 / program 38,501 / ffi 38,502）、0 error；p50 0.155ms、p95 14.076ms、p99 15.123ms；RSS 340→470MB，末尾 60s 平台；Wasm 恒定 60.4MB。p95 由 FFI 每 10 次调用主导，稳定；RSS 仍上升约 130MB，不能替代 1h 平台期证据。

## 发布裁决

**NO-GO（生产）。** 第二轮 finding 的可修复项已修复，v2/全量/selfcheck/10 分钟混合 smoke 通过；fix-verification 对应审阅时 content tree `793aec...`，最终候选已 squash 为单个 0.20.0 commit；但第二轮复审未给出 APPROVE，完整 1h 混合负载按 5C 留到发布后，supervisor 仍无 OS 级心跳/RSS 硬上限；10 分钟混合 smoke 的 RSS 仍从 340MB 升到 470MB（末段平台）。0.20.0 可作为候选版本提交审阅，但不得宣称生产完成、不得打 tag、不得发布 npm。

## 多租户 runtime 审阅（2026-11-14）

审阅对象：staged tree `2a83ac50f44ee97294b4175f4997e0d2d558d34d`。三路只读子代理结论：security CONDITIONAL、code CONDITIONAL、release CONDITIONAL；无 APPROVE。

已修复并验证的 findings：

- HIGH restart 窗口：`restart()` 先置 `restarting`，`_drain()` 对 null worker/`postMessage` 异常 fail-closed；restart 有 overlap guard，`close()/terminate()` 等待进行中的 restart。
- close 握手：先发 `{type:'close'}` 并等待 worker `closed` 回执，超时才 terminate；worker 的 close 等待在途命令。
- manager 侧命令截止：`commandTimeoutMs`（默认 30000）到点拒绝 `E-TENANT-TIMEOUT`，标记 crashed 并终止 Worker；VM `E-TIMEOUT`/`E-VM-DEAD` 会把租户置为 crashed。
- 错误码：worker 优先保留 `.code`，否则从消息前缀提取；`callRule` 的 id/version/args 错误带 coded error。
- API/文档：补 `TenantManager.gc`；错误码表、关闭语义（注销后 `E-TENANT-ID`）、无审计日志、plugin pin 的 `rules/scheme` 前置、resourceLimits 已同步。
- 租户 id：大小写不敏感去重并拒绝尾点；`maxQueue`/`maxTenants`/`commandTimeoutMs` 校验。
- 测试：新增 call-during-restart、gc、plugin pin（租户根预置 rules/scheme）、大小写重复、非法 maxQueue、dead-VM 队列拒绝。
- 验证：tenant 6/6；全量 388 tests / 387 pass / 1 skip / 0 fail（67.5s）；selfcheck 106。
- fix-verification 代码树：`234306d98d9fa6f05f87e83e8d1cc046890f219b`（不含本记录更新）。
- 第一轮 fix-verification 发现的 HIGH 队列悬挂已修复：VM `E-TIMEOUT`/`E-VM-DEAD`/`E-VM-CLOSED`/`E-VM-EXIT` 转 crashed 时立即拒绝 active 与全部 queued pending（`E-TENANT-CRASH`），不再等待外部 restart/close。
- 第二轮只读 fix-verification：**APPROVE**（无 open HIGH/MEDIUM）；审阅 tree `5d78308be8d88cf66466469289418c15046cf942`；实现提交 `09a085c573a2b9bad655d95d57cb9d6661480b7b`。

仍未关闭：

- 只读 fix-verification 是 APPROVE，但它不是原三路审阅的签字；原始 security/code/release 结论仍是 CONDITIONAL。
- 剩余 LOW：terminate 在 restart 期间等待、并发 close 非严格幂等、restart opening 阶段返回 `E-TENANT-OPEN`、缺少 rules/scheme 时 raw ENOENT、部分 death code 与 LOW 修复无专项测试；文档计数还有少量漂移。
- supervisor child 早期 IPC 消息丢弃、双 VM 并发设备名隔离/跨 subject forgery 仍只有静态或单 VM 测试。
- 完整 1h 混合负载仍按 5C 留发布后；manager 侧超时只能保证调用方 settle，不能保证同步阻塞 provider 的外部副作用被撤销。
- 不宣称多租户生产可用；未打 tag、未发布。
