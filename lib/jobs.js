// lib/jobs.js — resumable, chunked submission imports.
//
// These are foreground jobs: one tool call advances the job in chunks and
// writes a checkpoint after every chunk. A crash leaves the job file behind and
// `curation_job({action:"resume"})` continues from the last committed chunk.
// They are not daemon processes; the next call drives them again.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createStore } from './store.js'
import { loadSubmissionRows } from './intake.js'
import { doSubmit } from './core.js'
import { atomicWrite, ensureDir, newRunId, nowIso, toPosix } from './util.js'

const DEFAULT_CHUNK = 200
const MAX_FAILED = 50

const jobIdOf = () => `job-${newRunId().replace(/^run-/, '')}`
const jobPath = (store, id) => join(store.dir, 'jobs', `${id}.json`)
const summaryOf = (job) => ({
  jobId: job.jobId,
  kind: job.kind,
  status: job.status,
  table: job.table,
  channel: job.channel,
  batch: job.batch,
  from: job.from,
  total: job.total,
  offset: job.offset,
  submitted: job.submitted,
  failed: job.failed,
  chunkSize: job.chunkSize,
  errors: job.errors.slice(0, 20),
  startedAt: job.startedAt,
  updatedAt: job.updatedAt,
})

async function writeJob(store, job) {
  await ensureDir(join(store.dir, 'jobs'))
  job.updatedAt = nowIso()
  await atomicWrite(jobPath(store, job.jobId), `${JSON.stringify(job, null, 2)}\n`)
}

async function readJob(store, jobId) {
  if (!jobId) throw new Error('jobId 必填')
  const text = await fs.readFile(jobPath(store, jobId), 'utf8')
  return JSON.parse(text)
}

async function runChunks(store, job, records) {
  const maxFailed = Number(job.maxFailed) || MAX_FAILED
  while (job.offset < job.total) {
    const chunk = records.slice(job.offset, job.offset + job.chunkSize)
    if (!chunk.length) break
    const index = Math.floor(job.offset / job.chunkSize) + 1
    const result = await doSubmit({
      cwd: store.cwd,
      stateDir: store.stateDir,
      channel: job.channel,
      batch: `${job.batch}-c${String(index).padStart(3, '0')}`,
      table: job.table,
      records: chunk,
    })
    if (result.ok) {
      job.submitted += chunk.length
    } else {
      job.failed += chunk.length
      job.errors.push({ offset: job.offset, error: result.error ?? '提交失败', errors: result.errors?.slice?.(0, 5) ?? [] })
    }
    job.offset += chunk.length
    job.status = job.offset >= job.total
      ? (job.failed === 0 ? 'completed' : job.submitted === 0 ? 'failed' : 'partial')
      : job.failed >= maxFailed ? 'failed' : 'running'
    await writeJob(store, job)
    if (job.status === 'failed') break
  }
  return job
}

export async function doJob({
  cwd, stateDir = '.curation', action, jobId = null, from = null, channel = null, batch = null,
  table = null, key = 'record_id', chunkSize = DEFAULT_CHUNK,
} = {}) {
  const store = createStore(cwd, stateDir)
  try {
    if (action === 'list') {
      const dir = join(store.dir, 'jobs')
      const files = await fs.readdir(dir).catch(() => [])
      const jobs = []
      for (const file of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
        try { jobs.push(summaryOf(JSON.parse(await fs.readFile(join(dir, file), 'utf8')))) } catch { /* skip broken job */ }
      }
      return { ok: true, jobs }
    }
    if (action === 'status') {
      return { ok: true, job: summaryOf(await readJob(store, jobId)) }
    }
    if (action === 'cancel') {
      const job = await readJob(store, jobId)
      if (['completed', 'failed'].includes(job.status)) return { ok: false, error: `作业已结束（${job.status}），无需取消` }
      job.status = 'cancelled'
      await writeJob(store, job)
      return { ok: true, job: summaryOf(job) }
    }
    if (action === 'resume') {
      const job = await readJob(store, jobId)
      if (['completed', 'partial'].includes(job.status)) return { ok: false, error: `作业已结束（${job.status}），无剩余记录可续跑` }
      if (job.status === 'cancelled') return { ok: false, error: '作业已取消；重新开始请用 action:start' }
      const loaded = await loadSubmissionRows(cwd, job.from, { key: job.key })
      if (!loaded.ok) return loaded
      if (loaded.records.length !== job.total) {
        return { ok: false, error: `源文件记录数变化（${job.total} → ${loaded.records.length}）；请重新 start` }
      }
      job.status = 'running'
      await writeJob(store, job)
      const done = await runChunks(store, job, loaded.records)
      return { ok: true, job: summaryOf(done) }
    }
    if (action !== 'start') return { ok: false, error: `未知 action：${action}（start/status/list/resume/cancel）` }
    if (!from) return { ok: false, error: 'start 需要 from（提交文件或目录）' }
    if (!channel) return { ok: false, error: 'start 需要 channel' }
    if (!batch) return { ok: false, error: 'start 需要 batch' }
    const loaded = await loadSubmissionRows(cwd, from, { key })
    if (!loaded.ok) return loaded
    const seen = new Set()
    const dup = new Set()
    for (const rec of loaded.records) {
      if (seen.has(rec.record_id)) dup.add(rec.record_id)
      seen.add(rec.record_id)
    }
    if (dup.size) return { ok: false, error: `提交文件中记录键重复：${[...dup].slice(0, 10).join(', ')}` }
    const size = Math.max(1, Math.min(Number(chunkSize) || DEFAULT_CHUNK, 5000))
    const job = {
      jobId: jobIdOf(),
      kind: 'submit-import',
      status: 'running',
      from,
      channel,
      batch,
      table,
      key,
      chunkSize: size,
      total: loaded.records.length,
      offset: 0,
      submitted: 0,
      failed: 0,
      maxFailed: MAX_FAILED,
      errors: [],
      startedAt: nowIso(),
      updatedAt: nowIso(),
    }
    await writeJob(store, job)
    const done = await runChunks(store, job, loaded.records)
    return { ok: true, job: summaryOf(done) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
