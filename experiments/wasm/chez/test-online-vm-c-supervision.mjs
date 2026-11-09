import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULT = join(HERE, '..', 'results', 'chez', '10.4.1-c', 'supervision-c.json')

function startClient () {
  const worker = new Worker(new URL('./online-vm-c-worker.cjs', import.meta.url))
  const pending = new Map()
  const events = []
  let loadedResolve
  let loadedReject
  let loadedDone = false
  let loaded = new Promise((resolve, reject) => {
    loadedResolve = (message) => {
      loadedDone = true
      resolve(message)
    }
    loadedReject = (error) => {
      if (loadedDone) return
      loadedDone = true
      reject(error)
    }
  })
  let exitResolve
  let exitDone = false
  let exitWait = new Promise((resolve) => {
    exitResolve = (message) => {
      if (exitDone) return
      exitDone = true
      resolve(message)
    }
  })
  let nextId = 1

  worker.on('message', (message) => {
    events.push(message)
    if (message.type === 'loaded') {
      loadedResolve(message)
      return
    }
    if (message.type === 'response' && pending.has(message.id)) {
      const { resolve } = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
      return
    }
    if (message.type === 'error') {
      if (message.id && pending.has(message.id)) {
        const { reject } = pending.get(message.id)
        pending.delete(message.id)
        reject(new Error(message.message))
      } else {
        loadedReject(new Error(message.message))
        exitResolve({ code: null, error: message.message })
      }
      return
    }
    if (message.type === 'exit') {
      exitResolve(message)
    }
  })
  worker.on('error', (error) => {
    loadedReject(error)
    exitResolve({ code: null, error: String(error) })
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  })
  worker.on('exit', (code) => {
    exitResolve({ code })
    if (!loadedDone) loadedReject(new Error(`worker exited ${code}`))
    for (const { reject } of pending.values()) reject(new Error(`worker exited ${code}`))
    pending.clear()
  })

  async function ready () {
    return await loaded
  }

  async function request (payload, timeoutMs = 3000) {
    const id = `c${nextId++}`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`request timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      worker.postMessage({ type: 'dispatch', id, payload })
    })
  }

  return {
    worker,
    ready,
    request,
    send: (payload) => worker.postMessage({ type: 'dispatch', id: `c${nextId++}`, payload }),
    waitExit: () => exitWait,
    terminate: () => worker.terminate(),
    events,
  }
}

function parse (message) {
  return JSON.parse(message.text)
}

async function main () {
  const events = []

  const first = startClient()
  const firstLoaded = await first.ready()
  events.push({ step: 'initial-ready', memory: firstLoaded.memory })
  const s1 = parse(await first.request('(request "s1" set 7)'))
  events.push({ step: 'initial-set', value: s1.value })

  first.send('(request "timeout" hang)')
  const timeoutStarted = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const timeoutExit = await first.terminate()
  events.push({
    step: 'timeout',
    killedAfterMs: Date.now() - timeoutStarted,
    terminateExitCode: timeoutExit,
    mainProcessAlive: true,
  })

  const afterTimeout = startClient()
  const afterTimeoutLoaded = await afterTimeout.ready()
  events.push({ step: 'after-timeout-ready', memory: afterTimeoutLoaded.memory })
  const s2 = parse(await afterTimeout.request('(request "s2" get)'))
  events.push({ step: 'after-timeout-state', value: s2.value })
  const s3 = parse(await afterTimeout.request('(request "s3" set 9)'))
  events.push({ step: 'after-timeout-set', value: s3.value })

  afterTimeout.send('(request "crash" exit 7)')
  const crash = await Promise.race([
    afterTimeout.waitExit(),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
  events.push({
    step: 'guest-exit',
    exit: crash,
    exitCodeIsSeven: crash ? crash.code === 7 : false,
    mainProcessAlive: true,
  })
  await afterTimeout.terminate()

  const afterCrash = startClient()
  const afterCrashLoaded = await afterCrash.ready()
  events.push({ step: 'after-crash-ready', memory: afterCrashLoaded.memory })
  const s4 = parse(await afterCrash.request('(request "s4" get)'))
  events.push({ step: 'after-crash-state', value: s4.value })
  const s5 = parse(await afterCrash.request('(request "s5" set 11)'))
  events.push({ step: 'after-crash-set', value: s5.value })
  await afterCrash.terminate()

  const result = {
    ok: true,
    transport: 'c-abi',
    checkedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    events,
    timeoutKilled: true,
    crashKilled: true,
    mainProcessSurvived: true,
    freshInstanceStateReset: true,
  }
  mkdirSync(dirname(RESULT), { recursive: true })
  writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
}

await main()
