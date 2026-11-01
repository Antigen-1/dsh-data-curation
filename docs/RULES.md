# 规则 DSL（0.11.0：判定规则接管）

> 状态：**0.11.0 判定规则接管，实验性**。已实现 AST、静态检查、解释器、TCO、
> 宏展开、规则注册表、签名/哈希、capability、staged effects、显式 FFI，以及 pin 的
> `validate`/`merge`/`decision` 规则执行；**落表仍由宿主执行**。pin 仍是 v5 配置格式，
> 规则是可选的 `rules` 块。

这是一个 JSON 表示、可静态检查的小型解释型语言。目标不是做成通用编程语言，而是让
数据核对里的“口径”可以写成有版本、有边界、可审计的规则，而不是散落在宿主代码里的
`if`。

## 快速开始

```js
import { compileRule, runRule } from 'dsh-data-curation/rules'

const rule = compileRule([
  'lambda', ['n'],
  ['apply', ['primitive', '+'], [
    ['var', 'n'],
    ['datum', 1],
  ]],
])

await rule.invoke([41])        // 42
await runRule(ruleSource, [41]) // 便捷写法，每次重新编译
```

`compileRule` 在编译期完成全部静态检查，返回冻结对象；`invoke(args)` 只接受位置参数，
规则内部没有全局变量、模块、文件或网络。

规则可以声明输入/输出签名，编译器会把它纳入内容哈希，并在调用边界检查：

```js
const inc = compileRule(
  ['lambda', ['n'], ['apply', ['primitive', '+'], [['var', 'n'], ['datum', 1]]]],
  { signature: { args: ['number'], result: 'number' } },
)
await inc.invoke([41])   // 42
inc.hash                 // sha256:…
```

## 数据模型

规则源码和运行时值都必须是 **JSON 值**：

- `null`、布尔、有限数字、字符串、数组、纯对象；
- 拒绝 `NaN`、`Infinity`、函数、`undefined`、循环引用；
- 拒绝危险键 `__proto__`、`constructor`、`prototype`；
- 对象按普通数据克隆，不保留原型；返回值再克隆一次，调用方拿不到内部引用。

一条规则就是一个**顶层 lambda**。它没有自由变量：参数由调用方按顺序传入，其余名字
只能来自 lambda 绑定或 primitive。

## 语法

每个节点是 JSON 数组，第一个元素是操作名：

| 形式 | 写法 | 语义 |
| --- | --- | --- |
| 数据 | `["datum", value]` | 求值为 `value`（JSON 值） |
| 变量 | `["var", "name"]` | 词法查找；未绑定在静态检查期报错 |
| 原语 | `["primitive", "id"]` | 求值为宿主注册的 primitive procedure |
| 条件 | `["if", cond, then, else]` | 仅 `false` 和 `null` 为假；必须给 else |
| 顺序 | `["begin", e1, e2, …]` | 依次求值，返回最后一个 |
| 赋值 | `["set!", "name", value]` | 修改最近的词法绑定；目标必须已绑定 |
| 函数 | `["lambda", [params], body]` | 创建闭包；参数名不可重复 |
| 调用 | `["apply", operator, [args…]]` | 求值 operator 和参数，再调用 |
| FFI | `["ffi", "binding", args…]` | 只能调用宿主显式声明的 binding |
| 局部绑定 | `["let", [[name, expr]…], body]` | 展开为 lambda application |
| 递归绑定 | `["letrec", [[name, expr]…], body]` | 先绑定名字，再按顺序赋值 |
| 命名 let | `["let", "name", [[name, expr]…], body]` | 支持尾递归循环 |
| 分支 | `["cond", [test, expr…], …, ["else", expr…]]` | `else` 必须最后 |

注意：

- `let`/`letrec`/named `let`/`cond` 在编译期展开成核心 AST；手写展开与使用语法糖的
  结果、错误路径和效果一致。
- `letrec` 的初始化表达式在名字已绑定后求值，因此可以写相互递归；不要用未绑定的
  自由变量。
- 真值只有 `false` 和 `null` 为假，`0`、`""`、`[]` 都是真。
- 调用是**严格按值**的；不支持可变参数 lambda，`apply` 的参数个数必须与 lambda
  形参个数一致。

## 示例：用尾递归求列表和

可读写法：

```text
(lambda (loop xs)
  (begin
    (set! loop
      (lambda (acc rest)
        (if (empty? rest)
            acc
            (loop (+ acc (car rest)) (cdr rest)))))
    (loop 0 xs)))
```

对应 JSON：

```json
["lambda", ["loop", "xs"],
 ["begin",
  ["set!", "loop",
   ["lambda", ["acc", "rest"],
    ["if",
     ["apply", ["primitive", "empty?"], [["var", "rest"]]],
     ["var", "acc"],
     ["apply", ["var", "loop"], [
       ["apply", ["primitive", "+"],
        [["var", "acc"],
         ["apply", ["primitive", "car"], [["var", "rest"]]]]],
       ["apply", ["primitive", "cdr"], [["var", "rest"]]]
     ]]]]],
  ["apply", ["var", "loop"], [["datum", 0], ["var", "xs"]]]]]
```

调用：

```js
const sum = compileRule(source)
await sum.invoke([null, [1, 2, 3, 4]]) // 10
```

作为第一个参数传入的 `null` 只是给 `loop` 一个初始绑定；`begin` 里的 `set!` 会把它
替换成闭包。`loop` 的递归调用位于 `if` 选中分支的尾部，因此走 TCO，不会增长 JS 调用栈。

## 静态检查

`compileRule` 在执行前会：

- 确认源码是顶层 lambda；
- 展开高级形式后深拷贝并冻结 AST；
- 检查未知形式、未知 primitive、未绑定 `var`/`set!`、重复参数；
- 对直接写出的 lambda、primitive 和 FFI 调用做参数个数检查；
- 检查 AST 节点数与深度；
- 检查 `ffi` binding 是否在显式 manifest 中；未知 binding 直接拒绝。

静态错误同样抛 `RuleError`，带 `code` 和 `path`；错误消息末尾会附 JSON 路径，例如
`（路径：$[2][1]）`。详见 `lib/rules/check.js`。

## 规则身份、签名与注册表

`compileRule` 返回 `hash`，它是规则源码、签名和 FFI binding id 列表的 SHA-256 内容地址：

```js
const rule = compileRule(source, {
  signature: { args: ['number'], result: 'number' },
  ffi: { 'lookup': (args) => ({ value: args[0] }) },
})
rule.hash           // sha256:…
rule.ffiManifest    // ['lookup']
```

`signature` 的 `args` 是定长类型数组，`result` 是返回类型；支持 `any`、`json`、
`number`、`string`、`boolean`、`null`、`array`、`object`。参数个数、参数类型或返回类型
不符时报 `SIGNATURE_MISMATCH`。

`RuleRegistry` 用来冻结一组具名规则：

```js
import { RuleRegistry } from 'dsh-data-curation/rules'

const registry = new RuleRegistry()
  .define('inc', source, { version: '1', signature: { args: ['number'], result: 'number' } })
  .seal()

await registry.call('inc', [1])
registry.describe('inc')  // { id, version, hash, signature, ffiManifest, nodeCount, … }
registry.hash()           // 注册表的组合内容哈希
```

注册表封存后不能新增规则，同一 id 始终解析到同一编译结果；未注册 id 报
`UNKNOWN_RULE`。超出编译期的能力/FFI 不能通过运行时替换绕过。

## 能力沙箱与 staged effects

规则默认没有任何宿主能力。宿主必须显式构造 `CapabilitySet` 并封存：

```js
import { CapabilitySet } from 'dsh-data-curation/rules'

const caps = new CapabilitySet()
  .grant('data', (request) => request.key === 'allowed' ? { value: 'ok' } : (() => { throw new Error('denied') })())
  .seal()

await compileRule(source).invoke([], { capabilities: caps })
```

内置的能力感知 primitive：

- `("capability?" "data")`：当前调用是否授予该能力；
- `("data.get" "key")`：只能经 `data` capability handler 读取；未授予时报
  `CAPABILITY_DENIED`；
- `("effects.stage" effect)`：把写意图放入内存中的 `EffectJournal`，不会直接写数据库
  或文件；未授予 `effects` 时报 `CAPABILITY_DENIED`。

需要审计写意图时用 `invokeWithEffects()`：

```js
const { result, effects } = await compiled.invokeWithEffects([], { capabilities: caps })
// effects: [{ seq: 1, effect: { op: 'write', … } }]
```

effects 只是 staged 数据，提交/回滚由宿主决定。DSL 拿不到 `DatabaseSync`、连接对象或
事务句柄。

## FFI

FFI binding 是宿主显式声明的函数，DSL 不能自动发现或替换：

```js
const compiled = compileRule(
  ['lambda', [], ['ffi', 'now']],
  { ffi: { now: () => ({ at: Date.now() }) } },
)
await compiled.invoke([])
```

- 静态检查要求 binding id 在 manifest 中；否则 `UNKNOWN_FFI`；
- binding 参数和返回值必须是 JSON；binding 抛错转 `FFI_ERROR`，非 JSON 返回转
  `FFI_RESULT`；
- FFI binding 是**受信宿主代码**，不是安全沙箱；它能做的操作由宿主函数本身决定；
- 编译后不能通过 `runtime.ffi` 替换 binding，避免绕过 manifest 与内容哈希。

## 运行时语义

- 闭包捕获定义时的词法环境；`set!` 修改最近的词法单元，同一环境里的闭包共享它；
- 调用 primitive/FFI 时参数先克隆，返回后再克隆一次；
- capability 请求只经宿主授予的 handler；effects 只进内存 journal；
- 尾调用优化覆盖：lambda 体、`if` 选中分支、`begin` 最后一个表达式、`apply` 的调用位置；
  非尾调用计入 `maxCallDepth`；
- 100000 次自尾递归/相互尾递归已验证不增长 JS 调用栈；
- `invoke` 返回防御性 JSON 克隆，并检查序列化后的 UTF-8 字节数。

## 资源限制

默认值（`DEFAULT_LIMITS`）：

| 限制 | 默认 | 含义 |
| --- | --- | --- |
| `maxAstNodes` | 20000 | AST 节点数 |
| `maxAstDepth` | 256 | AST 嵌套深度 |
| `maxFuel` | 10000000 | 求值步数，超出报 `FUEL_EXHAUSTED` |
| `timeoutMs` | 5000 | 执行墙钟时间上限 |
| `maxCallDepth` | 512 | 非尾调用深度 |
| `maxOutputBytes` | 1000000 | 返回值 JSON 的 UTF-8 字节数 |

`compileRule(source, { limits })` 设置默认值；`invoke(args, { limits })` 按单次调用覆盖
（只覆盖给出的键）。`timeoutMs` 是**协作式**检查：每次求值、每 256 步和 primitive 返回
后检查时钟。一个长时间不返回的宿主 primitive 无法被语言层抢占；需要硬超时应在 primitive
或进程隔离层实现。

## 内置 primitive

所有内置 primitive 都做运行时类型检查，参数非法时抛 `PRIMITIVE_ERROR`：

- 算术：`+`（0+）、`-`（1+）、`*`（0+）、`/`（1+）、`modulo`、`abs`、`min`（1+）、`max`（1+）；
- 比较：`=`（2+，深比较）、`<`、`<=`、`>`、`>=`（各 2 个数字）；
- 谓词：`not`、`boolean?`、`number?`、`string?`、`list?`、`null?`、`empty?`、`pair?`；
- 列表：`list`（0+）、`cons`、`car`、`cdr`、`length`、`append`；
- 字符串：`string-append`（0+）、`number->string`、`string->number`、`string-repeat`；
- 其他：`equal?`、`json->string`、`error`。

`string-repeat` 的重复次数上限为 1000000，防止单次调用产出过大字符串。

## 自定义 primitive

宿主可以注册自己的纯函数。注册表在编译前必须封存：

```js
import { PrimitiveRegistry, compileRule } from 'dsh-data-curation/rules'

const primitives = new PrimitiveRegistry()
  .define('trim', ([text]) => String(text).trim(), { arity: 1 })
  .seal()

const rule = compileRule([...], { primitives })
```

`define(id, fn, { arity })`：

- `id` 非空且唯一；
- `fn(args, { path, context })` 可以是 async，返回值必须是 JSON 值；`context` 含
  本次调用的 capabilities 与 effect journal；
- `arity` 可以是整数、`{ min, max }`，省略表示 `{ min: 0, max: Infinity }`；
- `.seal()` 之后不能再注册；未封存的注册表不能编译规则。

primitive 是宿主代码，**不是**沙箱里的不可信代码。它能做什么由宿主授予，语言层只负责
参数/结果类型与资源边界。

## 错误

| code | 阶段 | 含义 |
| --- | --- | --- |
| `MALFORMED_AST` | 静态 | 节点结构不合法 |
| `MALFORMED_ARGUMENTS` | 运行时 | `invoke` 参数不是 JSON 数组值 |
| `RULE_MUST_BE_PROCEDURE` | 静态/运行时 | 根不是 lambda |
| `UNBOUND_VARIABLE` | 静态 | `var`/`set!` 指向未绑定名字 |
| `UNKNOWN_FORM` / `UNKNOWN_PRIMITIVE` | 静态 | 未知操作或原语 |
| `UNKNOWN_FFI` | 静态/运行时 | FFI binding 未声明或不可用 |
| `UNKNOWN_RULE` | 运行时 | registry 中没有该规则 |
| `INVALID_SIGNATURE` / `SIGNATURE_MISMATCH` | 静态/运行时 | 签名声明非法/调用边界不符 |
| `DUPLICATE_PARAMETER` | 静态 | lambda 形参或 let 绑定重复 |
| `AST_LIMIT` | 静态 | 节点数/深度超限 |
| `ARITY_MISMATCH` | 静态/运行时 | 参数个数不符 |
| `CAPABILITY_DENIED` / `CAPABILITY_ERROR` / `CAPABILITY_RESULT` | 运行时 | 未授予/执行失败/返回非 JSON |
| `FFI_ERROR` / `FFI_RESULT` | 运行时 | FFI 抛错/返回非 JSON |
| `NOT_PROCEDURE` | 运行时 | 调用了非 procedure 值 |
| `FUEL_EXHAUSTED` / `TIMEOUT` | 运行时 | 步数/时间超限 |
| `DEPTH_LIMIT` | 运行时 | 非尾调用过深 |
| `PRIMITIVE_ERROR` / `PRIMITIVE_RESULT` | 运行时 | primitive 抛错/返回非 JSON |
| `OUTPUT_LIMIT` / `RULE_RESULT` | 运行时 | 返回值过大/不是 JSON |

所有错误都是 `RuleError`，字段包括 `code`、`message`、`path`，部分带 `detail`。

## pin 规则（0.10.0 自举）

pin 可以选择性地声明 `rules` 块，把口径校验与 defaults/table 合并写成 DSL：

```json
{
  "version": 5,
  "project": { "name": "示例" },
  "defaults": { "channels": [{ "name": "text" }, { "name": "vision" }] },
  "tables": [{
    "table": "summary",
    "key": "record_id",
    "records": { "kind": "list", "values": ["CASE-1"] },
    "fields": [{ "name": "a" }]
  }],
  "rules": {
    "version": 1,
    "validate": { "id": "demo.validate", "version": "1", "source": ["lambda", ["input"], ["datum", { "ok": true, "errors": [] }]] }
  }
}
```

- `validate`：接收 `{ pin, defaults, tables }`，必须返回 `{ok, errors}`；`ok:false` 阻断签署。
- `merge`：按表接收 `{ defaults, table }`，返回该表的有效配置；宿主随后仍会执行
  `validateContract` 和结构约束。
- 规则可以调用宿主 primitive `pin.merge-table` 复用原生合并，再覆盖字段。
- **规则不能改变宿主结构**：`delivery.table`、`delivery.key`、`fields`、`records`
  必须与声明一致；违反时签署失败。
- `canonicalize` 尚未实现（0.10 会明确拒绝），规范化仍由宿主执行。
- 规则源码、规范化 ID、版本、签名和 `sha256:` 哈希都会进入 pin 存档与 aggregate 封印；
  规则哈希变化等于 pin 内容变化，必须重新签署。`doPin` 的 dryRun 返回的 hash 与正式
  签署一致。
- 规则 FFI 必须在 `rules.ffi` 声明；默认没有文件、网络、环境变量或进程能力。
- 未声明 `rules` 的既有 v5 pin 行为完全不变；默认规则包只用于示例/回归，不自动注入。

示例规则包：`templates/pin-rules.example.json`（只演示默认行为，不含项目数据）。

## 判定规则（0.11.0 接管）

`pin.rules.decision` 是一个逐格 procedure。默认没有 decision 规则，走原有原生双通道
逻辑；声明后，**该表所有格的接受标准由规则决定**，宿主不再强制"至少两个通道"。

规则输入：

```json
{
  "record": "CASE-1",
  "field": "location",
  "votes": [{ "channel": "text", "valid": true, "present": true, "raw": "A区", "normalized": "A区", "evidence": { "page": 1 } }],
  "contract": { "...": "effective 表配置" }
}
```

规则返回：

- 接受：`{ "accepted": true, "value": "A区", "adopted": ["text"], "reason": "…", "proof": {...} }`
- 待裁定：`{ "accepted": false, "reason": "need_three_channels", "detail": "…" }`

宿主仍会检查：`value` 存在、空值策略、`adopted` 必须是有效通道、证据策略；规则抛错/
超时/返回非对象时，该格进入 `rule_error`/`rule_invalid` 待裁定，**同批其他格不受影响，
绝不静默回退到原生双通道**。

接受格的 `decision.rule_id/rule_hash/proof` 会持久化；`verify` 的 `accepted_by_rule`
只看该证明，不再用 `adopted.length` 反推双通道。声明规则后允许单通道提交进入 compare，
但是否接受仍由规则决定。

示例（接受第一个有效投票，允许单通道）：

```json
["lambda",["input"],["let",[["vote",["apply",["primitive","car"],[["apply",["primitive","object-get"],[["var","input"],["datum","votes"]]]]]]],["apply",["primitive","object-set"],[["apply",["primitive","object-set"],[["datum",{"accepted":true,"reason":"rule.single-channel"}],["datum","value"],["apply",["primitive","object-get"],[["var","vote"],["datum","raw"]]]]],["datum","adopted"],["apply",["primitive","list"],[["apply",["primitive","object-get"],[["var","vote"],["datum","channel"]]]]]]]]]
```

0.11 的 decision 规则不接 FFI binding；需要额外证据时先通过 `contract.evidence` 与
`field.requireEvidence` 表达，或在 0.12 的 hook 目录中扩展。

## 安全边界（0.11.0）

语言层能做到：

- 不暴露 JS 全局对象、`eval`、模块加载、文件、网络、环境变量、进程或数据库句柄；
- 规则只能调用宿主显式注册的 primitive 和 FFI binding；
- 能力访问必须经过已封存的 `CapabilitySet`；未授予时 `CAPABILITY_DENIED`；
- staged effects 只进入内存 journal，不直接提交数据库；
- 输入/输出必须为 JSON，拒绝原型污染键；
- 静态检查 + 燃料/时间/深度/输出限制。

语言层**不能**做到：

- 抢占一个永不返回的宿主 primitive/FFI binding；
- 把不可信 primitive/FFI 变成安全代码——它们运行在宿主进程里；
- 替代操作系统沙箱。真正的不可信代码隔离仍需 OS 级沙箱；0.9 的 capability 是
  权限边界，不是进程边界。

## 版本边界

0.11.0 交付 pin 的 `validate`/`merge`/`decision` 规则执行，并把规则身份写入 pin
封印、签署事件与 decision：

- pin validate/merge 在 `doPin` 中执行；`validatePin` 只编译，不执行；
- decision 在 `curation_compare` 中逐格执行，apply 只消费宿主已接受的结论；
- 规则不直接写数据库，只能返回配置或裁定对象；
- 不修改真实 ESD 工作区。

后续版本按路线图推进 0.12 的 hook 目录、隔离执行与性能基线。详见
`.omd/plans/rules-dsl-roadmap.md`（仓库内部计划，不随 npm 包发布）。
