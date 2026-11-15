# dsh-data-curation 0.23.1 审阅记录

- 版本：0.23.1（0.23.0 复测修复）
- 基线：`v0.23.0` / `ebfb0dc`
- 修复提交：`1272f1b`、`0940a0d`

## 范围

只处理 0.23.0 手机复测的三个问题：

1. 静态 pin 规则误用 `callRule` 时，错误信息提示改用 `call(id, args)`。
2. `buildSchemeV2Pin` 默认 program 路径与文档统一为
   `programs/<id>/<version>.scm`。
3. 未提供 `signature` 时不再伪造 `inputs: []`；pin 省略该字段，
   loader/guest 使用 `#f`。

同时修正模板 README 的 program 路径与 `docs/PIN-V2.md` 的
optional signature 说明。

## 独立审阅

- 有限 code review：**APPROVE**，blocking=0。
- 有限 fix verifier：**APPROVE**，blocking=0。
- 非阻塞观察：`callRule` 在 id 相同但 version 不匹配时仍只报通用错误；
  已报告的场景（id+version 匹配）有提示。

## 验证

- targeted builder：4/4 pass。
- full suite：414 tests / 413 pass / 1 skip / 0 fail。
- selfcheck：136 个发布文件通过。
- 未重跑 1h soak；本次 diff 不触及 supervisor、tenant、FFI 或资源监督。

## 发布

- 0.23.1 为 0.23.0 的 authoring 修复版本。
- annotated tag：`v0.23.1`。
- npm publish 未执行；需要单独确认。
