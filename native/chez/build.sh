#!/usr/bin/env bash
set -euo pipefail

# Build the C-ABI Chez Wasm host from tracked sources.
#
# Chez source/build output stays outside the repository. This script embeds
# only the project guest sources and copies the built assets into the package.
#
# Usage: build.sh [ROOT] [CHEZ] [OUT]
# Expected environment: podman container with emcc and /src/ChezScheme at the
# pinned commit.

ROOT="${1:-/work}"
CHEZ="${2:-/src/ChezScheme}"
OUT="${3:-/tmp/dsh-c}"
DEST="$ROOT/assets/chez-wasm/10.4.1-c"

mkdir -p "$OUT" "$DEST"

emcc -O2 -I"$CHEZ/boot/pb" -c "$ROOT/native/chez/online-vm.c" -o "$OUT/online-vm.o"

# Build from $OUT so Emscripten's data-package name stays relative.
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
    --preload-file "$ROOT/native/chez/online-vm-c.scm@online-vm-c.scm" \
    --preload-file "$ROOT/native/chez/plugin-loader.scm@plugin-loader.scm" \
    --preload-file "$ROOT/native/chez/source-tree-reader.scm@source-tree-reader.scm" \
    -s EXIT_RUNTIME=0 \
    -s INVOKE_RUN=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=536870912 \
    -s EXPORTED_RUNTIME_METHODS='["FS"]' \
    -s EXPORTED_FUNCTIONS='["_dsh_init","_dsh_dispatch","_dsh_resume","_dsh_out_ptr","_dsh_out_len","_dsh_set_guest","_dsh_mount_file","_dsh_read_file","_dsh_file_size","_dsh_out_size","_dsh_out_count","_malloc","_free"]'
)

cp "$OUT/scheme-c.js" "$OUT/scheme-c.wasm" "$OUT/scheme-c.data" "$DEST/"
echo "built and copied: $DEST"
echo "next: node scripts/refresh-chez-engine.mjs"
