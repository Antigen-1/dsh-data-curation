# Chez GC statistics spike (10.4.1 Wasm)

Status: completed spike, no production change.

## Why

The 0.22.0 final soak used post-`(collect)` OS RSS as a live-heap proxy. That
mixes Scheme live data, V8/Chez allocator behavior, and Wasm pages that are not
returned to the OS. The final4 run failed that criterion without proving a
Scheme leak. We need a Chez-level signal.

## Probe

Temporary probes in `experiments/gc-stats-spike/` used the production
`CvmClient`, production engine, and `(chezscheme)` only in the probe guest.

Engine artifact:
`sha256:8ec8aa06a20f2c0a3ea512ac39a9f1f787eca75d68dfe0481dadd040029f8c4b`

Environment: Node v24.21.0, win32-x64.

## Results

`statistics` returns a `sstats` record with fields:

```text
#(cpu real bytes gc-count gc-cpu gc-real gc-bytes)
```

Bound numeric probes:

- `bytes-allocated`
- `bytes-deallocated`
- `current-memory-bytes`

Not bound: `heap-bytes`, `memory-bytes`, `gc-count`, `gc-time`, `heap-size`,
`live-bytes`.

Known-live-object experiment: retain an 8 MB vector, collect, then drop it.

```text
baseline:       bytes-allocated 16,212,224  current-memory 24,347,256
after-alloc:    bytes-allocated 24,216,064  current-memory 32,438,064
after-drop:     bytes-allocated 16,196,960  current-memory 24,347,256
baseline-2:     bytes-allocated 16,197,248  current-memory 24,347,256
```

`bytes-allocated` moved by +8,003,840 bytes while the vector was live and
returned to baseline after the drop, after a forced `(collect)`. It is the
usable live-bytes signal. `current-memory-bytes` is reserved/committed heap,
not live bytes. `bytes-deallocated` and `statistics.gc-bytes` describe the most
recent collection. `statistics.bytes` is an interval allocation counter.

## Decision

- Use post-GC `bytes-allocated` as `liveBytes` for 0.22.1 diagnostics.
- Keep RSS/Wasm bytes as hard-limit and context metrics, not leak criteria.
- Add a `pin-gc-stats` diagnostic operation rather than forcing GC on every
  request.
- Replace the old criterion 4 with a live-bytes trend and baseline tolerance.
- Keep final4 as a failed run under its original criteria; a new 0.22.1 run is
  required.

Full raw notes: `experiments/gc-stats-spike/RESULTS.md` (untracked).
