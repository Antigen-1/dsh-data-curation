# dsh-data-curation 0.23.0 审阅与修复记录

- 版本：0.23.0（候选，未打 tag、未发布 npm）
- 范围：`b51bc08`（0.23.0 作者化与透明度实现）及后续
  `940ecd7`、`0d4371a`、`6ae1ffb`、`45814b4`、`512cabe`。
- 验证：`node --test test/*.test.js` → 413 tests / 412 pass / 1 skip / 0 fail；
  `node scripts/selfcheck.mjs` → 136 个发布文件通过。

## 独立实现审阅

结论：**REVISE**（1 HIGH / 5 MEDIUM / 若干 LOW）。

HIGH：`buildSchemeV2Pin` 把带 `sha256:` 前缀的 plugin treeHash
直接送进 guest `pin-verify` datum，而 guest 只接受裸 hex；任何含
plugin+rules 的 pin 必然 `E-PIN-PLUGIN-TREE`，且没有 plugin 回归测试。

MEDIUM：`rulesSource` 静默覆盖已有 `pin.rules`；`curation_pin` 编译失败
只返回 message，丢掉 code/details；版本矩阵写错文件与包版本；多表模板
引用未发布的 `tools/check-summary.mjs`；builder 无真实 plugin 用例，
hash 断言自引用。

LOW：README 版本残留；builder signature 未复用 loader 校验；
coverage/request-id 测试较弱。

## 修复

- `builder.js`：guest datum 去掉可选 `sha256:` 前缀，pin 内保留带前缀 hash；
  新增真实 plugin+rules 测试（写临时项目、open、call、callPlugin）。
- `builder.js`：signature symbol 校验与 loader 一致；补 malformed 断言。
- `tools.js`：`rulesSource` 与已有 `pin.rules` 冲突直接拒绝；
  失败保留 code/details；展示 code 与 details。
- `VERSION-MATRIX.md`：改为 `lib/db.js`、0.23.0。
- `README.md`：候选改 0.23.0。
- 多表模板：移除无效 `verifyCmd`，说明需自备检查脚本。

## 有限 fix verification

对 `b51bc08..940ecd7` 做一次只读独立验证：**APPROVE**，blocking=[]。
验证者复现：prefixed tree 失败、bare tree 成功；builder 测试真实
open/call，而非仅元数据。

验证者遗留 MEDIUM：`RuleError` 使用 `.detail`（单数），`tools.js` 只读
`.details`，编译失败字段仍会丢。已在 `0d4371a` 修为
`e.details ?? e.detail ?? null`，并让失败渲染带 code；`test/tools.test.js`
59/59 通过。按“有限 fix verifier”约束，未再派第二轮独立审阅。

## 客户缺口关闭情况

- P0-1 builder/hash 公开：`buildSchemeV2Pin`、`hashSchemeSource`。
- P0-2 treeHash 文档：`docs/PIN-V2.md` 完整 canonical 编码。
- P0-3 结构化错误：保留请求 id，附 `pluginId/path/expected/actual` 等 details。
- P0-4 rulesSource：`curation_pin` 可编译 Scheme 规则进 `pin.rules`。
- P1-5 回归夹具：用 builder + templates 替代把完整 test 打进 tarball。
- P1-6 版本矩阵：`docs/VERSION-MATRIX.md`。
- P1-7 平台矩阵：Node>=24，Windows/Linux tested，macOS experimental，不阻止其他平台。
- P2-8 coverage：区分未尝试/已提交未裁定，PASS 分母不变。
- P2-9 独立 v2 校验：`curation_scheme_v2_validate`。
- P2-10 进阶模板：`templates/scheme-v2/`。

## 残余

- coverage 与 request-id 测试仍偏弱。
- Linux aarch64 只有使用者报告，未在本仓库复跑。
- 0.23.0 未打 tag、未发布 npm；本地 DSH 安装仍为已发布的 0.22.2。
