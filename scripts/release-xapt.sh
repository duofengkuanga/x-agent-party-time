#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT="$ROOT/dist/release"
ASSET=xapt-darwin-arm64.tar.gz

test "$(uname -s)" = Darwin
test "$(uname -m)" = arm64
mkdir -p "$OUTPUT"
rm -f "$ROOT/dist/xapt" "$OUTPUT/$ASSET" "$OUTPUT/$ASSET.sha256"
bun run build:xapt
if test -n "${GITHUB_REF_NAME:-}"; then
  BUILT_VERSION=$("$ROOT/dist/xapt" --version | sed -n '1s/^xapt //p')
  test "$GITHUB_REF_NAME" = "v$BUILT_VERSION" || {
    printf 'Release Tag %s 与 xapt %s 不一致\n' "$GITHUB_REF_NAME" "$BUILT_VERSION" >&2
    exit 1
  }
fi
/usr/bin/codesign --force --sign - "$ROOT/dist/xapt"
/usr/bin/codesign --verify --strict "$ROOT/dist/xapt"
COPYFILE_DISABLE=1 /usr/bin/tar -C "$ROOT/dist" -czf "$OUTPUT/$ASSET" xapt
(cd "$OUTPUT" && /usr/bin/shasum -a 256 "$ASSET" > "$ASSET.sha256")
