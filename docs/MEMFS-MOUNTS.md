# MEMFS directory mounts

`SchemeV2Runtime.open(pin, { mounts })` mounts host directories under fixed
guest paths. Scheme code reads and writes ordinary MEMFS paths; it never sees
the host path. The 0.24.0 capability (reads, Unix-like `rwx` permissions, and
MEMFS-only writes) is staged in the 0.25.0 candidate; `0.25.0` adds
`sync: "on-close"` to write changes back to the host. Neither is tagged yet.

## Shape

```js
const runtime = await SchemeV2Runtime.open(pin, {
  projectRoot: '/path/to/project',
  mounts: [
    {
      hostPath: 'data/incoming',      // relative to projectRoot, or absolute
      guestPath: '/mnt/incoming',     // must not overlap a reserved path
      mode: 'rwx',                    // default is r-x
      sync: 'on-close'                // optional; requires rwx
    }
  ]
})
```

Rules are `{hostPath, guestPath, mode, sync}`. `mode` is three characters:

| position | meaning |
| --- | --- |
| `r` | read files; required |
| `w` | create, write, rename, delete |
| `x` | traverse directories; required for file open and mkdir |

`r-x` is read-only. Without `sync`, `rwx` writes stay in MEMFS. `sync` requires
`rwx`; without `x` the mount cannot be traversed. The guard also enforces `r` on
FS-level directory enumeration, but the current R6RS whitelist exposes no
`directory-list`; rules cannot list directories unless a library provides it.

## Fixed guest namespace

Mounts use absolute guest paths under `/mnt/...` by convention. `/project`,
`/out`, `/dev`, and `/online-vm-c.scm` are reserved. Mount paths may not overlap
each other. The host path must be an existing directory; symlinks are rejected
at the mount root and anywhere in the tree. Relative `hostPath` must resolve
inside `projectRoot`.

Limits are aggregate across all mounts: 8 mounts, 2048 files, 32 MiB total,
8 MiB per file, depth 16, guest path 1024 characters.

## Reading from Scheme

`(rnrs files (6))`, `(rnrs io ports (6))`, and `(rnrs io simple (6))` are
available. `open-file-input-port` returns a binary port unless a transcoder is
supplied; use `get-bytevector-all` + `utf8->string` for binary reads:

```scheme
(library (dsh rule read-input (1 0 0))
  (export entry)
  (import (rnrs base (6)) (rnrs io ports (6)) (rnrs bytevectors (6)))
  (define (entry)
    (let ([p (open-file-input-port "/mnt/incoming/data.txt")])
      (let ([body (get-bytevector-all p)])
        (close-port p)
        (utf8->string body)))))
```

For textual ports pass a transcoder, e.g. `(make-transcoder (utf-8-codec))`.

## Writes and sync

Without `sync`, writes are discarded when the runtime closes; the host
directory is never modified. With `sync: "on-close"`, `runtime.close()` scans
each sync mount, compares content with the last synced baseline (the open-time
manifest before any `flushMounts()`), and:

- writes new/changed files through a same-directory temporary file + rename
  (atomic when the rename succeeds; a backup+restore fallback is used on
  platforms that cannot replace an existing file);
- preserves the existing file's mode; new files use the process umask;
- deletes host files that were in the baseline but are gone from MEMFS;
- syncs files only: it does not create new empty directories or delete
  directories;
- records per mount in `runtime.syncResult`:
  `{mounts:[{guestPath, written, deleted, unchanged, errors}]}`.

The sync is per file, not a filesystem transaction, and there is no `fsync`.
If an individual file fails, `close()` closes the VM, then rejects with
`E-MOUNT-SYNC` and `error.details` lists the failed paths; `runtime.syncResult`
remains available. A mount-level failure such as a limit breach rejects without
partial results. The sync timeout is configurable with `syncTimeoutMs`
(default 10000 ms); on timeout the VM is killed and unsynced/partial writes may
remain. A crash, `kill`, `restart()`, or supervised auto-restart does not sync:
changes since open are lost, and restart reuses the open-time mounts snapshot.
Reopen the runtime to reread the host.

`runtime.flushMounts()` performs the same sync before `close()` and can be called
repeatedly. It does not close the VM, and each successful sync advances the
per-mount baseline, so a file created and flushed in one call can be deleted and
flushed in the next. A per-file failure rejects with `E-MOUNT-SYNC` and
`error.details` while the VM stays open. A timeout (`E-MOUNT-SYNC-TIMEOUT`)
fails closed: the runtime is marked closed and its incarnation is terminated,
because the in-flight sync could still write the host. `(flush-output-port p)`
only flushes the Scheme port's buffer into MEMFS; it does not write the host.
Call `flushMounts()` when the host must see the bytes before the runtime is
closed.

```js
// after a rule returns and its output port has been flushed
await runtime.flushMounts()
console.log(runtime.syncResult)

await runtime.close()
```

Cross-mount operations follow the Unix permissions only: a rule can copy from a
readable mount to a writable mount, and a rename/move across mount roots is
allowed when both sides have `w+x`. The current R6RS whitelist has no
`rename-file`, so rules cannot exercise cross-mount rename yet; the filesystem
guard does not add a separate same-mount restriction. Sync remains per mount,
not a cross-mount transaction.

`sync` is supported in both direct and supervised runtimes.

## Security boundary

The mount is a capability, not a sandbox: the mounted host directory is copied
into MEMFS at open, Scheme sees only guest paths, and path traversal is rejected.
Do not mount directories containing secrets or files that should not be readable
by project rules. Mounts are explicit; there is no implicit home/working-directory
mount.
