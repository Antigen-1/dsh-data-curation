#!/usr/bin/env bash
set -euo pipefail

# Build the C-ABI variant of the Chez Wasm host.
# Chez source/build output stays outside the repository; only the guest,
# C shim, this script, and the resulting assets are copied back.
#
# Expected environment: the podman container used by the experiment has
# /src/ChezScheme checked out at the pinned commit and emcc on PATH.

ROOT="${1:-/work}"
CHEZ="${2:-/src/ChezScheme}"
OUT="${3:-/tmp/dsh-c}"
DEST_EXPERIMENT="$ROOT/experiments/wasm/chez/10.4.1-c"
DEST_ASSETS="$ROOT/assets/chez-wasm/10.4.1-c"

mkdir -p "$OUT"

emcc -O2 -I"$CHEZ/boot/pb" -c "$ROOT/experiments/wasm/chez/online-vm.c" -o "$OUT/online-vm.o"

# Build from $OUT so Emscripten's generated data-package name stays relative.
# An absolute output path leaks the builder's local directory into the JS glue.
(
  cd "$OUT"
  emcc -O2 -s USE_ZLIB=1 \
  -o scheme-c.js \
  "$OUT/online-vm.o" \
  "$CHEZ/em-pb/boot/pb/main.o" \
  "$CHEZ/em-pb/boot/pb/libkernel.a" \
  "$CHEZ/em-pb/lz4/lib/liblz4.a" \
  --preload-file "$CHEZ/em-pb/boot/pb/petite.boot@petite.boot" \
  --preload-file "$CHEZ/em-pb/boot/pb/scheme.boot@scheme.boot" \
  --preload-file "$ROOT/experiments/wasm/chez/online-vm-c.scm@online-vm-c.scm" \
  --preload-file "$ROOT/experiments/wasm/chez/plugin-loader.scm@plugin-loader.scm" \
  --preload-file "$ROOT/experiments/wasm/chez/source-tree-reader.scm@source-tree-reader.scm" \
  --preload-file "$ROOT/experiments/wasm/chez/suspend-probe.scm@suspend-probe.scm" \
  -s EXIT_RUNTIME=0 \
  -s INVOKE_RUN=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS='["FS"]' \
  -s EXPORTED_FUNCTIONS='["_dsh_init","_dsh_dispatch","_dsh_resume","_dsh_out_ptr","_dsh_out_len","_dsh_set_guest","_dsh_mount_file","_dsh_read_file","_dsh_file_size","_dsh_out_size","_dsh_out_count","_malloc","_free"]'
)

mkdir -p "$DEST_EXPERIMENT" "$DEST_ASSETS"
for name in scheme-c.js scheme-c.wasm scheme-c.data; do
  cp "$OUT/$name" "$DEST_EXPERIMENT/$name"
  cp "$OUT/$name" "$DEST_ASSETS/$name"
done

echo "built: $OUT/scheme-c.js"
echo "copied: $DEST_EXPERIMENT/"
echo "copied: $DEST_ASSETS/"
echo "next: node scripts/refresh-chez-engine.mjs"
