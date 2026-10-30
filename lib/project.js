// lib/project.js — the Project facade.
//
// A project pairs read-only sources with one workspace SQLite file. This object
// is the public programmatic surface: other plugins (and the tools) drive a
// project through these methods instead of reaching into files or SQL.
//
//   const project = openProject({ cwd: '/path/to/project' })
//   await project.init({ sources: ['raw/'] })
//   await project.pin(pin)
//   await project.submit({ channel: 'text', batch: 'B001', records })
//   await project.compare()
//   await project.apply()
//   await project.export({ format: 'csv' })
//   await project.verify()
//
// Register extra export formats with registerExporter() from lib/exporters.js.
import { join } from 'node:path'
import { createStore } from './store.js'
import {
  coveragePreview, doApply, doCompare, doExport, doExporter, doInit, doPack,
  doNote, doPin, doQuery, doStatus, doSubmit, doVerify, loadGates,
} from './core.js'

/**
 * Open a curation project rooted at `cwd`.
 * @param {{cwd?:string, stateDir?:string}} [options]
 */
export function openProject({ cwd = process.cwd(), stateDir = '.curation' } = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('openProject 需要 cwd')
  const store = createStore(cwd, stateDir)

  const api = {
    cwd,
    stateDir,
    store,
    paths: Object.freeze({
      dir: store.dir,
      workspace: store.dbPath,
      manifest: store.manifestPath,
      seal: store.sealPath,
      pinMirror: store.pinMirrorPath,
      pending: store.pendingPath,
      backups: store.backupsDir,
      packs: store.packsDir,
      exports: join(store.dir, 'exports'),
    }),

    /** Freeze the source baseline (sha256 of every read-only source file). */
    init: (options = {}) => doInit({ cwd, stateDir, ...options }),

    /** Sign (or, with dryRun, only validate) the aggregate pin. */
    pin: (pin, options = {}) => doPin({ cwd, stateDir, pin, ...options }),

    /** Validate a pin without writing anything. */
    validatePin: (pin) => doPin({ cwd, stateDir, pin, dryRun: true }),

    /** Store one channel's submission. */
    submit: (options = {}) => doSubmit({ cwd, stateDir, ...options }),

    /** Compare channels cell by cell and record decisions. */
    compare: (options = {}) => doCompare({ cwd, stateDir, ...options }),

    /** Write accepted cells into the curated table (dryRun supported). */
    apply: (options = {}) => doApply({ cwd, stateDir, ...options }),

    /** Append a free-form note to the project or one table. */
    note: (options = {}) => doNote({ cwd, stateDir, ...options }),

    /** Export one curated table through a registered or project exporter. */
    export: (options = {}) => doExport({ cwd, stateDir, ...options }),

    /** Manage project exporters: {action: 'list'|'add'|'remove', name?, command?, args?}. */
    exporter: (options = {}) => doExporter({ cwd, stateDir, ...options }),

    /** Package the project (workspace snapshot + pin + referenced scripts). */
    pack: (options = {}) => doPack({ cwd, stateDir, ...options }),

    /** Full acceptance run for one table (multi-table projects need `table`). */
    verify: (options = {}) => doVerify({ cwd, stateDir, ...options }),

    /** Read-only project summary. */
    status: () => doStatus({ cwd, stateDir }),

    /** Read-only query over the workspace: {what: 'counts'|'pending'|'cells'|'votes'|'submissions'|'runs'|'schema', ...filters}. */
    query: (options = {}) => doQuery({ cwd, stateDir, ...options }),

    /** What the next compare would cover (no writes). */
    coverage: (table) => coveragePreview(cwd, stateDir, table),

    /** Blocking gate problems, if any. */
    gates: () => loadGates(store),
  }
  return api
}
