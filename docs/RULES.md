# 规则 DSL（0.13.0：规则语言 v1，稳定语义）

> 状态：**0.13.0 规则语言 v1，稳定语义**（插件仍为 0.x）。已实现 AST、静态检查、解释器、TCO、
> 宏展开、规则注册表、签名/哈希、capability、staged effects、显式 FFI，以及 pin 的
> `validate`/`merge`/`decision`/`verify` 规则执行；**落表仍由宿主执行**。pin 仍是 v5
> 配置格式，规则是可选的 `rules` 块。

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

## Scheme 前端（R6RS 子集）

规则还可以写成 Scheme 文本。前端只负责读入和 lowering：源码先变成同一套 v1 JSON AST，
再走 `compileRule` 的静态检查、哈希、解释器和限制；pin 里保存的仍然是 AST，不是源码文本。
因此旧规则、旧 pin 和旧 golden hash 都不变。

```js
import { compileSchemeRule, readScheme } from 'dsh-data-curation/rules'

const rule = compileSchemeRule(`
  (lambda (row)
    (and (string? (object-get row "id"))
         (not (equal? (object-get row "state") "deleted"))))
`, { signature: { args: ['object'], result: 'boolean' } })

await rule.invoke([{ id: 'C-1', state: 'active' }]) // true
```

支持的核心形式：固定参数 `lambda`、`if`（必须带 else）、`begin`、`set!`、`quote`（只允许
JSON 可表示的 proper list）、`let`、`let*`、`letrec`、`letrec*`、命名 `let`、`cond`
（必须显式提供最后的 `else`）、`and`、`or`、`not`，以及函数调用和顶层 `define`。读入器支持行注释、
可嵌套块注释、`#;` datum 注释、`'datum`、字符串、`[]`、有限的十进制数字；拒绝 vector、
char、quasiquote、dotted list 和非 JSON 的 symbol 字面量。

R6RS 真值只有 `#f` 为假；JSON `null` 在前端里是真值。为了复用核心运行时，`if`/`cond`/
`and`/`or` 会在 lowering 时插入显式的 `%false?` 判断。JSON `null` 用常量 `%json-null`
表示；`null?` 判断空列表，`json-null?` 判断 JSON null。`=`、`<`、`<=`、`>`、`>=` 首版
只接受两个数字参数，非数字会按 R6RS 的契约错误处理，而不是退化成 `equal?`。
`set!` 只能修改词法局部绑定；模块顶层绑定不能在注册闭包内写入，`register-rule!`
在注册时按当前值快照闭合，之后模块变量变化不会影响已注册规则。

### 谓词与组合子

规则和谓词都是接收一个输入值的闭包，合同谓词必须返回严格 boolean；返回 `0`、`null`、
列表等会被组合子拒绝。组合子是普通 Scheme 表达式，按 Racket 的方式调用：

```scheme
(define positive-number?
  (conjoin number? (lambda (x) (> x 0))))

(lambda (row)
  ((object/c ("id" string?)
             ("tags" (list-of/c string?))
             ("score" positive-number?))
   row))
```

- `(conjoin pred ...)` / `(all-of pred ...)`：零个返回恒真，一个返回其严格化版本，
  多个从左到右短路。
- `(disjoin pred ...)` / `(any-of pred ...)`：零个返回恒假，多个从左到右短路。
- `conjoin2` / `disjoin2`：固定二元的普通高阶过程，便于作为值传递。
- `any/c` / `none/c` 是恒真/恒假谓词；`(not/c pred)`、`(equal/c expected)`、
  `(list-of/c pred)`、`(field/c "key" pred)`、`(object/c ("key" pred) ...)`
  （`fields/c` 是别名；允许额外键）、`(validate-with pred message)`、
  `(decision-with accept selector)` 是其他标准组合子。
- `validate-with` 把 boolean 谓词适配成 `{ok, errors}`；`decision-with` 保留 pin decision
  的对象协议：只有 accept 为真才调用 selector 并加 `accepted: true`，accept 为假直接返回
  `{accepted:false, reason:"rule_pending"}`，不会调用 selector。原生 decision 仍可返回
  `value`、`adopted`、`evidence` 等字段。
- `(object "key" value ...)` 是前端提供的数据构造扩展，便于构造注册 options、签名和
  decision/verify 结果；它由现有 `object-set` primitive 展开，不引入新的运行时对象类型。

`object/c` 只检查声明过的键，额外键不会被拒绝；缺失键返回失败，谓词返回非 boolean
则报严格合同错误（不会把 `0`、`null` 或列表当成假）。

### FFI

Scheme 里可以直接用 `(ffi "binding" arg ...)`，也可以用
`(ffi-predicate "binding")` 包成严格一元谓词。FFI 仍然只能调用宿主显式注册的 binding；
组合子里调用 FFI 时同样要求绑定返回 boolean，且短路语义优先。

### 脚本化注册与 pin

`register-rule!` 是加载期函数，不是运行期全局状态。调用形状为
`(register-rule! id version procedure [options])`，返回规则 id；`options` 是可选 object，
只接受 `role`、`description`、`signature`。`role` 为 `validate`、`merge`、`decision` 或
`verify`；省略 options/role 的规则只进入 registry，不进入 pin。procedure 可以是固定元数
lambda、捕获词法环境的闭包或固定元数 primitive；变参 primitive 和 FFI procedure 必须用
固定元数 lambda 显式包装。

模块加载器先收集 descriptor，再编译全部规则、生成 pin 片段并调用 `normalizePinRules`
预检；全部成功后才一次性 `define` 到 registry。重复 id/role、非法 FFI 声明、编译或 pin
校验失败都不会留下部分规则。默认在成功后封存 registry（包括调用方传入的 registry），
可用 `{ seal:false }` 显式关闭。

```js
import { loadSchemeRules } from 'dsh-data-curation/rules'

const loaded = await loadSchemeRules(`
  (define (over? row)
    (> (object-get row "amount") 100))
  (register-rule! "acme.over" "1"
    (lambda (row)
      ((decision-with over?
        (lambda (r) (object "value" (object-get r "value") "adopted" (list "scheme")))) row))
    (object
      "role" "decision"
      "description" "Scheme decision"
      "signature" (object "args" (list "object") "result" "object")))
`, { ffi })
// loaded.descriptors、loaded.registry、loaded.pinRules、loaded.sourceMap、loaded.diagnostics
```

JS 函数接口为 `registerRule(registry, descriptor, options)`，返回同一个 registry，支持链式脚本。
descriptor 使用 `{ id, version, source|scheme, role?, description?, signature? }`，其中 `source` 是 v1 AST，
`scheme` 是 Scheme 字符串，二者必须且只能提供一个。`options` 可传 `ffi`、`primitives`、
`limits`、`reader` 和编译签名覆盖。
`pinRulesFromDescriptors(descriptors, { ffi })` 生成可交给 `normalizePinRules` 的
`{version:1, ffi, <role>}`；一个 pin 只允许一个同名 role，重复 role 是加载错误，不会被
降级成 diagnostics。

```js
const loaded = await loadSchemeRules(source, { ffi })
const pin = { version: 5, tables: [...], rules: loaded.pinRules }
```

pin 里的规则身份仍是 AST 内容哈希；原始 Scheme 文本、注释和源码 span 不直接参与哈希。
标准库组合子和被捕获的辅助闭包会在 lowering/closure conversion 后按可达依赖内联成
自包含 AST，因此辅助函数或标准库实现一旦改变最终 AST，hash 就会改变；只改注释不会改变。

### 限制与错误

`readScheme` 默认限制 1,000,000 字节、100,000 个 token、256 层嵌套；可用
`maxSourceBytes`、`maxTokens`、`maxDepth` 覆盖，未知 option 或非正安全整数会被拒绝。
`compileSchemeRule`、`evaluateSchemeModule`、`loadSchemeRules` 同时接受这三个直接键和
`{ reader: { ... } }` 形式。读入错误为 `SCHEME_READ`；lowering 错误
为 `SCHEME_SYNTAX`、`SCHEME_BINDING`、`SCHEME_QUOTE`、`SCHEME_CAPTURE_MUTATION` 等；注册阶段还会产生
`SCHEME_REGISTER_ID/VERSION/ROLE/OPTIONS/SOURCE`、`DUPLICATE_RULE`、`SCHEME_FFI_DECL`、
`SCHEME_PIN_RULES`、`DUPLICATE_RULE_ROLE`。
所有错误都带源码 span（可用时）和路径，便于脚本定位。

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

### FFI 接入（0.14.0）

pin 规则现在可以使用显式声明的 FFI binding 调用本地 Node.js 模块。通过 `curation_pin`
工具的 `ffi` 参数提供模块定义：

```json
{
  "pin": { "version": 5, "rules": { "version": 1, "decision": {...} } },
  "ffi": {
    "my.processor": {
      "module": "./ffi/processor.mjs",
      "export": "process",
      "arity": 1
    }
  }
}
```

宿主在签署时动态加载这些模块，创建 `FfiRegistry` 并编译规则。模块定义会合并到
`pin.rules.ffi` 中（作为 `{id, module, export, arity}` 对象数组），使 pin 自包含：
compare/verify 阶段会从 pin 中重新加载这些定义。

规则中通过 `['ffi', 'my.processor', arg]` 调用 binding：

```json
["lambda", ["input"],
  ["let", [["vote", ["apply", ["primitive", "car"], [["apply", ["primitive", "object-get"], [["var", "input"], ["datum", "votes"]]]]]]],
    ["ffi", "my.processor", ["apply", ["primitive", "object-get"], [["var", "vote"], ["datum", "raw"]]]]]]
```

**安全边界**：

- FFI binding 是**宿主进程里的受信任函数**，不是安全隔离；
- 规则只能调用编译时 manifest 里列出的 binding id，不能 discover 或动态加载；
- 输入/输出必须是 JSON，拒绝原型污染键；
- FFI 函数本身可以访问文件系统、网络、进程——**语言层无法阻止**；
- 不可信代码的最终边界仍是操作系统沙箱。

示例：`test/ffi-integration.test.js` 演示了完整的 FFI 接入流程。

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
`field.requireEvidence` 表达，或在 0.13 的 hook 目录中扩展。

## verify 规则（0.12.0 引入）

`pin.rules.verify` 是每张表验收后的追加检查。它**不能移除或改写原生门禁**，只能追加
检查项，或把状态降为 CONDITIONAL/FAIL。

输入：

```json
{
  "table": "summary",
  "status": "PASS",
  "checks": [{ "name": "coverage", "status": "pass", "detail": "..." }],
  "accepted": 42,
  "pending": 0,
  "total": 42,
  "pendingByReason": {}
}
```

返回：

- `{ "ok": false, "reason": "..." }` → 追加 FAIL 检查 `verify_rule_ok`；
- `{ "checks": [{ "name": "audit", "status": "conditional", "detail": "..." }] }`
  → 追加 `rule.audit`，表状态按最差检查降级。

规则抛错、编译失败或哈希不一致时追加 FAIL，不会静默放行。声明后每条表验收都会执行；
规则仍无文件、网络、进程、数据库权限。

## 隔离执行（0.12.0 引入，opt-in）

`runRuleIsolated(source, args, { timeoutMs, limits })` 在 worker thread 中编译并执行纯规则，
超时直接 terminate，适合不可信/可能失控的 evaluator：

```js
import { runRuleIsolated } from 'dsh-data-curation/rules'

const out = await runRuleIsolated(source, [input], { timeoutMs: 500 })
// 纯 Scheme 源码使用同一 worker；pin 中持久化的 AST 不需要 scheme 标志。
const schemeOut = await runRuleIsolated(schemeSource, [input], { scheme: true, timeoutMs: 500 })
```

`scheme:true` 在 worker 内执行 Scheme→AST→compileRule；可用 `reader` 覆盖读入限制。
两条路径使用相同 AST 解释器与哈希语义。隔离执行只提供默认 primitive registry；自定义 primitive、FFI、capability 和 effect
journal 只在进程内可用。它也不是 OS 级沙箱：Node worker 与宿主同用户、同文件系统，
不可信代码的最终边界仍是操作系统。

## 兼容矩阵（0.13.0）

| 版本 | 规则能力 | 持久化/兼容边界 |
| --- | --- | --- |
| 0.8.0 | 核心 AST、静态检查、解释器、TCO、资源限制 | 独立 `lib/rules`，不接 pin/判定/DB |
| 0.9.0 | `let`/`letrec`/named let/`cond`、RuleRegistry、签名/哈希、capability、staged effects、FFI | 规则注册表封存后不可变 |
| 0.10.0 | pin 的 `validate`/`merge` 规则 | pin v5；规则身份/哈希进聚合封印 |
| 0.11.0 | `decision` 规则接管逐格裁定 | schema v6；decision 保存 rule/proof |
| 0.12.0 | `verify` 规则追加检查、worker 隔离执行 | verify 不删除原生门禁 |
| 0.13.0 | 规则语言 v1 冻结；兼容测试与 golden hash | `RULE_LANGUAGE_VERSION=1`、`PIN_RULES_VERSION=1`、schema v6 |

规则语言版本（`RULE_LANGUAGE_VERSION`）跟随语法/运行时语义，pin 规则版本
（`PIN_RULES_VERSION`）跟随 `pin.rules` 结构；两者独立演进。旧规则源在 v1 内保持可执行，
已知 golden hash 由 `test/rules-compat.test.js` 守护。

## 安全边界（0.13.0）

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

0.13.0 在 0.12 基础上冻结规则语言 v1，交付 pin 的 `validate`/`merge`/`decision`/`verify` 规则执行、验证规则追加检查
与 worker 隔离执行，并把规则身份写入 pin 封印、签署事件、decision 与 pack.json：

- pin validate/merge 在 `doPin` 中执行；`validatePin` 只编译，不执行；
- decision 在 `curation_compare` 中逐格执行，verify 在原生门禁后追加检查；
- apply 只消费宿主已接受的结论；
- 规则不直接写数据库，只能返回配置或裁定对象；
- 不修改真实 ESD 工作区。

0.13.0 冻结规则语言 v1 的语法、哈希算法与 pin 规则版本；后续破坏性变更必须提升
`RULE_LANGUAGE_VERSION` 并提供迁移说明。详见
`.omd/plans/rules-dsl-roadmap.md`（仓库内部计划，不随 npm 包发布）。
