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
  const failed = failure(v)
  if (failed) return failed
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
  if (v.problems?.length) lines.push(`阻断：${v.problems.join('；')}`)
  return lines
}
