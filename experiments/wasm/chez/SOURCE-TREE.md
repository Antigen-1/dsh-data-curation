# SOURCE-TREE v2（实验口径）

状态：Revision 6 实验实现，供 G2 证据使用；不是生产 pin 契约。
实现：`experiments/wasm/chez/source-tree-reader.scm`；oracle：`experiments/wasm/chez/test-source-tree-oracle.mjs`。
运行时：Chez Scheme 10.4.1（Wasm），Emscripten 资产见 `experiments/wasm/chez/10.4.1/`。

## 1. 身份链

项目源码以 **源码文本** 进入 `sourceBase64`（传输/取证字段）。宿主先把 base64 解码为字节，再严格按 UTF-8 解码为字符串；当前实验 oracle 直接把字符串传给 reader。验证方：

1. 严格按 UTF-8 解码为字符串；解码失败即 `E-SOURCE`。
2. 用 Chez `read` 逐个读取顶层 datum。**不限制 readtable，不手写 tokenizer**；允许注释、`#;`、directive、radix、quote 等 reader 语法。
3. 对每个 datum 做类型、深度、长度、节点数校验。资源限制在 `read` 构造 datum 之后执行，不能宣称“读入前拒绝”。
4. 对通过校验的 datum 做确定性 canonical 编码，得到 `canonicalTree`。
5. `treeHash = SHA-256("dsh/source-tree/v2\0" || canonicalTree)`，输出小写十六进制。

不对源码字符串计算身份哈希。空白、注释、`#xFF`/`255`、`'x`/`(quote x)` 归一后必须得到同一 `treeHash`；datum 树变化必须改变 `treeHash`。

## 2. Canonical 编码

所有整数为 **大端 u32**，除非另有说明。`utf8-length` 是 UTF-8 字节数。列表和 vector 先写元素个数，再逐个写元素。

| 类型 | tag | 负载 |
|---|---:|---|
| list（含空表） | `0x01` | `count:u32`，随后 `count` 个元素 |
| symbol | `0x02` | `utf8-length:u32`，UTF-8 字节 |
| string | `0x03` | `utf8-length:u32`，UTF-8 字节 |
| exact integer | `0x04` | `sign:u8`（0 非负、1 负），`decimal-length:u32`，十进制 ASCII 绝对值；零为 `sign=0`、`"0"` |
| exact rational | `0x05` | 分子 integer 编码，分母 integer 编码；`read` 已归一，分母为正 |
| inexact real | `0x06` | 8 字节 IEEE-754 double，**小端 canonical**；NaN 固定 `00 00 00 00 00 00 f8 7f` |
| boolean | `0x07` | `0x01` 真，`0x00` 假 |
| char | `0x08` | Unicode scalar value `u32` |
| vector | `0x09` | `count:u32`，随后 `count` 个元素 |
| bytevector | `0x0A` | `length:u32`，随后原始字节 |
| source | `0x10` | `form-count:u32`，随后 `form-count` 个顶层 datum |

说明：

- **null**：Scheme `read` 没有 JSON null 这个 datum。空表是 list `count=0`；运行时 JSON null 用 guest 内部哨兵 `(vector 'dsh-null)` 表示，不进入 source tree，也没有独立 tag。宿主 JSON null 与源码身份无关。
- exact rational 的分母由 `read` 归一为正值；负号只出现在分子。
- real 用 native double 写入后按主机端序判断是否反转，输出始终小端；Wasm 主机为 little-endian。
- 不使用 `number->string` 生成 real 的 canonical 文本；real 只走 IEEE-754 字节。
- `quote` 由 `read` 归一为 `(quote x)`，两者编码相同。

## 3. 校验与限制

| 限制 | 值 | 错误码 |
|---|---:|---|
| 源码 UTF-8 字节数 | 1,048,576 | `E-SOURCE` |
| 嵌套深度 | 256 | `E-DEPTH` |
| 顶层 form 数 | 100,000 | `E-FORMS` |
| 单列表长度 | 100,000 | `E-LIST` |
| 单 vector 长度 | 100,000 | `E-VECTOR` |
| 单 string / symbol 长度 | 1,048,576 字符 | `E-STRING` / `E-SYMBOL` |
| 单 bytevector 长度 | 1,048,576 | `E-BYTEVECTOR` |
| 总节点数 | 1,000,000 | `E-NODES` |

允许：boolean、exact integer、exact rational、real（含 `+inf.0`、`-inf.0`、`+nan.0`）、char、string、symbol、proper list、vector、bytevector。

拒绝：

- improper list，以及由 reader label 构造出的循环 pair 结构：`E-DOTTED`。
- 循环 vector：`E-CYCLE`。
- complex 及其他不能规范化的 datum：`E-DATUM`。
- `read` 抛出的词法/语法错误：`E-READ`。

## 4. 诊断记录

`source-fail` 抛出：

```
(source-error code message rule-id line column "v2")
```

- `code`：上表错误码。
- `message`：固定英文短句，不含源码文本或宿主路径。
- `rule-id`：调用方传入的逻辑 id；未传时为 `"unknown"`。oracle 用 `"rule-abc"` 验证。
- `line` / `column`：当前顶层 form 的起始位置（1-based）；不是精确到出错字符的位置。
- `"v2"`：规范版本。

错误不得包含宿主绝对路径、项目文件内容或凭据。

## 5. 生产 loader 边界（AC-T5）

本实验的 Node oracle 只用于测试，不进入生产规则验证路径。生产 pin loader 的唯一信任路径是：

1. 宿主从 pin 取 `sourceBase64`，严格 UTF-8 解码。
2. 固定、受信的 Chez loader（受 `engineArtifactHash` 与宿主 trusted registry 限制）用同一 `read` + validator + canonical 实现重算 `treeHash`。
3. 比对 pin 中的 `treeHash`；不匹配则拒绝，且不执行项目源码。
4. Node 侧不得把 oracle 结果当作生产 hash 真值；oracle 只验证双端编码一致。

当前尚未实现生产 loader；AC-T5 的代码落地属于 Phase 5，本节只固定边界。

## 6. 证据与复现

```powershell
& 'C:\Users\29436\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' experiments/wasm/chez/test-source-tree-oracle.mjs
```

产物（相对项目根）：

- `experiments/wasm/results/chez/10.4.1/reader-oracle.json`：29 个 valid 向量、20 个边界/负例，含 canonicalHex/treeHash/诊断。
- `experiments/wasm/results/chez/10.4.1/reader-negative.json`：负例与 `E-READ`/`E-DOTTED`/`E-DATUM` 结果。
- `experiments/wasm/results/chez/10.4.1/source-tree.json`：规范版本、hash domain、向量 id 摘要。

当前已知边界：

- `read` 在 validator 之前分配 datum；深度/长度超限与 reader-time 崩溃只能靠 supervisor containment，不能声称预先拒绝。
- `line`/`column` 是 form 起点；精确 token 位置未实现。
- oracle 的 JS parser 独立于 Scheme 实现，但只覆盖共享向量；新增类型必须先加双端向量。
