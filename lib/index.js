// lib/index.js — dsh-data-curation plugin entry.
import { registerCommands } from './commands.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'

export const name = 'dsh-data-curation'
export const inject = ['tools', 'skills', 'systemPrompt', 'commands']

const SECTION = `[数据核对模式 · dsh-data-curation]
- 任务涉及"从原始材料抽取字段并写入/核对交付表"（报表、病历、台账、清单）时先看技能 data-curation，不要直接批量改表。
- 项目 = 只读的原始材料 + 一个工作区 SQLite（.curation/project.sqlite）。契约、导出器、提交、比对、留痕、curated 交付表都在库里；导出文件/备份是可重建派生物。
- 顺序固定：curation_init（只读基线）→ curation_contract（冻结口径，可先 dryRun）→ curation_submit（每通道独立）→ curation_compare（接受/待裁定）→ curation_apply（工作区内按键落表）→ curation_verify（门禁）→ curation_export（按需导出）→ curation_pack（迁移/归档）。
- 只有"同一记录同一字段、两个有效通道归一化后一致"才算接受；单通道结果、通道分歧、"源材料明确未提供"以外的空白一律进待裁定，不得写入。
- 原始材料只读：任何 curation_* 报基线漂移时立即停止写入并报告，不得重建基线掩盖。
- PASS 之前不得宣称核对完成；数值与清单一律以工具输出为准，不凭记忆复述。`

export function normalizeStateDir(value) {
  if (typeof value !== 'string' || !value.trim()) return '.curation'
  const dir = value.trim().replace(/^\.\/+/, '')
  if (dir.includes('..') || dir.startsWith('/')) throw new Error(`stateDir 必须是项目内相对目录：${value}`)
  return dir
}

export async function apply(ctx, config = {}) {
  const stateDir = normalizeStateDir(config.stateDir)
  await registerSkills(ctx)
  await registerCommands(ctx, { stateDir })
  const toolCount = await registerTools(ctx, { stateDir })
  ctx.systemPrompt.section({ name: 'data-curation', order: 120, text: () => SECTION })
  if (ctx.logger?.info) ctx.logger.info(`[dsh-data-curation] ${toolCount} tools, stateDir=${stateDir}`)
}
