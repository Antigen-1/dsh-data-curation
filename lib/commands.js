// lib/commands.js — deterministic slash commands (no model turn required).
import { doStatus, doVerify } from './core.js'
import { statusLines, verifyLines } from './format.js'

export const HELP = `数据核对模式（dsh-data-curation）

一个项目 = 只读的原始材料 + 一个可写的工作区 SQLite（.curation/project.sqlite，要求 Node >= 24）：
  契约、导出器、提交、比对、留痕、curated 交付表全在库里；导出文件与备份是可重建的派生物。

阶段顺序（不可跳步）：
  0 基线    curation_init        记录源文件校验和，源材料自此只读
  1 契约    curation_contract    字段/证据/通道/交付表/验收门槛；dryRun 可先校验
  2 采集    curation_submit      每个通道独立提交，禁止合并通道结果
  3 比对    curation_compare     同记录同字段 ≥2 个有效通道一致才接受，其余进待裁定
  4 落表    curation_apply       工作区内 curated 表：按键定位、VACUUM INTO 备份、单事务写入+回读
  5 验收    curation_verify      基线/契约/覆盖/双通道/证据/一致性/留痕/比例/待裁定
  6 导出    curation_export      内置 csv/jsonl/markdown/sqlite；更多用 curation_exporter 注册
  7 打包    curation_pack        工作区快照 + 契约 + 导出器 + 引用到的外部脚本，打成一个 zip
  8 报告    curation_status      只读汇总与未决清单

命令：/curation（本页） · /curation-status · /curation-verify
硬约束：原始数据只读；不按行号改表；待裁定不自动改表；单通道不得自动接受。`

function cwdOf(invocation) {
  return invocation?.agent?.session?.header?.cwd ?? process.cwd()
}

export async function registerCommands(ctx, { stateDir }) {
  ctx.commands.register({
    name: 'curation',
    description: '数据核对模式的阶段说明与当前状态',
    async handler(invocation) {
      const cwd = cwdOf(invocation)
      let tail = ''
      try {
        const status = await doStatus({ cwd, stateDir })
        tail = status.ok ? '\n\n当前状态：\n' + statusLines(status).join('\n') : '\n\n当前项目尚未建立基线。'
      } catch (e) {
        tail = `\n\n状态读取失败：${e.message}`
      }
      return { kind: 'success', text: HELP + tail }
    },
  })

  ctx.commands.register({
    name: 'curation-status',
    description: '数据核对项目状态汇总（只读）',
    async handler(invocation) {
      const cwd = cwdOf(invocation)
      try {
        const status = await doStatus({ cwd, stateDir })
        return { kind: 'success', text: statusLines(status).join('\n') }
      } catch (e) {
        return { kind: 'success', text: `状态读取失败：${e.message}` }
      }
    },
  })

  ctx.commands.register({
    name: 'curation-verify',
    description: '执行数据核对验收（确定性与命令结果）',
    async handler(invocation) {
      const cwd = cwdOf(invocation)
      try {
        const result = await doVerify({ cwd, stateDir })
        return { kind: 'success', text: verifyLines(result).join('\n') }
      } catch (e) {
        return { kind: 'success', text: `验收失败：${e.message}` }
      }
    },
  })
}
