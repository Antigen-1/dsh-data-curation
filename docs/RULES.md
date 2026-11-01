# 规则 DSL（0.8.0 核心）

> 状态：**0.8.0 核心语言，实验性**。已实现 AST、静态检查、解释器、尾调用优化和资源限制；
> **尚未接入 pin 校验、判定或落表**。当前 pin 仍是 v5 配置格式，不会执行这些规则。

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
| FFI | `["ffi", …]` | 0.8.0 保留，静态检查直接拒绝 |

注意：

- 没有 `let`/`letrec`/`cond`；用 lambda 参数 + `set!` + `if` 组合。
- `set!` 要求目标已经在词法作用域里绑定。想写循环时，把循环函数作为顶层 lambda 的
  参数传入（见下面的例子），再 `set!` 这个参数。
- 调用是**严格按值**的，参数先求值；不支持可变参数 lambda，`apply` 的参数个数必须
  与 lambda 形参个数一致。
- 真值只有 `false` 和 `null` 为假，`0`、`""`、`[]` 都是真。

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
- 深拷贝并冻结 AST；
- 检查未知形式、未知 primitive、未绑定 `var`/`set!`、重复参数；
- 对直接写出的 lambda 和 primitive 调用做参数个数检查；
- 检查 AST 节点数与深度；
- 拒绝 `ffi`（0.8.0 尚未开放）。

静态错误同样抛 `RuleError`，带 `code` 和 `path`；错误消息末尾会附 JSON 路径，例如
`（路径：$[2][1]）`。详见 `lib/rules/check.js`。

## 运行时语义

- 闭包捕获定义时的词法环境；`set!` 修改最近的词法单元，同一环境里的闭包共享它；
- 调用 primitive 时参数先克隆，primitive 返回后再克隆一次；
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
- `fn(args, { path })` 可以是 async，返回值必须是 JSON 值；
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
| `DUPLICATE_PARAMETER` | 静态 | lambda 形参重复 |
| `AST_LIMIT` | 静态 | 节点数/深度超限 |
| `ARITY_MISMATCH` | 静态/运行时 | 参数个数不符 |
| `FFI_UNAVAILABLE` | 静态 | 0.8.0 不支持 FFI |
| `NOT_PROCEDURE` | 运行时 | 调用了非 procedure 值 |
| `FUEL_EXHAUSTED` / `TIMEOUT` | 运行时 | 步数/时间超限 |
| `DEPTH_LIMIT` | 运行时 | 非尾调用过深 |
| `PRIMITIVE_ERROR` / `PRIMITIVE_RESULT` | 运行时 | primitive 抛错/返回非 JSON |
| `OUTPUT_LIMIT` / `RULE_RESULT` | 运行时 | 返回值过大/不是 JSON |

所有错误都是 `RuleError`，字段包括 `code`、`message`、`path`，部分带 `detail`。

## 安全边界（0.8.0）

语言层能做到：

- 不暴露 JS 全局对象、`eval`、模块加载、文件、网络、环境变量、进程或数据库句柄；
- 规则只能调用宿主显式注册的 primitive；
- 输入/输出必须为 JSON，拒绝原型污染键；
- 静态检查 + 燃料/时间/深度/输出限制。

语言层**不能**做到：

- 抢占一个永不返回的宿主 primitive；
- 把不可信 primitive 变成安全代码——primitive 运行在宿主进程里；
- 替代操作系统沙箱。真正的不可信代码隔离要等 0.9 的隔离执行与 OS 沙箱方案。

0.8.0 **没有** FFI；FFI 需要显式的 capability 交集（规则 manifest 请求 ∩ 编排层允许 ∩
本次调用授予），且不会让 pin 自己给自己扩权。

## 版本边界

0.8.0 只交付核心语言，不改变现有工具行为：

- 不读取 pin 的规则字段；
- 不参与 compare / apply / verify；
- 不写数据库；
- 不修改真实 ESD 工作区。

后续版本按路线图推进 pin 规则自举、数据抽象 primitive、显式 FFI、纵向判定规则与
verify 接管。详见 `.omd/plans/rules-dsl-roadmap.md`（仓库内部计划，不随 npm 包发布）。
