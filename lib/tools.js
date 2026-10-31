// lib/tools.js — the curation_* tool surface.
//
// A thin registration layer over lib/project.js: every tool opens the project
// and calls one method, so the model, the slash commands and other plugins all
// drive the same Project object.
import { openProject } from './project.js'
import { listExporters } from './exporters.js'
import { queryLines, statusLines, verifyLines } from './format.js'
import { BAR_LIMIT, BAR_STATUSES, appendProgressPatch, normalizePatch } from './progress.js'

const text = (s) => ({ type: 'text', text: s })
const str = (description) => ({ type: 'string', required: true, description })
const optStr = (description) => ({ type: 'string', description })
const list = (description) => ({ type: 'array', description, items: { type: 'string' } })
const json = (description) => ({ type: 'json', required: true, description })
const output = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  // The host requires a content-block ARRAY; a bare block makes it call
  // `.some` on an object and fail with "content.some is not a function".
  render: (args, value) => {
    const rendered = render(args, value)
    return Array.isArray(rendered) ? rendered : [rendered]
  },
})

function fail(v) {
  const lines = [`✗ ${v.error ?? '操作失败'}`]
  for (const e of v.errors ?? []) lines.push(`- ${e}`)
  if (v.problems?.length) lines.push(`阻断原因：${v.problems.join('；')}`)
  if (v.hint) lines.push(`提示：${v.hint}`)
  return lines.join('\n')
}

const tableLines = (tables) => {
  const lines = []
  for (const t of tables ?? []) {
    lines.push(`- ${t.table} [${t.status}] ${t.fields.length} 个字段：${t.fields.join(', ')}`)
    lines.push(`  通道：${t.channels.join(', ')}；表 pin hash=${String(t.hash).slice(0, 12)}…`)
  }
  return lines
}

export async function registerTools(ctx, { stateDir: fixedStateDir }) {
  // The host provides `defineTool`; outside a host (tests, stub loads) the
  // plain definition object is the same shape, so degrade instead of crashing.
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
    .catch(() => ({ defineTool: (definition) => definition }))
  const project = (args) => openProject({ cwd: args.cwd, stateDir: args.stateDir || fixedStateDir })
  // Plugin records are the only event kind a third-party package may append
  // without teaching every reader about it; the helper ships with the host.
  let appendPluginRecord = null
  try {
    ;({ appendPluginRecord } = await import('@deepseek-ai/dsh-session'))
  } catch {
    appendPluginRecord = null
  }

  const tools = [
    defineTool({
      name: 'curation_init',
      description:
        '建立数据核对项目：把源材料（只读）逐个记录 sha256/size/路径写入基线，并创建唯一的项目工作区 .curation/project.sqlite。' +
        '基线一旦建立，源文件内容或路径集合的任何变化都会阻断后续写入。sources 必须是项目内相对路径（文件或目录）。' +
        'tables 可在建项目时预告要登记的表名；真正生效要等 curation_pin 签署。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        sources: list('源文件或源目录（相对 cwd 的路径，只读材料）'),
        tables: list('可选的表名预告（如 esd_main）；签署 pin 时自动登记'),
        stateDir: optStr('状态目录，默认 .curation'),
        force: { type: 'boolean', description: '基线已存在时是否重建（谨慎）' },
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          `已建立源基线：${v.files} 个源文件`,
          `sha256=${v.sha256}`,
          `源：${v.sources.join(', ')}`,
          `工作区：${v.workspace}`,
        ]
        if (v.tables?.length) lines.push(`已预告表：${v.tables.join(', ')}（签署 pin 时正式登记）`)
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).init({
            sources: args.sources, force: Boolean(args.force), tables: args.tables ?? [],
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_pin',
      description:
        '签署项目 pin：一次声明「项目级默认 + 每张表的口径」，作为不可变快照存入工作区数据库并写 pin.sha256 封印。' +
        'pin 是 v5 格式：{project:{name,description},defaults:{channels,normalization,evidence,gates,adjudication},' +
        'tables:[{table,key,purpose,status,records,fields,channels?,normalization?,evidence?,gates?,adjudication?}]}。' +
        '多表项目每张表各自声明字段与交付键；defaults 只提供默认值，表可以逐键覆盖。' +
        'dryRun=true 只校验不落盘，返回的 hash 与正式签署后的封印一致（同一 aggregate），declaredHash 只是声明部分的哈希。' +
        'force=true 重签必须给 reason（写入项目事件）。pin 之后被手工改动会被验收判为不一致。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        pin: json('v5 pin 对象：{project,defaults,tables[]}（v4 契约格式会被拒绝并提示迁移）'),
        stateDir: optStr('状态目录，默认 .curation'),
        dryRun: { type: 'boolean', description: '只校验 pin，不写盘' },
        force: { type: 'boolean', description: 'pin 已签署时是否重签（需重新比对全部结果）' },
        reason: optStr('重签原因（force=true 时必填，写入项目事件）'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          v.dryRun ? 'pin 校验通过（未写盘）' : 'pin 已签署',
          `version=v${v.version}  hash=${v.hash}`,
        ]
        if (v.dryRun && v.declaredHash && v.declaredHash !== v.hash) {
          lines.push(`declaredHash=${v.declaredHash}（仅声明内容；上面的 hash 才是封印值）`)
        }
        if (v.project?.name) lines.push(`项目：${v.project.name}`)
        if (v.pinId) lines.push(`pinId=${v.pinId}`)
        if (v.records !== null && v.records !== undefined) lines.push(`记录 ${v.records} 条`)
        lines.push('表：')
        lines.push(...tableLines(v.tables))
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        if (!v.dryRun) lines.push(`工作区：${v.workspace}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).pin(args.pin, {
            force: Boolean(args.force),
            dryRun: Boolean(args.dryRun),
            reason: args.reason ?? null,
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_submit',
      description:
        '提交一个通道对一批记录的抽取结果。每个通道必须独立产出（不得先合并通道结果再提交）；' +
        'records 中每项形如 {record_id,status:"valid|uncertain|invalid",values:{字段:原文},evidence:{字段:{page,quote}}}。' +
        '空字符串表示"源材料明确未提供"，缺键表示该通道该字段弃权；不确定必须标 status:"uncertain"，不得猜测。' +
        '多表项目用 table 指定表（省略时唯一 active 表可自动选中）。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        channel: str('通道名（必须在 pin 的 channels 中声明，如 text/vision/ocr）'),
        batch: str('批次号（如 B001）'),
        records: json('记录数组'),
        table: optStr('表名（多表项目必填；单表可省略）'),
        notes: optStr('本批备注（可选）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(v.ok
        ? `表 ${v.table} 通道 ${v.channel} 批次 ${v.batch}：接收 ${v.records} 条\n写入：${v.storedIn}`
        : fail(v))),
      async execute(args) {
        try {
          return await project(args).submit({
            channel: args.channel,
            batch: args.batch,
            records: args.records,
            table: args.table,
            meta: args.notes ? { notes: args.notes } : {},
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_compare',
      description:
        '按 pin 对已提交的通道结果做逐格比对：同一记录同一字段，至少两个有效通道的归一化值被判定为一致才接受；' +
        '「一致」与「写哪个写法」由 pin 的 adjudication 策略决定（内置 exact/numeric/ordered-groups 等，也可换成项目自己的命令）；' +
        '单通道、通道分歧、策略报错或缺少证据一律进"待裁定"，不改表。结果写入工作区数据库，待裁定清单同时镜像到 pending.json。' +
        'scope=auto（默认）只重判有新提交的格；contract 换版后自动回落到全量。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        records: { type: 'array', description: '只比对这些记录（默认全部）', items: { type: 'string' } },
        fields: { type: 'array', description: '只比对这些字段（默认全部）', items: { type: 'string' } },
        scope: { type: 'string', enum: ['auto', 'all'], description: 'auto（默认）只重判有新提交的格；all 强制全量' },
        table: optStr('表名（多表项目必填；单表可省略）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        if (v.skipped) {
          return text(`表 ${v.table}：无需比对，没有新的提交（${v.skippedCells} 格保持原结论）。需要全量重判时用 scope=\"all\"。`)
        }
        const lines = [
          `表 ${v.table}：比对完成 run=${v.runId}（${v.scope === 'auto' ? '增量' : '全量'}，重判 ${v.recomputed ?? v.total} 格，跳过 ${v.skippedCells ?? 0} 格）`,
          `总格数 ${v.total}：接受 ${v.accepted}，待裁定 ${v.pending}`,
        ]
        if (v.synthesized > 0) {
          lines.push(`其中合成值 ${v.synthesized} 格：写法由 select 策略给出，决策记录里仍保留每个通道的原值`)
        }
        const reasons = Object.entries(v.byReason ?? {})
        if (reasons.length) lines.push(`待裁定原因：${reasons.map(([k, n]) => `${k}=${n}`).join('，')}`)
        lines.push(`工作区：${v.workspace}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).compare({
            records: args.records, fields: args.fields, scope: args.scope, table: args.table,
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_apply',
      description:
        '把已接受的格子写入工作区里的 curated 表：按"记录键+字段名"定位（绝不按行号），先做 VACUUM INTO 一致性备份，' +
        '再在单个事务里逐格写入并回读比对，失败整体回滚；逐格写 ledger。dryRun=true 只演练不落盘。待裁定格保持原值。' +
        '落表只接受当前 pin 下产生的接受格（旧 pin 的结果必须先重新 compare）。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        dryRun: { type: 'boolean', description: '只演练，不备份不写盘' },
        table: optStr('表名（多表项目必填；单表可省略）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          v.dryRun ? `演练：将写入 ${v.applied} 格（未落盘）` : `已写入 ${v.applied} 格`,
          `表 ${v.table}，curated 表：${v.delivery}`,
        ]
        if (v.backup) lines.push(`备份：${v.backup}`)
        for (const s of v.sample ?? []) lines.push(`- ${s.record}.${s.field} = ${JSON.stringify(s.value)}`)
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).apply({ dryRun: Boolean(args.dryRun), table: args.table })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_verify',
      description:
        '按 pin 执行全套验收：源基线未漂移、pin 封印一致、覆盖完整、接受格有两个一致通道、证据齐备、' +
        'curated 表与比对结果一致、落表留痕完整、接受比例达标、待裁定归零，并可执行该表 pin 声明的 verifyCmd。' +
        '任一硬性检查失败即 FAIL；仅剩待裁定为 CONDITIONAL。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        table: optStr('表名（多表项目必填；单表可省略）'),
        includeRetired: { type: 'boolean', description: '表已退役时仍检查其历史结果（只读）' },
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(verifyLines(v).join('\n'))),
      async execute(args) {
        try {
          return await project(args).verify({ table: args.table, includeRetired: args.includeRetired === true })
        } catch (e) {
          return { ok: false, status: 'FAIL', error: e.message, checks: [] }
        }
      },
    }),

    defineTool({
      name: 'curation_status',
      description: '只读汇总：源基线、项目 pin、各表登记与有效口径、项目导出器、提交量、比对统计、curated 表与最近一次落表。不改状态。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(statusLines(v).join('\n'))),
      async execute(args) {
        try {
          return await project(args).status()
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_export',
      description:
        '把工作区里的 curated 表导出为可重建文件。内置 csv / jsonl / markdown / sqlite；' +
        '其他格式用 curation_exporter 注册（项目状态，存在工作区数据库里）。工作区 SQLite 仍是唯一权威。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        format: { type: 'string', description: '导出格式名（默认 csv）。未注册会报错并列出可用格式' },
        out: optStr('导出到项目内相对路径（可选；默认写入工作区 exports/）'),
        table: optStr('表名（多表项目必填；单表可省略）'),
        includeRetired: { type: 'boolean', description: '多表导出时是否包含已退役的表' },
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        if (Array.isArray(v.results) && v.results.length > 1) {
          return text(`已导出 ${v.results.length} 张表 → ${v.path}（${v.format}）\n${v.results.map((r) => `- ${r.table}：${r.rows} 行 × ${r.columns} 列`).join('\n')}`)
        }
        return text(`表 ${v.table} 已导出 ${v.rows} 行 × ${v.columns} 列 → ${v.path}（${v.format}，${v.kind}）`)
      }),
      async execute(args) {
        try {
          return await project(args).export({ format: args.format || 'csv', out: args.out, table: args.table, includeRetired: args.includeRetired === true })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_exporter',
      description:
        '管理项目导出器（存在工作区数据库里，可随时增删，不需要重签 pin）。' +
        '外部导出器在项目根目录经 shell 执行：stdin 收到 {table,key,columns,rows} 的 JSON，必须把结果写到 $CURATION_EXPORT_OUT。' +
        'action=list 列出内置格式与项目导出器；add 需要 name 与 command；remove 只需 name。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        action: { type: 'string', description: 'list（默认）| add | remove', enum: ['list', 'add', 'remove'] },
        name: optStr('导出格式名（add/remove 必填；不能占用内置名）'),
        command: optStr('add：在项目根目录经 shell 执行的命令，例如 node tools/export-xlsx.mjs'),
        args: list('add：命令参数（可选）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        if (v.builtins) {
          const lines = ['内置格式：']
          for (const e of v.builtins) lines.push(`- ${e.name}（${e.extension}）：${e.description}`)
          lines.push(v.project.length ? '项目导出器：' : '项目导出器：无')
          for (const e of v.project) lines.push(`- ${e.name}：${e.command} ${(e.args ?? []).join(' ')}`.trimEnd())
          lines.push(`工作区：${v.workspace}`)
          return text(lines.join('\n'))
        }
        return text(v.action === 'add'
          ? `已注册导出器 ${v.name}：${v.command} ${(v.args ?? []).join(' ')}`.trimEnd()
          : `已移除导出器 ${v.name}（${v.removed ? '存在' : '本来不存在'}）`)
      }),
      async execute(args) {
        try {
          return await project(args).exporter({
            action: args.action || 'list',
            name: args.name,
            command: args.command,
            args: args.args ?? [],
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_pack',
      description:
        '把整个项目打成一个 zip：工作区快照（VACUUM INTO）、pin、源基线、项目导出器，以及导出器/verifyCmd 引用的外部脚本。' +
        '只读源材料本身不复制（可能很大），但会带上其基线 hash 以便迁移后仍能发现漂移。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        out: optStr('打包到项目内相对路径（可选；默认写入工作区 packs/）'),
        label: optStr('包标签（可选，写进 pack.json）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          `已打包 ${v.files.length} 个文件 → ${v.path}`,
          `大小 ${v.bytes} 字节；pin ${v.pinHash ?? v.contractHash ?? '未冻结'}；源基线 ${v.sourceManifestSha ?? '无'}`,
        ]
        for (const f of v.files) lines.push(`- ${f.name}（${f.size} 字节）`)
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).pack({ out: args.out, label: args.label })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_note',
      description:
        '给项目或某张表追加一条自由文本备注（只追加的事件流，不改数据、不改 pin）。' +
        '适合记录口径解释、数据来历、待办说明；查历史用 curation_query 的 events。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        text: { type: 'string', required: true, description: '备注正文' },
        table: optStr('表名（省略则记到项目级）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(v.ok
        ? `已记录${v.scope === 'table' ? `表 ${v.table} 的` : '项目级'}备注（${v.at}）`
        : fail(v))),
      async execute(args) {
        try {
          return await project(args).note({ text: args.text, table: args.table })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_progress',
      description:
        '在会话输入框上方维护进度条（纯数据，不规定何时创建/更新/销毁）。' +
        'upsert 按 id 合并若干条（新 id 追加、已有 id 原位合并），remove 按 id 删除，clear 清空。' +
        '工具只负责把补丁追加到会话日志，渲染由客户端 dock 读取同一份投影完成；不涉及项目工作区。',
      parameters: {
        upsert: {
          type: 'array',
          description: `新增或更新的进度条（一次最多 ${BAR_LIMIT} 条，按 id 合并）`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: str('稳定 id（同 id 视为同一条进度）'),
              label: optStr('主文本，缺省时客户端显示 id'),
              detail: optStr('次要文本（当前步骤/批次等）'),
              value: { type: 'number', description: '已完成量（与 total 配合算百分比）' },
              total: { type: 'number', description: '总量，必须大于 0' },
              unit: optStr('单位，如 例 / 项 / 批'),
              percent: { type: 'number', description: '直接给 0..100 的百分比（优先于 value/total）' },
              status: { type: 'string', enum: [...BAR_STATUSES], description: 'idle | running | paused | done | error，缺省 running' },
            },
          },
        },
        remove: { type: 'array', description: '要删除的进度条 id', items: { type: 'string' } },
        clear: { type: 'boolean', description: '清空全部进度条（不能与 upsert/remove 同时使用）' },
      },
      output: output((args, v) => text(v.ok
        ? `已更新进度条：新增/合并 ${v.upsert.length} 条${v.remove.length ? `，删除 ${v.remove.length} 条` : ''}${v.clear ? '，已清空' : ''}（${v.at}）`
        : fail(v))),
      async execute(args, exec) {
        try {
          const patch = normalizePatch(args)
          if (!appendPluginRecord) {
            throw new Error('当前宿主未提供 @deepseek-ai/dsh-session 的 appendPluginRecord，无法写入进度事件')
          }
          if (!exec.agent?.session) throw new Error('curation_progress 需要调用方的会话')
          const { at } = appendProgressPatch(exec.agent.session, patch, appendPluginRecord)
          return {
            ok: true,
            at,
            upsert: patch.upsert.map((bar) => bar.id),
            remove: patch.remove,
            clear: patch.clear,
          }
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_query',
      description:
        '只读查询工作区，替代手工开 sqlite3：counts（总览）/ pending（待裁定明细）/ cells（每格最新结论）/ ' +
        'votes（某格的逐票原值与证据）/ submissions（提交批次）/ runs（比对运行）/ meta（项目 pin 与表登记）/ ' +
        'events（项目与表事件）/ schema（表与行数）。' +
        '不写库、不加锁、不要求 pin 封印；limit 默认 50，不设上限（大结果请自行收窄过滤）。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        what: {
          type: 'string',
          required: true,
          enum: ['counts', 'pending', 'cells', 'votes', 'submissions', 'runs', 'meta', 'events', 'schema'],
          description: '查询类型',
        },
        table: optStr('按表过滤（多表项目；counts/cells/pending/votes/submissions/runs/events 均支持）'),
        record: optStr('按记录键过滤（cells / pending / votes / submissions）'),
        field: optStr('按字段过滤（cells / votes）'),
        status: { type: 'string', enum: ['accepted', 'pending'], description: '按结论状态过滤（cells）' },
        channel: optStr('按通道过滤（submissions）'),
        reason: optStr('按待裁定原因过滤（pending）'),
        limit: { type: 'number', description: '返回行数上限，默认 50（正整数，不设上限）' },
        format: { type: 'string', enum: ['table', 'json'], description: 'table（默认，便于人读）或 json（便于脚本消费）' },
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => (v.ok ? queryLines(v, { format: args.format }) : text(fail(v)))),
      async execute(args) {
        try {
          return await project(args).query({
            what: args.what,
            record: args.record,
            field: args.field,
            status: args.status,
            channel: args.channel,
            table: args.table,
            reason: args.reason,
            limit: args.limit,
          })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)
  return tools.length
}

export { listExporters }
