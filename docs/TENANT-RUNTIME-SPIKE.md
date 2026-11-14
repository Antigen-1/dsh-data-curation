# 多租户 Runtime：continuation 官方文档结论

## 结论

Chez Scheme 10 的官方《User's Guide》没有 `Scall_continuation` 条目；10.4.1 的公开头文件 `boot/pb/scheme.h` 也只声明 `Scall0`/`Scall1`/`Scall2`/`Scall3`/`Scall`，没有 `Scall_continuation`。Foreign Interface 章节推荐的是 **在仍然存活的 C 调用帧内**使用 continuation，并在需要非局部退出时用 `with-exit-proc` 重置 C 栈；它不支持“C 调用返回后，再用新的 C 调用恢复旧 continuation”。

因此本项目的共享 VM 异步多租户方案不成立。采用每租户 Worker/VM（选项 B）；不实现 continuation 调度器，也不把 `Scall_continuation` 作为依赖。

## 官方依据

来源：[Chez Scheme User's Guide — Chapter 4. Foreign Interface](https://cisco.github.io/ChezScheme/csug/foreign.html)，重点为 Section 4.4 “Continuations and Foreign Calls”。

### 1. foreign context 会变 stale

文档原文要点：

> A foreign context becomes stale after a normal return to the context or after a return to some other foreign context beneath it on the control stack.

即：C 调用 Scheme 形成一个 foreign context；一旦该 C 调用正常返回，或控制返回到更下层的另一个 foreign context，这个 context 就失效。之后不能再返回到它。

### 2. 允许 nonlocal exit，不允许返回 stale context

文档说明 continuations 可以向上或向下穿过 Scheme/foreign 帧；只要不实际返回到 stale foreign context，就可以工作。仅用于 nonlocal exit 的程序不会尝试返回 stale context。

这对我们的含义：Scheme 可以在一次仍然存活的 C 调用里用 continuation 做异常/非局部退出；但不能把 continuation 存起来，等这次 C 调用返回、Node 处理完 FFI 后，再用下一次 C 调用“恢复”。

### 3. 推荐的跨 C 栈退出方式：`with-exit-proc`

文档给出的官方模式：

```scheme
(define with-exit-proc
  (lambda (p)
    (define th (lambda () (call/cc p)))
    (define-ftype ->ptr (function () ptr))
    (let ([fptr (make-ftype-pointer ->ptr th)])
      (let ([v ((ftype-ref ->ptr () fptr))])
        (unlock-object
          (foreign-callable-code-object
            (ftype-pointer-address fptr)))
        v))))
```

它的作用：

- 在取 continuation 之前建立一个 C 调用帧（通过 `foreign-callable` 包装 `th`）；
- continuation 被调用时，控制回到这个 C 帧；
- C 栈恢复到进入该帧时的位置，避免 nonlocal exit 后 C 栈持续增长；
- 返回值 `v` 再交回 Scheme。

它是 `call/cc` 的“带 C 栈复位”版本，不是跨 C 调用恢复机制。

### 4. 与当前 H1 通道的关系

当前 FFI 路径是：

```text
Scheme -> /dev/dsh-out TLV -> Node -> FFI provider -> /dev/dsh-in TLV -> Scheme
```

Scheme 在 `read-tlv-frame` 里阻塞等待。整个等待发生在当前 C 调用（`Scall1`）内部，没有返回 C；所以不存在“跨 C 调用恢复”的问题。代价是：一个 VM 在等待 FFI 时不能执行其他租户。

如果要把等待变成“让出 VM、稍后恢复”，就必须从 C 调用返回，这会使 foreign context 变 stale；官方文档没有提供之后恢复它的 API。`with-exit-proc` 只能在一个仍然存活的 C 帧内复位 C 栈，不能解决跨调用恢复。

## C ABI 实证（10.4.1 Wasm）

2026-11-14 的独立 spike 验证了 `Scall`/`Scall1` 的真实行为；完整原始输出见 `experiments/continuation-c-abi/RESULTS.md`。

- 10.4.1 公开头文件只有 `Scall0`/`Scall1`/`Scall2`/`Scall3`/`Scall`，没有 `Scall_continuation`；`/src/ChezScheme/c` 与 `boot` 中也没有该符号。
- `Scall(cp, argcnt)` 不接收参数列表；调用者必须先用 `Sinitframe(argcnt)`、`Sput_arg(i, x)` 填 frame。`Scall1` 是 `argcnt=1` 的便捷包装。
- 捕获：`(call/cc (lambda (k) (set! saved k) 11))` 经 `Scall0` 返回 11，`saved` 是 procedure。
- 同一 C 调用内 nonlocal exit：`(call/cc (lambda (k) (k 33) 99))` 返回 33。
- 捕获调用返回后，新 C 调用用 `Scall1(saved, 22)` 或 `Scall(saved, 1)` 恢复，均失败：
  `Exception: attempt to return to stale foreign context`。
- 因此 `Scall` 不能在“C 调用已返回”后替代 `Scall_continuation`；它只能在一个仍然存活的 foreign context 内调用 continuation。

## 对多租户架构的裁决

- **Gate A（共享 VM + continuation 调度）失败**：不是“尚未验证”，而是官方文档的 stale-context 规则与跨 C 调用恢复目标冲突；没有公开 API 支持。
- **选项 B（每租户 Worker/VM）成立**：每个 Worker 内 Scheme 阻塞等待自己的 FFI，不与其他租户共享执行栈；Node 管理进程只做路由/配额/重启。
- **不实现** `dsh-dispatch`/`dsh-resume`/`resumePending`；不保存 continuation 到下一次 C 调用。
- 若未来必须共享一个 VM，可使用“保持 C 帧存活”的同步阻塞模型，或把调度放在 C 调用内部；这两种都不属于当前跨调用异步模型。

## 残余风险

- `with-exit-proc` 依赖 `foreign-callable`/`define-ftype`，属于 `(chezscheme)` 能力；项目规则仍禁止直接导入 `(chezscheme)`，该模式只作为运行时内部实现参考，不暴露给租户。
- Worker 线程共享宿主内存，不是 OS 隔离；不可信租户仍应使用子进程/容器。
- 本结论只依据官方 User's Guide，不依据 Chez 源码；若未来官方文档增加跨调用 continuation API，需要重新评估。
