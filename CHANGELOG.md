# Changelog

All notable changes to `dsh-data-curation` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.19.0] — 2026-11-09

### Added

- 新增 opt-in Scheme v2 源级 pin 与 Chez Wasm 运行时：`SchemeV2Runtime`、`loadSchemeV2Pin`、
  `loadSchemeV2PinFile`、engine artifact/data archive 校验与长期 C ABI VM 执行。
- 新增规则级阻塞 host FFI：严格 JSON 帧、target allowlist、每 VM token、host 绑定
  `ruleHash`、唯一 requestId、timeout/cancel 中止整个 incarnation。
- 发布包加入 `assets/chez-wasm/10.4.1-c/`、`engine-registry.json` 与 `SHA256SUMS`；
  `selfcheck` 支持 Wasm 二进制 magic、size 和校验和。
- 新增 v2 源 pin 测试、FFI 传输/故障测试、engine 负例、selfcheck 单元测试，以及可复现的
  C ABI 构建与 engine 刷新脚本。

### Changed

- v2 规则只执行受限 reader 产生的 library form；`(rnrs eval (6))` 改写为
  `(dsh safe eval (6))`，禁止 `(chezscheme)` 与 `interaction-environment` 逃逸。
- 构建脚本自动把 C ABI 产物复制到实验目录与发布资产目录，避免手工复制漂移。

### Security

- 禁止空 pin 的 host FFI allow-all；拒绝未声明 target、重复 requestId、重复 rule id、
  伪造/畸形 FFI 帧、可注入 signature 符号与非有限 FFI 返回值。
- `kill`/`close` 中止在途 provider；输出和 MEMFS 写路径均有上限/规范化检查。

### Notes

- v1 仍是默认规则与 pin 路径；v2 必须显式 opt-in，尚未批准发布。
- 发布验证：v2 测试 17/17；生产测试 335 通过、1 跳过；selfcheck 88 个文件通过。
- 已知问题：相同输入重复构建时 `scheme-c.js` glue 的字节 hash 尚不稳定；P4 发布门禁
  仍将其视为阻塞项。

## [0.18.0] — 2026-11-04

### Added

- 规则 DSL 新增 Scheme expression 前端：reader、R6RS 风格真值/固定元数词法形式、source span、
  reader 资源限制，以及 Scheme→v1 JSON AST→既有 compileRule 的编译路径；旧 pin 与 golden
  hash 保持不变。
- 新增严格 boolean 谓词/组合子标准库：`conjoin`/`disjoin`、`conjoin2`/`disjoin2`、
  `any/c`/`none/c`、`object/c`、`validate-with`、`decision-with` 等；保留显式 FFI。
- 新增加载期 `(register-rule! id version procedure [options])` 与 JS `registerRule` 函数接口；
  支持词法闭包快照、循环生成规则、原子 registry 提交和 `normalizePinRules` 预检。
- `runRuleIsolated(..., { scheme:true })` 支持纯 Scheme worker；新增 Scheme 决策模板、
  真实 pin 端到端测试和 native/AST/Scheme 基准对照。

### Fixed

- `curation_query` 成功结果不再把字符串数组误当 tool content blocks；所有工具输出统一经过
  text-block 白名单正规化，避免持久化非法 tool result 毒化会话。
- 有基线但未签 pin 时，`curation_status` 现在返回成功并明确显示“未签署”，不再误报无基线。
- `curation_pin` 工具现在实际传递已公开的 `draftPath`。
- 核心 `expandRule` 现在递归展开 `apply` 操作数中的高级形式，同时不再改写 `datum` 字面量。
- Windows 下 sources 包含工作区时改用项目相对 POSIX 路径比较，正确保留基线排除警告。

### Notes

- 发布验证：317 项测试中 316 通过、0 失败；1 个 symlink 用例因当前 Windows 账户无创建权限跳过；
  selfcheck 的 76 个发布文件扫描通过。
- 本插件修复不修改 DeepSeek Harness 安装目录；宿主 `appendToolResult` 前置内容块校验仍需
  作为独立宿主补丁实施。已中毒的历史会话应新开，不能靠插件修复追溯清洗。

## [0.17.0] — 2026-11-01

完整交付：交付包计划/生成/验收，受保护列不参与自动落表。

### Added

- `curation_delivery_plan`：`show/write/build`；默认所有 active 表，生成
  `tables/*.jsonl|csv`、`pending.csv`、`review.md`、`delivery.json`。
- `curation_verify_delivery`：校验交付清单、pin 封印、各表行数、待裁定行数、复核摘要。
- pin 字段支持 `"protected": true`：apply 跳过该字段（不写表/不写 ledger，返回
  `protectedSkipped`）；verify 的 delivery_matches/ledger_complete 跳过它。
- `docs/DELIVERY.md`；工具总数 17→19。
- 全量 221/221。

### Fixed

- 交付验收按解析后的 CSV 数据行计数，不再把表头或引号内换行误判为额外记录。
- 清单改用交付包内相对路径，复制或移动整包后可独立验收，副本篡改不会误查原包。
- 计划拒绝越界路径与未知格式，避免写出交付目录或把未知格式静默降级为 JSONL。

### Notes

- 交付包不替代 `curation_verify`；它允许带待裁定格生成，业务门禁仍以 verify 为准。
- 受保护列不改变判定本身，只改变落表与两条交付门禁的检查范围。

## [0.16.0] — 2026-11-01

规模化提交：一个通道可以从文件/目录批量导入，作业按块写检查点、可续跑；查询新增
字段级覆盖。

### Added

- `curation_submit` 新增 `from`/`key`：CSV/JSONL 文件或目录，支持 JSONL 证据与扁平对象；
  与内联 `records` 二选一。
- `curation_job`：`start/status/list/resume/cancel`，按 `chunkSize` 分块提交，每块写
  `.curation/jobs/<jobId>.json`；单块失败记录并继续，状态含 `completed/partial/failed`。
- `curation_query({what:"coverage"})`：按字段返回 submitted/accepted/pending。
- `docs/SCALE.md` 与 README 规模化提交章节；工具总数 16→17。
- 全量 215/215。

### Notes

- 作业是前台分块执行，不是后台守护进程；崩溃后用 `resume` 继续。
- CSV 不能表达证据；需要证据时使用 JSONL。
- 该版本不改 pin/schema；提交格式仍由 `curation_submit` 原有的整批校验约束。

## [0.15.0] — 2026-11-01

低门槛起步：把“签 pin 之前”的成本降下来。新增记录导入、身份归一和 pin 草稿三个工具；
它们只读输入、不写工作区数据库、不签署 pin，产物都在 `.curation/` 下。

### Added

- `curation_records_import`：从 CSV/JSONL 导入记录键与字段样本，推断 `text`/`number`/`date`
  和 `allowEmpty`，报告重复键与缺键；输出 `.curation/records/<table>.jsonl`。
- `curation_identity`：按键改号、排除记录、记录→源文件映射，输出归一 JSONL 与
  `.curation/identity/<table>.json` 审计；改号后重复键整体拒绝。
- `curation_pin_draft`：根据记录样本生成 v5 pin 草稿（`.curation/pin.draft.json`），
  记录集写成自包含的 `kind:"list"`；不自动签署。
- `curation_pin` 新增 `draftPath`，可直接签署草稿；工具总数 13→16。
- `docs/INTAKE.md` 与 README 低门槛流程说明。
- 新增 6 个 intake 测试；全量 212/212。

### Notes

- Excel 不直接支持，先导出为 CSV/JSONL，避免引入 xlsx 依赖。
- 草稿的字段推断是启发式的；enum/归一化/证据要求仍需人工补充。
- 该版本不改变 pin v5、schema v6 或既有 pin/工具的行为。

## [0.14.0] — 2026-11-01

FFI 接入 pin 规则：pin 的 validate/merge/decision/verify 规则现在可以使用显式声明的
FFI binding 调用本地 Node.js 模块。

### Added

- `curation_pin` 工具新增 `ffi` 参数：`{id: {module, export?, arity?}}`，宿主动态加载
  模块并创建 `FfiRegistry`。
- `lib/ffi-loader.js`：从模块定义创建 FFI registry 的辅助函数。
- `pin.rules.ffi` 现在支持对象数组 `[{id, module, export, arity}]`，存储完整的模块定义；
  旧格式（字符串数组）仍兼容。
- compare/verify 阶段从 pin 中重新加载 FFI 定义，pin 自包含。
- `compileDecisionRule` 支持 `ffi` 参数。
- `test/ffi-integration.test.js`：2 个集成测试验证 FFI 接入流程。
- 文档：`docs/RULES.md` 新增 FFI 接入章节，README 更新。
- 全量测试 206。

### Notes

- FFI binding 是受信任宿主函数，不是安全隔离；规则只能调用 manifest 中声明的 id。
- 模块定义存储在 pin 中，确保 compare/verify 阶段可以重新加载。

## [0.13.1] — 2026-11-01

文档修复：package.json description 语法与版本号残留。

## [0.13.0] — 2026-11-01

规则语言 v1 稳定语义：冻结 0.8 以来已发布的语法、错误码、规则哈希算法与 pin 规则
结构；新增兼容性回归与 golden hash，明确后续破坏性变更的版本化方式。

### Added

- `RULE_LANGUAGE_VERSION = 1`，编译结果带 `languageVersion` 字段；
  `PIN_RULES_VERSION = 1` 保持不变。
- `test/rules-compat.test.js`：版本常量固定、简单规则 golden hash、0.8 核心形式兼容、
  默认 primitive 无文件/网络/进程能力，共 4 个用例。
- `docs/RULES.md` 增加 0.8→0.13 兼容矩阵与“破坏性变更必须提升规则语言版本”的边界。
- 全量测试 204。

### Notes

- 规则语言 v1 内不改变语法/哈希；后续破坏性变更需提升 `RULE_LANGUAGE_VERSION` 并提供
  迁移说明。
- 插件版本仍为 0.x；0.13.0 是规则语义的稳定点，不代表整个插件 1.0。

## [0.12.0] — 2026-11-01

verify hook 与隔离执行：pin 可以追加 `rules.verify` 验收检查，纯规则可在可终止的 worker
中执行；同时记录规则性能基线。仍不接真实 ESD 工作区。

### Added

- `pin.rules.verify`：每张表在原生门禁之后执行，只能追加检查或降级状态，不能移除原生
  检查；规则错误/编译失败/哈希不一致一律 FAIL，不静默放行。
- `verify` 规则身份进入签署事件、`curation_query meta` 和 `pack.json` 的 `rules` 摘要。
- `runRuleIsolated(source, args, { timeoutMs, limits })`：worker thread 隔离执行纯规则，
  超时 terminate；只提供默认 primitive，不提供 FFI/capability/effects。
- `docs/PERF.md` 与 `scripts/bench-rules.mjs`：1000 格微基准，原生 9.4ms、自定义
  decision 规则 65ms（约 6.9x）。
- 新增 6 个测试（3 个 verify 规则、3 个隔离执行）；全量测试 200。

### Notes

- verify 规则只能做纯 JSON 判定，不直接写数据库；apply 仍由宿主执行。
- worker 隔离不是 OS 级沙箱；不可信代码的最终边界仍是操作系统。
- decision 逐格调用不默认启用 worker（启动成本过高）。

## [0.11.0] — 2026-11-01

判定规则接管：pin 可以声明 `rules.decision`，逐格接受标准由 DSL procedure 决定；verify
读取 decision 的规则证明，不再用 `adopted.length` 硬编码双通道。默认无 decision 规则时
仍走原原生逻辑。

### Added

- `pin.rules.decision`：输入 `{record, field, votes, contract}`，返回接受/待裁定对象；
  声明后允许单通道提交进入 compare，由规则决定是否接受。
- `decision.rule_id` / `rule_hash` / `proof` 持久化（schema v6）；`verify` 的
  `accepted_by_rule` 检查自定义规则证明，旧原生结果仍要求两个一致通道。
- 自定义规则抛错/超时/返回坏值时只把该格标为 `rule_error` / `rule_invalid`，同批其他格
  继续裁定；绝不静默回退到原生双通道。
- `docs/RULES.md` 判定规则章节、`templates/decision-rules.example.json`、README 更新。
- 新增 3 个 decision 规则集成测试与 v5→v6 迁移测试；全量测试 194。

### Notes

- decision 规则暂不接 FFI binding；证据策略仍由 `contract.evidence` /
  `field.requireEvidence` 宿主检查。
- apply 仍由宿主执行；规则不直接写数据库。

## [0.10.0] — 2026-11-01

pin 规则自举：pin 的 `validate` 与 defaults/table 合并可以由 JSON DSL procedures 执行，
规则身份进入 pin 封印与签署事件。**判定与落表仍未接入**，未声明规则的 pin 行为不变。

### Added

- `pin.rules`（`version: 1`）支持 `validate` / `merge` / `ffi`；规则源码、id、版本、
  签名、FFI manifest 与 `sha256:` 哈希规范化后写入 pin。
- `validatePin()` 同步编译规则但不执行；`applyPinRules()` 异步执行 merge/validate，
  由 `doPin()` 在签署前调用；规则失败阻断签署。
- 默认规则包：原生 `merge` 通过 `pin.merge-table` 复用 `mergeTable`，`validate` 检查
  每张表至少有一个字段；默认包不自动注入现有 pin。
- 自定义 merge 不得改变 `delivery.table/key`、`fields`、`records`，仍由宿主执行
  `validateContract`；自定义规则错误带规则 id。
- 签署事件与 `curation_query(meta)` 暴露 pin 规则身份；`docs/RULES.md`、README 和
  `templates/pin-rules.example.json` 更新。
- 新增 7 个 pin 规则测试。

### Notes

- `canonicalize` 规则尚未实现（明确拒绝），规范化仍由宿主执行。
- 规则执行是 async；`validatePin` 保持同步，只编译。规则不直接写数据库。

## [0.9.0] — 2026-11-01

规则 DSL 的第二阶段：高级形式、规则身份、能力沙箱与显式 FFI。**仍未接入 pin、
判定或数据库**，现有工具行为不变。

### Added

- 宏展开：`let`、`letrec`、named `let`、`cond` 编译期展开为 0.8 核心 AST，支持递归、
  相互递归与尾递归循环。
- `RuleRegistry` 不可变规则注册表：`define` / `seal` / `call` / `describe` /
  `hash`，规则 id、版本、签名、FFI manifest 与调用诊断。
- 规则签名与内容哈希：`signature` 参数/返回值类型检查，`ruleHash` 覆盖源码、签名与
  FFI binding id；签名不匹配报 `SIGNATURE_MISMATCH`。
- `CapabilitySet` 能力沙箱：默认无文件、网络、环境变量、进程或数据库句柄；`data.get`
  只能经宿主授予的 `data` capability；`effects.stage` 只写内存 `EffectJournal`。
- `invokeWithEffects()` 返回结果与 staged effects，供宿主审计后决定是否提交。
- 显式 FFI：`FfiRegistry` / `{ id: fn }` manifest、静态 binding 检查、参数/结果 JSON
  隔离、`FFI_ERROR` / `FFI_RESULT`。
- 新增 12 个高级形式/注册表/沙箱/FFI 测试；`docs/RULES.md` 与 README 更新。

### Notes

- capability 是权限边界，不是 OS 进程边界；不提供进程内抢占或内存硬限制。
- 0.9.0 不读取 pin 的规则字段，不参与 compare/apply/verify，不写数据库。

## [0.8.0] — 2026-11-01

规则 DSL 的第一阶段：核心语言、静态检查、解释器与尾调用优化。**不改变现有 pin、
工具或数据库行为**，也不接入判定流程。

### Added

- 新增 `dsh-data-curation/rules` 公共入口：`compileRule`、`runRule`。
- 新增 JSON AST 形式：`datum`、`var`、`primitive`、`if`、`begin`、`set!`、`lambda`、
  `apply`；闭包捕获与 `set!` 词法赋值。
- 新增静态检查：顶层 lambda、未知形式/原语、未绑定变量、重复参数、直接调用的参数
  个数、AST 节点数与深度、JSON 值校验与防御性克隆/冻结。
- 新增异步解释器与尾调用优化（自/相互 100000 次尾递归不增长 JS 调用栈）、燃料、
  墙钟超时、非尾调用深度与输出字节预算。
- 新增不可变 `PrimitiveRegistry` 与一组纯 JSON 算术/比较/列表/字符串原语；未封存的
  registry 不能编译规则。
- 新增 `docs/RULES.md`、资源限制与错误码文档，以及 18 个规则测试。

### Notes

- 0.8.0 不提供 FFI、文件/网络/进程能力，也未把规则接入 pin 校验或判定；`ffi` 形式
  在静态检查阶段明确拒绝。
- 默认资源限制：20000 AST 节点、深度 256、10000000 步、5000ms、非尾调用深度 512、
  输出 1000000 字节。

## [0.7.1] — 2026-10-31

修复 0.7.0 批量 select 的发布验收阻断项；不改 pin 或数据库格式。

### Fixed

- **批量 select 无法签署**：pin/契约校验现在允许 `adjudication.select.batch`，并保持
  `batch: true` 只能与外部 `command` 一起使用。
- **重复结果中断整批**：批量 select 对同一格返回多个结果时，只把该格标为
  `adjudicator_error`，同批其他格继续裁定，不再让异常逃逸出 `adjudicate`。

### Tests

- 新增「pin 签署 → 双通道提交 → compare → 一次批量 select 调用」端到端回归，以及
  重复格隔离用例。

## [0.7.0] — 2026-10-31

性能与审计增强，响应 0.6.0 反馈中「逐格裁定太慢 / 载荷太大 / 审计 ID 缺失」的部分。
本轮不改 pin 格式；已有工作区打开时自动 v4→v5。

### Added

- **批量 select 策略**：`adjudication.select` 支持 `"batch": true`，一次命令判一批格
  （stdin `{kind:"select-batch", cells:[…]}` → stdout `{results:[…]}`）。单格结果缺失、
  重复或下标越界只把该格标成 `adjudicator_error`，不影响同批其它格。
- **待裁定分页**：`curation_compare` 默认只回前 100 条 `pendingCells`，新增
  `pendingTotal` 与 `pendingTruncated`；`full: true` 返回全部（配合 `scope: "all"` 可重算）。
- **审计 ID**：compare 结果带 `pinId` / `tablePinRevision` / `pinnedAt`；apply 结果带
  `applyRunId` / `decisionRunId`，可回查 `curation_query`。
- **备份保留**：`curation_apply` 的 `keepBackups`（默认 5，`0` 不清理）在成功后按文件名
  倒序清理旧快照。

### Changed

- **changed-only ledger**：schema v5 给 `ledger` 加 `changed` 列；落表只对真实变化的
  格子写 ledger，重复落表是 no-op（不备份、不写行）。`ledger_complete` 同步改为只要求
  实际变化格有留痕。
- **比较/落表提示**：当选择策略逐格 spawn 且格数 > 200 时，compare 结果带 `warnings`
  提示给策略加 `"batch": true`。

### Fixed

- `v3` 工作区迁移报错文案从「迁移到 v4」改为「迁移到 v5」（实际会连迁两级）。

## [0.6.1] — 2026-10-31

修 0.6.0 迁移交接与审计链的 12 项问题（来自真实 v3 工作区迁移反馈）。

### Fixed

- **dryRun 的 hash 与签署封印不一致**：dryRun 也按 `buildAggregate`（声明 + 表登记快照）
  计算，返回值增加 `hashKind: "aggregate"` 与 `declaredHash`（声明部分哈希）。
- **迁移工作区不自解释**：迁移现在写 `pin.sha256` / `pin.json` / `meta.pin_id`，置
  `meta.migration_pending=1`，并写 `.curation/migration-report.json`；`curation_status`
  与 `curation_verify` 会显示「迁移中间态」而不是红色「pin 缺少封印」。
- **迁移记录口径漂移被静默沿用**：交付表记录与旧契约 `records` 不一致时，写
  `migration_records_added/removed` 与项目事件，`curation_status` 列出多/少的记录号；
  迁移**不改写** `records`，由人确认后重签。
- **旧 decision/ledger 没有 provenance**：迁移与一次性修复回填 `decision.pin_id` /
  `decision.table_pin_id`、`ledger.decision_id` / `ledger.apply_run_id`、`run_table.pin_id`；
  写 `.curation/provenance-repair.json`（0.6.0 已迁移的库第一次被 0.6.1 打开时执行）。
- **`docs/MIGRATION.md` 谎称 decision 行有 `legacy_contract_hash`**：改为实际追溯链
  （pin_id / table_pin_id + ledger 绑定），并说明 `legacy_contract_hash` 只在 `table_pin` 上。
- **旧 meta 键残留**：`contract_hash` / `contract_signed_at` 改名为
  `legacy_contract_hash` / `legacy_contract_signed_at`，不再冒充当前口径。
- **force 重签无理由**：`curation_pin({ force: true })` 现在必须给 `reason`，原因写入项目事件。
- **旧名残留**：契约版本过旧的报错改为「升级为 v5 pin 后重新签署 `curation_pin`」；
  技能与 README 同步 dryRun hash 语义。
- **schema 不可见**：每次打开按 `user_version` 头检查并重建 `.curation/schema.sql`；
  `curation_verify` 增加 `schema_snapshot` 检查（派生物不一致 → CONDITIONAL）。

### Added

- `.curation/migration-report.json`、`.curation/provenance-repair.json`、`.curation/schema.sql`。
- `curation_pin` 的 `reason` 参数；`curation_status` 的 `migration` 字段
  （`pending` / `at` / `recordsAdded` / `recordsRemoved`）。
- 回归夹具 `test/migration-0.6.1.test.js`：v3 + 记录漂移 + 旧 provenance，
  以及 dryRun==签署 hash。

## [Unreleased]

## [0.6.0] — 2026-10-31

把"一个项目一份单表契约"升级为"一个项目一层 pin、多张表"：口径按表隔离，
但默认值共享；工作区 schema 升到 v4，旧契约自动转成 revision 1 的 `table_pin`。

### Added

- **两层 pin（v5）**：`project` + `defaults`（channels / normalization / evidence / gates /
  adjudication）+ `tables[]`（每表 `table` / `key` / `purpose` / `status` / `records` / `fields`
  + 任意覆盖块）。表可逐块覆盖默认；effective 配置一次物化进 `table_pin`（revision 递增）。
- **多表**：同一记录键可以同时出现在多张表里，提交、结论、留痕、增量比对、验收都按
  `(table_id, …)` 隔离；retired 表只读、默认不导出；pin 不得省略已登记的表。
- **`curation_note`**：项目级 / 表级自由文本备注，落 `project_event` / `table_event`（只追加）。
- **`curation_query` 扩展**：`table` 过滤 + `meta`（项目、pin、表登记、导出器）/ `events` 查询。
- **多表导出**：`format: "sqlite"` 一次导出全部 active 表（逐表建表写快照）；
  `includeRetired` 可把退役表带上。
- **项目级验收**：`curation_verify` 不传 `table` 时逐表验收，项目结论是项目级检查与各表状态的
  合取（FAIL > CONDITIONAL > PASS）；`verifyCmd` 逐表执行，带 `CURATION_TABLE`。

### Changed

- 术语：`contract` → `pin`；`curation_contract` → `curation_pin`；
  `contract.json` / `contract.sha256` → `pin.json` / `pin.sha256`；`contractHash` → `pinHash`。
- schema：`STATE_SCHEMA_VERSION` 3 → 4（v3 打开时先备份再迁移）；`decision` 增加
  `table_id` / `pin_id` / `table_pin_id`，`ledger` 增加 `table_id` / `decision_id` / `apply_run_id`，
  `submission` 唯一键改为 `(table_id, channel, batch, record)`。
- `curation_submit / compare / apply / verify / export` 增加 `table` 参数；`curation_init`
  可 `tables` 预告；`curation_export` 增加 `includeRetired`。
- `curation_pack` 打 `pin.json`，并收集每表 `verifyCmd` 与 `adjudication.*.command` 引用的脚本。

### Fixed

- v3 → v4 迁移先建索引再补列导致的 `no such column: table_id`：拆出 `SCHEMA_V4_BASE`，
  顺序改为 建前置表 → 重建 submission → ALTER → 回填 → 建完整 schema。
- `evidence.required = false` 时验收仍判 `evidence_present` 失败。
- `curation_export` 失败时返回裸字符串，工具渲染崩溃。

### Breaking

- v4 契约格式不再接受签署；按 [`docs/MIGRATION.md`](docs/MIGRATION.md) 转成 v5 pin。
- v3 工作区首次打开需要先有备份（插件会自动做 `.curation/backups/<stamp>__pre-v4.sqlite`）。

## [0.5.0] — 2026-10-30

来自一次真实会话（999 条 × 5 字段，6 小时核对）的取证：curation API 只覆盖了前 3 小时的 40 次调用，
之后 16 小时里操作者直接开工作区库 135 次。这一版补的就是那 135 次背后的缺口。

### Added

- **`curation_query` 只读查询**：`counts` / `pending` / `cells` / `votes` / `submissions` / `runs` / `schema`；
  `limit` 默认 50 且不设硬上限；`format: "table" | "json"`（table 按 CJK 宽度对齐）。
  以 readOnly 打开工作区，不加锁、不跑门禁、不写任何东西。
- **批量裁定协议**：`compare` 命令策略可显式声明 `batch: true`，一次调用判一批
  （stdin `{kind:"compare-batch", cells:[…]}`，stdout `{results:[…]}`）。真实项目里
  逐格 spawn 曾产生约 5,000 次子进程，是单次 compare 574s 与两次 abort 的主因。
- **增量比对**：`curation_compare` 新增 `scope: "auto" | "all"`，默认只重判有新提交或从未判过的格；
  契约哈希变化时自动回到全量。run 摘要记录 `scope/recomputed/skippedCells/contractHash`。

### Fixed

- **验收失败被渲染成「操作失败」**：`doVerify` 对 `FAIL` / `CONDITIONAL` 返回 `ok:false` 但没有 `error`，
  `verifyLines` 里的 `failure()` 守卫抢先，把「3,124 格待裁定」吞成一句「✗ 操作失败」，操作者
  此后不再跑验收。现在只有没有 `checks/status` 的结果才显示「操作失败」，并在尾部输出
  待裁定原因分布。

### Changed

- 契约版本仍为 **4**：`batch` 是可选字段，旧契约合法（未声明的策略行为完全不变）。

## [0.4.1] — 2026-10-30

### Fixed

- **所有工具在真实宿主里报 `content.some is not a function`**：`output.render` 返回了单个
  content block，而宿主要求的是数组，于是工具调用在**操作已经成功之后**被判定失败（例如
  `curation_init` 已建好工作区但界面报错）。现在 `render` 统一返回 `[{ type: 'text' }]`。
- `@deepseek-ai/dsh-tools` 不可解析时（测试、桩加载）退化为恒等 `defineTool`，不再直接崩。

### Added

- `test/tools.test.js`：逐个工具断言失败结果与成功结果的渲染形状；覆盖不到宿主包时也能跑。

## [0.4.0] — 2026-10-29

判定逻辑成为契约的一部分：哪些票算「同一个事实」、写哪个通道的原文，都可以由项目声明，
也可以换成项目自己的命令。

### Added

- 契约 v4 新增可选 `adjudication` 块：`compare`（哪些票算一致）与 `select`（写哪个写法），
  支持在 `adjudication.fields.<name>` 按字段覆盖。
- 内置 `compare`：`exact`、`numeric`（`tolerance`）、`ordered-groups`（`separator`）；
  内置 `select`：`first-valid`、`longest`、`channel-order`（`order`）、`lowest`、`highest`。
- 两个钩子都可改成项目命令：stdin 收 `{ kind, record, field, values }`，`compare` 回
  `{ groups: [[…]] }`，`select` 回 `{ index }` 或 `{ value }`。
- `decision.synthesized` 留痕：由 `select` 合成出的写法可被审计；
  `curation_compare` 与 `curation_status` 显示合成值格数。
- 工作区 schema v3：v2 工作区打开时自动补 `decision.synthesized` 列（旧行按 0 处理）。

### Changed

- 契约版本 3 → 4，旧契约需重新签署；`templates/contract.example.json` 增加策略示例。
- `curation_compare` 的描述与输出说明「一致」由契约策略判定。

### Fixed

- 契约 `version` 字段此前会被静默改写为当前版本；现在旧版与未来版本都明确报错，
  避免用错误的规则解释历史结论。
- 策略命令失败、超时、输出格式不对、下标越界时，该格一律进待裁定
  （`adjudicator_error` / `adjudicator_invalid`），绝不回退到默认策略。

## [0.3.1] — 2026-10-29

### Fixed

- **peer 范围静默排除预发布版 harness**：`>=0.1.2-rc.1 <0.3.0` 这类范围在 node-semver 下
  匹配不到 `0.2.1-rc.2`（范围内没有任何比较符落在 `0.2.1` 元组且自身带预发布标签），
  安装时 peer 校验会被静默跳过（实测 `semver.satisfies('0.2.1-rc.2', '>=0.1.2-rc.1 <0.3.0') === false`）。
  五个 `@deepseek-ai/*` peer 改为
  `>=0.1.2-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`
  —— 对 `0.2.1-rc.2` / `0.2.0-rc.3` / `0.1.3` / `0.2.5` 均成立；未来 harness 发布
  `0.2.2-*` 时需要再加一条对应分支。

## [0.3.0] — 2026-10-29

发布前加固：不新增功能，只修正确性、并发与发布工程问题。

### Fixed

- **CSV 记录源直接崩溃**：`records: { kind: 'file', path: '*.csv' }` 调 `rowsToObjects`
  时漏传表头，抛 `TypeError`。现在缺键列会报可读错误（`记录源缺少键列：<key>`）。
- **`sources: ['.']` 让基线一开始就漂移**：工作区目录被算进源基线，第一次写库后
  每个门禁都判「源基线漂移」。`buildManifest` 现在始终排除 `stateDir`，并在初始化时
  提示「sources 包含工作区目录 .curation，已从基线排除」。
- **契约含 `undefined` 键时哈希不稳**：`stableStringify` 会写出字面量 `undefined`，
  而库内存的是 JSON 往返后的对象，重读即误报「契约被手工改动」。`contractHash`
  先做 `JSON` 规范化再算哈希。
- **落表失败可能留下半截状态**：写入失败时只返回错误、事务仍提交。现在
  curated 表 + `ledger` + `applied` 在**一个事务**里提交，任何一格不一致或
  SQLite 报错都整体回滚。
- **比对结果与运行摘要分开提交**：`decision` 与 `run` 现在同一事务写入，
  不会出现「裁定引用了不存在的 run」。
- **JSONL 记录源错误没有行号**：现在报 `记录源第 N 行无法解析：<原因>`。
- **同一批里的重复记录键静默覆盖**：现在整批拒绝（`批次内重复记录：X`）。
- **打包会把符号链接指向的外部文件打进去**：被引用的脚本若为符号链接，现在跳过并警告。
- **打包条目过多/过大**：超过 65535 个条目或 4 GiB 时给出明确错误（不支持 zip64）。

### Added

- **项目锁**（`.curation/lock`）：同一项目同一时刻只允许一个写操作（init / contract /
  submit / compare / apply / exporter / pack / verify）。租约（默认 10 分钟）+ 进程判活：
  崩溃残留的锁在同机上立即失效，别的主机上等租约过期；`curation_status` 会显示持有者。
- **`busy_timeout = 5000`**：单事务相撞短暂等待，而不是立刻 `database is locked`。
- **工作区版本门**：`PRAGMA user_version` 更高或更低都拒绝打开，并给出升级/重建提示。
- **`docs/DATABASE.md`**：逐表 DDL、索引、「最新 = MAX(id)」语义、curated 表规则、
  各操作读写矩阵、备份/打包与排障命令。
- 发布元数据：`repository` / `homepage` / `bugs` / `author`；`SECURITY.md`；本 CHANGELOG。
- 测试 66 → 85 个（新增 hardening / lock / atomicity 与打包符号链接用例）。

### Changed

- `selfcheck` 现在**要求**真实 GitHub 仓库地址，并拒绝占位或本地路径形式的
  `repository` / `homepage` / `bugs`。
- 写入路径的基线校验走 `size + mtime` 快速通道（未变的文件复用旧哈希）；
  `verify` 与 `pack` 仍全量重算。

### Known limitations

- 交付表仍只支持一张（契约里的一个 `delivery`）。
- 连接仍是「每个操作新开」，未做连接复用；锁与 `busy_timeout` 已覆盖实际并发风险。
- `pending.json`、`contract.json`、`exports/` 是可重建派生物，不是权威。

## [0.2.0] — 2026-10-29

### Added

- **会话进度条**（数据抽象，不预设生命周期）：`curation_progress` 工具以
  `{ upsert, remove, clear }` 补丁更新一份 `{ bars }` 文档，经会话投影
  `curation-progress` 渲染在输入框上方（`conversation.input.dock`，order 40）。
  最多 8 条、状态 `idle/running/paused/done/error`、可用 `value/total` 或 `percent`。
- 客户端 bundle（`exports['./client']`，手写、无构建步骤、只依赖 `react`）。

## [0.1.0] — 2026-10-29

首次公开版本。

### Added

- 项目模型：只读原始材料 + 单一工作区 SQLite（`.curation/project.sqlite`）。
- 八阶段流程：`curation_init` → `curation_contract` → `curation_submit` →
  `curation_compare` → `curation_apply` → `curation_verify` → `curation_export` →
  `curation_pack`，以及 `curation_status` / `curation_exporter`。
- 三通道比对（≥2 个有效通道一致才接受）、五类待裁定原因、逐格留痕。
- 13 项验收门禁；源基线校验和闸门；落表前 `VACUUM INTO` 备份。
- 导出注册表：内置 csv/jsonl/markdown/sqlite，可注册项目导出器或外部命令。
- 三个技能（`data-curation`、`data-curation-contract`、`data-curation-audit`）、
  斜杠命令 `/curation` `/curation-status` `/curation-verify`、契约模板。
- 零第三方运行时依赖；Node ≥ 24（内置 `node:sqlite`）。

[Unreleased]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.17.0...v0.18.0
[0.6.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Antigen-1/dsh-data-curation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Antigen-1/dsh-data-curation/releases/tag/v0.1.0
