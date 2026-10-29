// lib/skills.js — register the data-curation skill family.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'assets', 'skills')

export const SKILL_FAMILY = [
  {
    name: 'data-curation',
    dir: 'data-curation',
    description:
      '需要从原始材料（报告、台账、表格、扫描件）抽取字段并写入/核对交付表时使用：建立只读基线、冻结口径契约、' +
      '多通道独立采集、按"同记录同字段两通道一致"裁定、按键落表留痕、验收门禁。领域无关，字段口径由项目契约提供。',
  },
  {
    name: 'data-curation-contract',
    dir: 'data-curation-contract',
    description:
      '为数据核对项目编写口径契约（字段定义、证据要求、归一化白名单、通道、交付表、验收门槛）时使用；' +
      '含字段口径纪律与常见混淆清单，避免把"看起来一样"的东西当成同一个值。',
  },
  {
    name: 'data-curation-audit',
    dir: 'data-curation-audit',
    description:
      '审阅已生成的数据核对结果、处置待裁定清单、搭建回归与故障注入夹具时使用；' +
      '含"不得批量改表""例外必须人批准""验收不过不得宣称完成"的处置流程。',
  },
]

async function buildContent(dir) {
  const body = await readFile(join(dir, 'SKILL.md'), 'utf8')
  let refs = []
  try {
    refs = (await readdir(join(dir, 'references'))).filter((f) => f.endsWith('.md')).sort()
  } catch {
    refs = []
  }
  if (!refs.length) return body
  const list = refs.map((r) => `- ${join(dir, 'references', r)}`).join('\n')
  return `${body}\n\n## 参考文件（需要细节时用 read 打开）\n${list}\n`
}

export async function registerSkills(ctx) {
  let count = 0
  for (const spec of SKILL_FAMILY) {
    const dir = join(ASSETS, spec.dir)
    const content = await buildContent(dir)
    ctx.skills.register({ name: spec.name, description: spec.description, content, source: 'dsh-data-curation' })
    count += 1
  }
  return count
}
