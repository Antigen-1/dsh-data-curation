import assert from 'node:assert/strict'
import test from 'node:test'

// The client half is a hand-written `window.__ModuleLoader__` bundle, so the
// test stands in for the web client: capture the definition, run its factory
// with a React stub, then drive the two things the host actually calls
// (`exports.apply` at load time, the registered component at render time).
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

await import('../lib/client.js')

function loadBundle() {
  assert.ok(definition, 'bundle 通过 window.__ModuleLoader__.load 注册')
  assert.equal(definition.id, 'dsh-data-curation')
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
  }
  return definition.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
}

/** Resolve function components the way React would, so assertions see DOM nodes. */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  return { ...node, children: (node.children || []).map(resolve) }
}

function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  collect(node.children, predicate, found)
  return found
}

function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  texts(node.children, out)
  return out
}

test('bundle 暴露 apply / inject，并把 dock 条目注册到 conversation.input.dock', () => {
  const bundle = loadBundle()
  assert.equal(bundle.inject.length, 1)
  assert.equal(bundle.inject[0], 'slots')
  assert.equal(typeof bundle.apply, 'function')

  const calls = []
  const ctx = {
    slots: {
      inject(name, callback) {
        calls.push(['inject', name])
        callback()
      },
      register(def, component) {
        calls.push(['register', def, component])
        return def
      },
    },
  }
  bundle.apply(ctx)
  assert.deepEqual(calls[0], ['inject', 'conversation.input.dock'])
  const [, def, component] = calls[1]
  assert.equal(def.name, 'conversation.input.dock')
  assert.equal(def.id, 'curation-progress')
  assert.equal(def.order, 40)
  assert.equal(component, bundle.ProgressDock)
})

test('apply 在没有 slots 服务时只告警不抛', () => {
  const bundle = loadBundle()
  bundle.apply({})
  bundle.apply(undefined)
})

test('ProgressDock 空文档不渲染任何节点', () => {
  const bundle = loadBundle()
  assert.equal(bundle.ProgressDock({ useProjection: () => undefined }), null)
  assert.equal(bundle.ProgressDock({ useProjection: () => ({ bars: [] }) }), null)
  assert.equal(bundle.ProgressDock({}), null)
})

test('ProgressDock 读取 curation-progress 投影并渲染百分比与计数', () => {
  const bundle = loadBundle()
  let asked = null
  const state = {
    bars: [
      { id: 'batch-1', label: '第一批', value: 14, total: 25, unit: '例', status: 'running' },
      { id: 'batch-2', label: '第二批', percent: 100, status: 'done' },
    ],
  }
  const tree = resolve(bundle.ProgressDock({ useProjection: (key) => { asked = key; return state } }))
  assert.equal(asked, 'curation-progress')

  const rows = collect(tree, (node) => node.props.role === 'progressbar')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].props['aria-valuenow'], 56)

  const firstText = texts(rows[0]).join(' ')
  assert.match(firstText, /第一批/)
  assert.match(firstText, /56%/)
  assert.match(firstText, /14\/25 例/)

  const track = collect(rows[0], (node) => node.props.style?.width === '56%')
  assert.equal(track.length, 1)
})

test('进度条缺 value/total/percent 时按不确定态渲染', () => {
  const bundle = loadBundle()
  const tree = resolve(bundle.ProgressDock({ useProjection: () => ({ bars: [{ id: 'x', status: 'running' }] }) }))
  const rows = collect(tree, (node) => node.props.role === 'status')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].props['aria-valuenow'], undefined)
  assert.equal(collect(rows[0], (node) => node.props.style?.width === '35%').length, 1)
  assert.equal(bundle.percentOf({ id: 'x' }), null)
  assert.equal(bundle.percentOf({ value: 1, total: 0 }), null)
  assert.equal(bundle.percentOf({ value: 3, total: 4 }), 75)
  assert.equal(bundle.percentOf({ percent: 140 }), 100)
})

test('超过 6 条时只渲染前 6 条并提示剩余数量', () => {
  const bundle = loadBundle()
  const bars = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, label: `条目 ${i}`, status: 'running' }))
  const tree = resolve(bundle.ProgressDock({ useProjection: () => ({ bars }) }))
  assert.equal(collect(tree, (node) => node.props.role).length, 6)
  assert.match(texts(tree).join(' '), /另有 3 条进度/)
})
