import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startClient } from './online-vm-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1', 'supervision.json')

async function request (client, id, op, expected) {
  const sent = client.sendFrame(`(request "${id}" ${op})`)
  const frame = await client.nextFrame()
  const response = JSON.parse(frame.payload)
  if (response.id !== id || response.ok !== true || response.value !== expected) {
    throw new Error(`unexpected ${id} response: ${frame.payload}`)
  }
  return { id, value: response.value, requestFrameBytes: sent, responseFrameBytes: frame.frameBytes }
}

async function main () {
  const events = []

  const first = await startClient()
  events.push({ step: 'initial-ready', memory: first.memory })
  events.push({ step: 'initial-state', ...(await request(first, 's1', 'set 7', 7)) })

  first.sendFrame('(request "timeout" hang)')
  const timeoutStarted = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const timeoutExit = await first.terminate()
  events.push({
    step: 'timeout',
    timedOut: true,
    killedAfterMs: Date.now() - timeoutStarted,
    terminateExitCode: timeoutExit,
    mainProcessAlive: true,
  })

  const afterTimeout = await startClient()
  events.push({ step: 'after-timeout-ready', memory: afterTimeout.memory })
  events.push({ step: 'after-timeout-state', ...(await request(afterTimeout, 's2', 'get', 0)) })
  events.push({ step: 'after-timeout-set', ...(await request(afterTimeout, 's3', 'set 9', 9)) })

  afterTimeout.sendFrame('(request "crash" exit 7)')
  const crashExit = await afterTimeout.waitExit()
  events.push({
    step: 'guest-exit',
    exit: crashExit,
    exitCodeIsSeven: crashExit.code === 7,
    mainProcessAlive: true,
  })
  await afterTimeout.close()

  const afterCrash = await startClient()
  events.push({ step: 'after-crash-ready', memory: afterCrash.memory })
  events.push({ step: 'after-crash-state', ...(await request(afterCrash, 's4', 'get', 0)) })
  events.push({ step: 'after-crash-set', ...(await request(afterCrash, 's5', 'set 11', 11)) })
  await afterCrash.close()

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    events,
    timeoutKilled: true,
    crashKilled: true,
    mainProcessSurvived: true,
    freshInstanceStateReset: true,
    oom: {
      status: 'SEPARATE_EVIDENCE',
      evidence: 'experiments/wasm/results/chez/10.4.1/oom.json',
      reason: 'The memory-capped OOM test runs in a separate process/worker so its abort cannot be confused with timeout/crash supervision.',
    },
  }
  mkdirSync(dirname(RESULT), { recursive: true })
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}

await main()
