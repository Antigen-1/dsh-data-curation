/**
 * dsh-data-curation — client half: the progress dock above the composer.
 *
 * Hand-written CJS bundle in the `window.__ModuleLoader__` shape used by the
 * harness web client (no build step, one `react` import). The bundle only
 * registers; rendering happens when the dock materializes.
 *
 * The dock is a pure view over the host projection `curation-progress`
 * (lib/progress.js): it renders whatever bars are in the document and never
 * writes. Empty document = no row at all, so the composer keeps its height
 * until a task asks for a bar.
 */
window.__ModuleLoader__.load({
  id: 'dsh-data-curation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var KEY = 'curation-progress'
    var MAX_VISIBLE = 6
    var STATUS_COLOR = {
      running: 'var(--dsw-color-accent, #2f6feb)',
      paused: 'var(--dsw-color-warning, #d97706)',
      done: 'var(--dsw-color-success, #16a34a)',
      error: 'var(--dsw-color-danger, #dc2626)',
      idle: 'var(--dsw-color-text-3, #9ca3af)',
    }

    function clamp(value) {
      return Math.min(100, Math.max(0, value))
    }

    /** Percentage text for the track: two decimals at most, so 14/25 renders `56%`, not `56.00000000000001%`. */
    function widthOf(percent) {
      return String(Math.round(percent * 100) / 100) + '%'
    }

    /** Percent for one bar: explicit `percent` wins, then `value/total`, else null (indeterminate). */
    function percentOf(bar) {
      if (typeof bar.percent === 'number' && Number.isFinite(bar.percent)) return clamp(bar.percent)
      if (typeof bar.total === 'number' && bar.total > 0 && typeof bar.value === 'number' && Number.isFinite(bar.value)) {
        return clamp((bar.value / bar.total) * 100)
      }
      return null
    }

    /** Right-aligned readout: percentage plus unit-formatted amount when both halves exist. */
    function readoutOf(bar, percent) {
      var amount = ''
      if (typeof bar.value === 'number' && typeof bar.total === 'number') {
        amount = bar.value + '/' + bar.total + (bar.unit ? ' ' + bar.unit : '')
      } else if (typeof bar.value === 'number') {
        amount = bar.value + (bar.unit ? ' ' + bar.unit : '')
      }
      if (percent === null) return amount || '…'
      var pct = Math.round(percent) + '%'
      return amount ? pct + ' · ' + amount : pct
    }

    function ProgressRow(props) {
      var bar = props.bar
      var percent = percentOf(bar)
      var color = STATUS_COLOR[bar.status] || STATUS_COLOR.running
      var a11y = percent === null
        ? { role: 'status' }
        : { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent), 'aria-label': bar.label || bar.id }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }, ...a11y },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            color: 'var(--dsw-color-text-2, #6b7280)',
            fontSize: 12,
            lineHeight: 1.3,
          },
        },
          h('span', {
            title: bar.detail || bar.label || bar.id,
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
          }, bar.label || bar.id),
          h('span', { style: { flex: 'none', fontVariantNumeric: 'tabular-nums' } }, readoutOf(bar, percent)),
        ),
        h('div', {
          style: {
            height: 6,
            borderRadius: 999,
            background: 'var(--dsw-color-fill-2, rgba(127,127,127,0.18))',
            overflow: 'hidden',
          },
        },
          h('div', {
            style: {
              height: '100%',
              width: percent === null ? '35%' : widthOf(percent),
              opacity: percent === null ? 0.5 : 1,
              borderRadius: 999,
              background: color,
              transition: 'width 240ms ease',
            },
          }),
        ),
      )
    }

    /**
     * Dock entry. `useProjection` is injected by the slot renderer; it returns
     * the current `curation-progress` document (undefined before the first fold).
     */
    function ProgressDock(props) {
      var useProjection = props && props.useProjection
      var state = typeof useProjection === 'function' ? useProjection(KEY) : undefined
      var bars = state && Array.isArray(state.bars) ? state.bars : []
      if (bars.length === 0) return null
      var visible = bars.slice(0, MAX_VISIBLE)
      var hidden = bars.length - visible.length
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '0 2px 8px',
        },
      },
        visible.map((bar) => h(ProgressRow, { key: bar.id, bar: bar })),
        hidden > 0
          ? h('div', { style: { fontSize: 11, color: 'var(--dsw-color-text-3, #9ca3af)' } }, '… 另有 ' + hidden + ' 条进度')
          : null,
      )
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
        if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-data-curation] slots 服务缺失，进度条未注册')
        return
      }
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'curation-progress', order: 40 }, ProgressDock))
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.ProgressDock = ProgressDock
    exports.ProgressRow = ProgressRow
    exports.percentOf = percentOf
    return module.exports
  },
})
