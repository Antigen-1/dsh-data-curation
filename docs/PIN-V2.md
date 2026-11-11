# Scheme v2 pin 与项目插件

`dsh-pin/v2` 是 `SchemeV2Runtime` 的显式 opt-in 格式。v1 仍是默认；v2 不会自动启用，也不会自动迁移 v1 pin。

## 顶层形状

```json
{
  "schema": "dsh-pin/v2",
  "engine": {
    "contract": "chez-wasm-c-10.4.1-v1",
    "engineArtifactHash": "sha256:…"
  },
  "modules": [
    {
      "name": "(dsh lib math (1 0 0))",
      "version": [1, 0, 0],
      "sourceBase64": "…"
    }
  ],
  "rules": [
    {
      "id": "rule.example",
      "version": [1, 0, 0],
      "sourceBase64": "…",
      "signature": { "inputs": ["object"], "output": "object", "variadic": false }
    }
  ],
  "plugins": [
    {
      "id": "demo",
      "version": [1, 0, 0],
      "kind": "library",
      "path": "lib/dsh/plugin/demo/1.0.0.sls",
      "treeHash": "sha256:…",
      "exports": ["answer"],
      "capabilities": []
    }
  ],
  "ffi": [
    {
      "id": "math.add",
      "subjects": [
        { "kind": "rule", "id": "rule.example", "version": [1, 0, 0] }
      ]
    }
  ]
}
```

版本是**非空、非负安全整数数组**；符号 `v1` 会被拒绝为 `E-PIN-V2-PRE-RELEASE-NAME`。库名必须是 `(dsh lib <id> (<version>...))`、`(dsh plugin <id> (<version>...))` 或 `(dsh rule <id> (<version>...))`；`name` 的版本必须与 `version` 数组一致。

## 固定搜索路径

- library：`<project>/rules/scheme/lib/dsh/<kind>/<id>/<version>.sls`，其中 `<version>` 是点号连接（`[1,0,0]` → `1.0.0`）。
- program：`<project>/rules/scheme/programs/*.scm`。
- 运行时只挂载 pin 列出的文件到 MEMFS 的 `/project/rules/scheme/...`；不开放任意搜索路径配置。
- 每个文件必须是常规文件，拒绝 symlink、`..` 越界和未列入 pin 的文件；UTF-8 非法或含 NUL 直接失败。

## Library 与 program

Library 必须是 R6RS library，名字与 pin 完全一致：

```scheme
(library (dsh plugin demo (1 0 0))
  (export answer)
  (import (rnrs base (6)) (only (dsh lib math (1 0 0)) double))
  (define (answer) (double 21)))
```

Program 是 top-level program，首个 form 必须是 `(import ...)`，不能有 `export`：

```scheme
(import (rnrs base (6)) (dsh rules (6)))

(register-rule! 'total '(1 0 0) (lambda (x) (* x 2)))
(list 'ok 1)
```

- library 依赖必须是 DAG；环报 `E-PLUGIN-DAG`，加载顺序由拓扑排序决定，不按 pin 数组顺序。
- program 在 `open` 时按 pin 顺序执行一次；最后表达式的值可由 `programResult` 读取。
- program 可 import library、调用其导出、注册动态规则；不能导出，也不能被 `callPlugin` 调用（`E-PLUGIN-NOT-CALLABLE`）。
- program 失败或 `(exit n)` 会使 `open` 失败并丢弃 VM；不存在半初始化 runtime。
- program 的结果必须是 TLV/JSON 可表示值（null、boolean、number、string、array、object）；procedure、record、`void` 等不可表示值报 `E-PLUGIN-RESULT`，不会静默变成 `null`。
- `programResult` 只能在 runtime open 期间读取；`close()` 后报 `E-VM-CLOSED`。

## 运行时 API

```js
const runtime = await SchemeV2Runtime.open(pin, {
  projectRoot,
  timeoutMs: 5000,
  ffiModules: { math: new URL('./ffi/math.mjs', import.meta.url) },
})
await runtime.call('rule.example', [1, 2])           // 位置参数形式
await runtime.call('rule.example', { procedure: 'entry', args: [1, 2] })
await runtime.callPlugin('demo', [1, 0, 0], 'answer', [])
await runtime.callRule('total', [1, 0, 0], [21])
runtime.programResult('bootstrap', [1, 0, 0])
runtime.rules      // 数组；静态 source:'static'，动态 source:'program'
runtime.metrics() // calls/errors/gcs/rss/wasmBytes/...
await runtime.close()
```

动态规则只存在于当前 incarnation，重启后由 program 重新注册；同 id 不同版本是不同规则；重复注册或覆盖静态规则报 `E-DUPLICATE-RULE`。动态规则的 FFI 授权继承所属 program 的授权：`callRule` 使用 `programSubject` 作为 FFI subject，`subjectKind='program'`；规则自身的动态 subject 只用于规则身份，不能单独获得 FFI 权限。

## 安全边界

- 所有 pin、plugin、rule 先完整校验，再发布 metadata；失败不留下部分状态。`loadSchemeV2Pin` 只做校验，不执行 library/program 初始化，返回 `loaded:false`。
- guest 使用受限 reader；`(chezscheme)`、`interaction-environment` 等逃逸入口被禁；项目源码不能直接使用 `foreign-procedure`/`load-shared-object`。
- FFI 需要 pin 声明 `{id, subjects}` 和宿主 `ffiModules` 同时允许；`subjects` 只能引用同一 pin 的 static rule、library plugin 或 program，target 必须在该主体绑定的集合内。
- `ffiModules` 的 key 是 target 命名空间（`math.add` → `math`），值是绝对 `file://` URL；`open()` 预加载所有模块，缺失/加载失败报 `E-FFI-MODULE`。不保留 `ffi.call` 闭包。
- FFI 走 fd-backed `/dev/dsh-in-<suffix>`、`/dev/dsh-out-<suffix>` + 二进制 TLV，不使用 stdin/stdout；设备名每 incarnation 随机生成。
- `supervised: true` 也支持 FFI；`ffiModules` 在 supervisor 子进程内预加载/执行，provider 超时会终止该子进程，父进程保持存活并可 restart。
- MEMFS 的 `/project` 只读，`/out` 有配额；输出有上限。
- 没有 OS 级 RSS 硬上限；Wasm 线性内存上限为 512MiB（构建期 `MAXIMUM_MEMORY`），超限分配会失败而不是无限增长；Wasm/Node Worker 不是 OS 安全边界；单租户可信项目。
- `signature` 只是纳入 hash 的完整性元数据，不强制 arity 或返回类型。
