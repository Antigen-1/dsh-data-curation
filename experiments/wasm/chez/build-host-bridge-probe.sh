#!/usr/bin/env bash
set -euo pipefail

# Build the blocking-host-bridge probe variant of the C ABI host.
# Chez source/build output stays outside the repository.

ROOT="${1:-/work}"
CHEZ="${2:-/src/ChezScheme}"
OUT="${3:-/tmp/dsh-hb}"

mkdir -p "$OUT"

emcc -O2 -I"$CHEZ/boot/pb" -c "$ROOT/experiments/wasm/chez/online-vm.c" -o "$OUT/online-vm.o"

emcc -O2 -s USE_ZLIB=1 \
  -o "$OUT/scheme-hb.js" \
  "$OUT/online-vm.o" \
  "$CHEZ/em-pb/boot/pb/main.o" \
  "$CHEZ/em-pb/boot/pb/libkernel.a" \
  "$CHEZ/em-pb/lz4/lib/liblz4.a" \
  --preload-file "$CHEZ/em-pb/boot/pb/petite.boot@petite.boot" \
  --preload-file "$CHEZ/em-pb/boot/pb/scheme.boot@scheme.boot" \
  --preload-file "$ROOT/experiments/wasm/chez/host-bridge-probe.scm@host-bridge-probe.scm" \
  -s EXIT_RUNTIME=0 \
  -s INVOKE_RUN=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS='["_dsh_init","_dsh_dispatch","_dsh_resume","_dsh_out_ptr","_dsh_out_len","_dsh_set_guest","_malloc","_free"]'

echo "built: $OUT/scheme-hb.js"
