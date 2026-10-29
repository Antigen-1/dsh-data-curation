// lib/tools.js — the curation_* tool surface.
//
// A thin registration layer over lib/project.js: every tool opens the project
// and calls one method, so the model, the slash commands and other plugins all
// drive the same Project object.
import { openProject } from './project.js'
import { listExporters } from './exporters.js'
import { statusLines, verifyLines } from './format.js'
import { BAR_LIMIT, BAR_STATUSES, appendProgressPatch, normalizePatch } from './progress.js'

const text = (s) => ({ type: 'text', text: s })
const str = (description) => ({ type: 'string', required: true, description })
const optStr = (description) => ({ type: 'string', description })
const list = (description) => ({ type: 'array', description, items: { type: 'string' } })
const json = (description) => ({ type: 'json', required: true, description })
const output = (render) => ({ schema: { type: 'object', additionalProperties: true }, render })

function fail(v) {
  const lines = [`✗ ${v.error ?? '操作失败'}`]
  for (const e of v.errors ?? []) lines.push(`- ${e}`)
  if (v.problems?.length) lines.push(`阻断原因：${v.problems.join('；')}`)
  if (v.hint) lines.push(`提示：${v.hint}`)
  return lines.join('\n')
}

export async function registerTools(ctx, { stateDir: fixedStateDir }) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
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
        '基线一旦建立，源文件内容或路径集合的任何变化都会阻断后续写入。sources 必须是项目内相对路径（文件或目录）。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        sources: list('源文件或源目录（相对 cwd 的路径，只读材料）'),
        stateDir: optStr('状态目录，默认 .curation'),
        force: { type: 'boolean', description: '基线已存在时是否重建（谨慎）' },
      },
      output: output((args, v) => text(v.ok
        ? `已建立源基线：${v.files} 个源文件\nsha256=${v.sha256}\n源：${v.sources.join(', ')}\n工作区：${v.workspace}`
        : fail(v))),
      async execute(args) {
        try {
          return await project(args).init({ sources: args.sources, force: Boolean(args.force) })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_contract',
      description:
        '冻结项目口径契约（字段、记录集、通道、交付表、验收门槛），存入工作区数据库并写入契约封印。' +
        'dryRun=true 只校验不落盘，用于配置期反复试错。契约之后被手工改动会被验收判为不一致。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        contract: json('契约对象：{fields[],records,delivery:{table,key},channels[],gates,identity?}'),
        stateDir: optStr('状态目录，默认 .curation'),
        dryRun: { type: 'boolean', description: '只校验契约，不写盘' },
        force: { type: 'boolean', description: '契约已冻结时是否重签（需重新比对全部结果）' },
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          v.dryRun ? '契约校验通过（未写盘）' : '契约已冻结',
          `${v.fields.length} 个字段 / ${v.channels.length} 个通道 / 记录 ${v.records ?? '未知'} 条`,
          `hash=${v.hash}`,
          `交付表：${v.delivery.table}（键=${v.delivery.key}，位于项目工作区）`,
          `字段：${v.fields.join(', ')}`,
        ]
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        if (!v.dryRun) lines.push(`工作区：${v.workspace}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          const outcome = await project(args).contract(args.contract, {
            force: Boolean(args.force),
            dryRun: Boolean(args.dryRun),
          })
          if (outcome.dryRun) delete outcome.contract
          return outcome
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
        '空字符串表示"源材料明确未提供"，缺键表示该通道该字段弃权；不确定必须标 status:"uncertain"，不得猜测。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        channel: str('通道名（必须在契约 channels 中声明，如 text/vision/ocr）'),
        batch: str('批次号（如 B001）'),
        records: json('记录数组'),
        notes: optStr('本批备注（可选）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(v.ok
        ? `通道 ${v.channel} 批次 ${v.batch}：接收 ${v.records} 条\n写入：${v.storedIn}`
        : fail(v))),
      async execute(args) {
        try {
          return await project(args).submit({
            channel: args.channel,
            batch: args.batch,
            records: args.records,
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
        '按契约对已提交的通道结果做逐格比对：同一记录同一字段，至少两个有效通道的归一化值一致才接受；' +
        '单通道、通道分歧、缺少证据一律进"待裁定"，不改表。结果写入工作区数据库，待裁定清单同时镜像到 pending.json。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        records: { type: 'array', description: '只比对这些记录（默认全部）', items: { type: 'string' } },
        fields: { type: 'array', description: '只比对这些字段（默认全部）', items: { type: 'string' } },
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          `比对完成 run=${v.runId}`,
          `总格数 ${v.total}：接受 ${v.accepted}，待裁定 ${v.pending}`,
        ]
        const reasons = Object.entries(v.byReason ?? {})
        if (reasons.length) lines.push(`待裁定原因：${reasons.map(([k, n]) => `${k}=${n}`).join('，')}`)
        const samples = (v.pendingCells ?? []).slice(0, 8)
        if (samples.length) lines.push(`示例：${samples.map((s) => `${s.record}.${s.field}(${s.reason})`).join('；')}`)
        lines.push(`工作区：${v.workspace}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).compare({ records: args.records, fields: args.fields })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_apply',
      description:
        '把已接受的格子写入工作区里的 curated 表：按"记录键+字段名"定位（绝不按行号），先做 VACUUM INTO 一致性备份，' +
        '再在单个事务里逐格写入并回读比对，失败整体回滚；逐格写 ledger。dryRun=true 只演练不落盘。待裁定格保持原值。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        dryRun: { type: 'boolean', description: '只演练，不备份不写盘' },
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => {
        if (!v.ok) return text(fail(v))
        const lines = [
          v.dryRun ? `演练：将写入 ${v.applied} 格（未落盘）` : `已写入 ${v.applied} 格`,
          `curated 表：${v.delivery}`,
        ]
        if (v.backup) lines.push(`备份：${v.backup}`)
        for (const s of v.sample ?? []) lines.push(`- ${s.record}.${s.field} = ${JSON.stringify(s.value)}`)
        for (const w of v.warnings ?? []) lines.push(`注意：${w}`)
        return text(lines.join('\n'))
      }),
      async execute(args) {
        try {
          return await project(args).apply({ dryRun: Boolean(args.dryRun) })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_verify',
      description:
        '按契约执行全套验收：源基线未漂移、契约封印一致、覆盖完整、接受格有两个一致通道、证据齐备、' +
        'curated 表与比对结果一致、落表留痕完整、接受比例达标、待裁定归零，并可执行契约声明的 verifyCmd。' +
        '任一硬性检查失败即 FAIL；仅剩待裁定为 CONDITIONAL。',
      parameters: {
        cwd: str('项目根目录（绝对路径）'),
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(verifyLines(v).join('\n'))),
      async execute(args) {
        try {
          return await project(args).verify()
        } catch (e) {
          return { ok: false, status: 'FAIL', error: e.message, checks: [] }
        }
      },
    }),

    defineTool({
      name: 'curation_status',
      description: '只读汇总：源基线、契约、项目导出器、各通道提交量、比对统计、curated 表与最近一次落表。不改状态。',
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
        stateDir: optStr('状态目录，默认 .curation'),
      },
      output: output((args, v) => text(v.ok
        ? `已导出 ${v.rows} 行 × ${v.columns} 列 → ${v.path}（${v.format}，${v.kind}）`
        : fail(v))),
      async execute(args) {
        try {
          return await project(args).export({ format: args.format || 'csv', out: args.out })
        } catch (e) {
          return { ok: false, error: e.message }
        }
      },
    }),

    defineTool({
      name: 'curation_exporter',
      description:
        '管理项目导出器（存在工作区数据库里，可随时增删，不需要重签契约）。' +
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
        '把整个项目打成一个 zip：工作区快照（VACUUM INTO）、契约、源基线、项目导出器，以及导出器/verifyCmd 引用的外部脚本。' +
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
          `大小 ${v.bytes} 字节；契约 ${v.contractHash ?? '未冻结'}；源基线 ${v.sourceManifestSha ?? '无'}`,
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
  ]

  for (const tool of tools) ctx.tools.register(tool)
  return tools.length
}

export { listExporters }
