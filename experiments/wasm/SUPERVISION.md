# 隔离与监督边界

本文件定义故障测试的“存活”判据。实现可以是 Node Worker + child process，或更外层的容器/cgroup；判据不因实现简化而降低。

## 层次

```text
test runner (never killed)
  └─ supervisor child (one task per instance; memory/CPU bounded)
       └─ guest runtime (Wasm/VM)
```

- test runner 只读取 supervisor 的结构化结果，不直接执行 guest。
- supervisor child 服务一个项目 incarnation，可连续处理多个请求并保持状态；任一次 timeout/crash/OOM 后整个 incarnation 废弃，不复用可疑状态。
- OOM 测试的 child 必须承受内存故障；test runner 只观察它退出并继续启动下一个 child。
- 输入、日志和结果都通过有大小上限的管道/文件传递；不把工作区或宿主环境映射进 guest。

## 生命周期

1. **spawn**：父进程启动 supervisor，传递已冻结的 `limits.json`、`engine`、`artifact manifest`。
2. **ready**：supervisor 完成启动并返回 `{ready:true,pid,engine,limitsHash}`；超时或形状不符即失败。
3. **task(s)**：父进程在同一 incarnation 内发送一个或多个请求；每个请求有唯一 requestId 和完成边界，supervisor 逐一返回契约响应。
4. **terminate**：父进程可因超时/取消/崩溃发送终止；supervisor 必须清理 guest，不依赖优雅退出；终止后该 incarnation 的全部状态作废。
5. **restart**：父进程用同一配置启动新 supervisor，完成一次最小 eval 后才算“可服务”。

## 故障判据

| 故障 | 主测试进程 | supervisor | 结构化结果 | 后续 |
|---|---|---|---|---|
| 死循环 | 存活 | 被父级终止 | `TIMEOUT` | 新实例成功 |
| 输出超限 | 存活 | 正常返回或终止 | `OUTPUT_LIMIT` | 新实例成功 |
| 内存超限 | 存活 | 被 OS/cgroup 杀死 | `MEMORY_LIMIT` | 新实例成功 |
| guest 崩溃 | 存活 | 非零退出 | `EVAL_ERROR`/`PROTOCOL_ERROR` | 新实例成功 |
| 协议错帧 | 存活 | 终止或拒绝 | `PROTOCOL_ERROR` | 不污染下一实例 |

主测试进程死亡、无法观察到结构化错误、或终止后不能启动新实例，任一项即隔离门禁失败；不能以“平时没有触发”为由通过。

## 资源执行层

- wall timeout 由父亲自计时，不能只信 guest 自报。
- 内存上限由 supervisor 的 OS/cgroup/Linux namespace 执行；Windows 上若只能使用 Job Object，必须记录实际机制和是否可靠覆盖 Wasm。
- 不把 Node `Worker.resourceLimits` 当作 Wasm 内存上限；它只能作为 JS heap 辅助限制。
- 容器运行时（Podman）只提供 Linux 构建/执行载体，不替代 Guix/Akku 锁文件，也不自动证明 cgroup 限制生效。

## 日志最低字段

`timestamp`、`engine`、`artifactId/hash`、`operation`、`requestId`、`limitsHash`、`supervisorPid`、`exitCode/signal`、`durationMs`、`error.code`、`stdout/stderr` 截断位置。任何截断都必须显式标记，不能静默丢日志。

完成判据：`results/<engine>/<version>/supervision.json` 对每个故障给出上述字段，并附“主进程存活 + 新实例可服务”的证据。

## 当前实验实现

C ABI Phase 1 实验使用 Node `Worker` 作为 supervisor，不是独立 OS 进程或 cgroup。timeout/guest exit 后由父进程 terminate 该 Worker，并在新 Worker 中验证可服务；这满足“主进程存活 + 新实例可服务”，但不提供 OS 级内存隔离。C ABI 的 OOM 证据是人为裁剪 Wasm linear memory 上限后的 abort，不是 OS/cgroup OOM kill；因此 G1 的 OOM 不计入 C ABI PASS。生产候选必须重新评估这一层。
