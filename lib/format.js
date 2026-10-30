// lib/format.js — human-readable renderers shared by tools and commands.

const deliveryLabel = (d) => (d && d.table ? String(d.table) : '未设置')

// 工具在异常路径返回 { ok:false, error }，渲染器必须先接住，否则会去读不存在的字段。
const failure = (v) => (v && v.ok === false ? [`✗ ${v.error ?? '操作失败'}`] : null)

const exportersLine = (e) => {
  if (!e) return null
  const builtins = (e.builtins ?? []).map((x) => x.name)
  const project = (e.project ?? []).map((x) => x.name)
  const parts = [`内置 ${builtins.join('/') || '无'}`]
  parts.push(project.length ? `项目 ${project.join('/')}` : '项目 无')
  return `导出器：${parts.join('；')}`
}

export function statusLines(v) {
  const failed = failure(v)
  if (failed) return failed
  const lines = [`状态目录：${v.stateDir}`, `工作区：${v.workspace}`]
  lines.push(v.manifest
    ? `源基线：${v.manifest.files} 个文件，sha256=${v.manifest.sha256.slice(0, 16)}…（${v.manifest.createdAt}）`
    : '源基线：未建立')
  lines.push(v.contract
    ? `契约：v${v.contract.version ?? '?'} ${String(v.contract.hash ?? '').slice(0, 12)}… / ${v.contract.fields} 字段 / 通道 ${v.contract.channels.join(',')} / 交付表 ${deliveryLabel(v.contract.delivery)}`
    : '契约：未冻结')
  const exporterLine = exportersLine(v.exporters)
  if (exporterLine) lines.push(exporterLine)
  const policy = v.contract?.adjudication
  if (policy) {
    const name = (spec, fallback) => (spec?.command ? 'command' : (spec?.builtin ?? fallback))
    const overrides = Object.keys(policy.fields ?? {})
    lines.push(`判定策略：compare=${name(policy.compare, 'exact')}，select=${name(policy.select, 'first-valid')}`
      + (overrides.length ? `（字段覆盖 ${overrides.join(',')}）` : ''))
  }
  const chans = v.channels ?? []
  lines.push(chans.length
    ? `提交：${chans.map((s) => `${s.channel}=${s.submissions}批（最近 ${s.lastAt ?? '—'}）`).join('，')}`
    : '提交：无')
  const synthesized = v.decisions.synthesized > 0 ? `（其中合成值 ${v.decisions.synthesized} 格）` : ''
  lines.push(`比对：共 ${v.decisions.total} 格，接受 ${v.decisions.accepted}${synthesized}，待裁定 ${v.decisions.pending}`)
  const reasons = Object.entries(v.decisions.byReason ?? {})
  if (reasons.length) lines.push(`待裁定原因：${reasons.map(([k, n]) => `${k}=${n}`).join('，')}`)
  if (v.delivery) {
    const size = v.delivery.rows == null ? '尚未生成' : `${v.delivery.rows} 行 / ${v.delivery.columns} 列`
    lines.push(`交付表：${deliveryLabel(v.delivery)}（工作区内，${size}）`)
  }
  lines.push(v.applied
    ? `最近落表：${v.applied.applied_at} 写入 ${v.applied.ops} 格${v.applied.backup ? '（已备份）' : ''}`
    : '最近落表：无')
  if (v.pendingFile) lines.push(`待裁定清单：${v.pendingFile}`)
  return lines
}

export function verifyLines(v) {
  // doVerify 对 FAIL / CONDITIONAL 返回 ok:false（但带 checks/status）——
  // 那是正常的验收结论，不能当成「操作失败」渲染掉。
  if (!Array.isArray(v?.checks) && !v?.status) {
    const failed = failure(v)
    if (failed) return failed
  }
  const lines = [`验收结果：${v.status}`]
  for (const c of v.checks ?? []) {
    const mark = c.status === 'pass' ? '✓' : c.status === 'conditional' ? '!' : '✗'
    lines.push(`${mark} ${c.name}: ${c.detail}`)
  }
  if (v.verifyCmd) {
    lines.push(`verifyCmd: ${v.verifyCmd.cmd} → exit ${v.verifyCmd.exitCode}`)
    const out = (v.verifyCmd.stderr || v.verifyCmd.stdout || '').trim()
    if (out) lines.push(out.slice(-800))
  }
  const reasons = Object.entries(v.pendingByReason ?? {})
  if (reasons.length) lines.push(`待裁定原因：${reasons.map(([k, n]) => `${k}=${n}`).join('，')}`)
  if (v.problems?.length) lines.push(`阻断：${v.problems.join('；')}`)
  return lines
}

// —— 查询渲染 ————————————————————————————————————————————————
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
const textWidth = (value) => [...String(value ?? '')].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)
const pad = (value, width) => String(value ?? '') + ' '.repeat(Math.max(0, width - textWidth(value)))
const cellText = (value) => (Array.isArray(value) ? value.join(',') : value == null ? '' : String(value))

function tableLines(header, rows) {
  const widths = header.map((h, i) => Math.max(textWidth(h), ...rows.map((r) => textWidth(cellText(r[i])))))
  const line = (cells) => cells.map((c, i) => pad(cellText(c), widths[i])).join('  ').trimEnd()
  return [line(header), ...rows.map(line)]
}

/** Render a `curation_query` result (`v.data`, `v.what`). */
export function queryLines(v, { format = 'table' } = {}) {
  const failed = failure(v)
  if (failed) return failed
  if (format === 'json') return [JSON.stringify(v.data, null, 2)]
  const data = v.data
  switch (v.what) {
    case 'counts': {
      const d = data.decisions
      const lines = [`结论：接受 ${d.accepted} / 待裁定 ${d.pending}（共 ${d.total} 格）`]
      const reasons = Object.entries(d.byReason ?? {})
      if (reasons.length) lines.push(`待裁定原因：${reasons.map(([k, n]) => `${k}=${n}`).join('，')}`)
      if (d.byField?.length) {
        lines.push('按字段：', ...tableLines(['字段', '接受', '待裁定'], d.byField.map((f) => [f.field, f.accepted, f.pending])))
      }
      if (data.submissions?.length) {
        lines.push('提交：', ...tableLines(['通道', '批数', '记录数'], data.submissions.map((s) => [s.channel, s.batches, s.records])))
      }
      lines.push(`运行：${data.runs?.total ?? 0} 次${data.runs?.lastAt ? `（最近 ${data.runs.lastAt}）` : ''}`)
      lines.push(data.applied
        ? `落表：写入 ${data.applied.ops} 格（${data.applied.appliedAt}）`
        : '落表：尚未落表')
      return lines
    }
    case 'pending': {
      if (!data.length) return ['（没有待裁定格）']
      return tableLines(['记录', '字段', '原因', '通道原值'], data.map((r) => [r.record, r.field, r.reason, r.channels]))
    }
    case 'cells': {
      if (!data.length) return ['（没有匹配的格）']
      const rows = data.map((r) => [r.record, r.field, r.status, r.value ?? '', r.synthesized ? '合成' : r.adopted.map((a) => a.channel ?? a).join(',')])
      return tableLines(['记录', '字段', '状态', '值', '来源'], rows)
    }
    case 'votes': {
      if (!data.found) return [`${data.record}.${data.field}：没有比对记录`]
      const lines = [`${data.record}.${data.field} → ${data.status}${data.reason ? `（${data.reason}）` : ''}`]
      for (const vote of data.votes) {
        const ok = vote.valid && vote.present
        lines.push(`${ok ? '✓' : '✗'} ${vote.channel}: ${vote.raw === '' ? '（空）' : vote.raw}${vote.evidence?.page ? ` [p${vote.evidence.page}]` : ''}`)
      }
      return lines
    }
    case 'submissions': {
      if (!data.length) return ['（没有提交）']
      return tableLines(['id', '通道', '批次', '记录', '状态', '字段数', '时间'],
        data.map((r) => [r.id, r.channel, r.batch, r.record, r.status, r.fields, r.submittedAt]))
    }
    case 'runs': {
      if (!data.length) return ['（没有比对运行）']
      return tableLines(['运行', '类型', '时间', '摘要'],
        data.map((r) => [r.runId, r.kind, r.createdAt, r.summary ? JSON.stringify(r.summary) : '']))
    }
    case 'schema': {
      if (!data.length) return ['（没有表）']
      return tableLines(['表', '行数', '列'],
        data.map((r) => [r.table, r.rows, r.columns.map((c) => c.name).join(',')]))
    }
    default:
      return [JSON.stringify(data, null, 2)]
  }
}
