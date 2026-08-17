#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSET=xapt-darwin-arm64.tar.gz
RELEASE="$ROOT/dist/release"

test -f "$RELEASE/$ASSET"
test -f "$RELEASE/$ASSET.sha256"

TEMP=$(mktemp -d "${TMPDIR:-/tmp}/xapt-release-verify.XXXXXX")
HOME_DIR="$TEMP/home"
API="$TEMP/api"
DOWNLOAD="$TEMP/download"
DAEMON_PID=''
SERVER_PID=''

cleanup() {
  if test -n "$DAEMON_PID"; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if test -n "$SERVER_PID"; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP"
}
trap cleanup EXIT HUP INT TERM

mkdir "$TEMP/version"
tar -xzf "$RELEASE/$ASSET" -C "$TEMP/version"
VERSION=$("$TEMP/version/xapt" --version | sed -n '1s/^xapt //p')
test -n "$VERSION"

mkdir -p "$API/repos/test/xapt/releases" "$DOWNLOAD/v$VERSION" "$HOME_DIR/.local/bin"
cp "$RELEASE/$ASSET" "$DOWNLOAD/v$VERSION/$ASSET"
cp "$RELEASE/$ASSET.sha256" "$DOWNLOAD/v$VERSION/$ASSET.sha256"
printf '{"tag_name":"v%s","draft":false,"prerelease":false}\n' "$VERSION" > "$API/repos/test/xapt/releases/latest"

cat > "$HOME_DIR/.local/bin/codex" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  --version)
    printf 'codex-cli 0.145.0\n'
    ;;
  login)
    test "${2:-}" = status
    ;;
  app-server)
    while IFS= read -r line; do
      case "$line" in
        *'"id":1'*) printf '{"id":1,"result":{}}\n' ;;
      esac
    done
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod 755 "$HOME_DIR/.local/bin/codex"

HOME="$HOME_DIR" \
PATH="$HOME_DIR/.local/bin:/usr/bin:/bin" \
XAPT_GITHUB_REPOSITORY=test/xapt \
XAPT_GITHUB_API="file://$API" \
XAPT_GITHUB_DOWNLOAD="file://$DOWNLOAD" \
sh "$ROOT/scripts/install-xapt.sh"

XAPT="$HOME_DIR/.local/bin/xapt"
test "$("$XAPT" --version | sed -n '1s/^xapt //p')" = "$VERSION"
test "$(/usr/bin/plutil -extract currentVersion raw -o - "$HOME_DIR/.local/share/xapt/install.json")" = "$VERSION"

HOME="$HOME_DIR" PATH="$HOME_DIR/.local/bin:/usr/bin:/bin" \
  "$XAPT" internal-daemon > "$TEMP/daemon.log" 2> "$TEMP/daemon-error.log" &
DAEMON_PID=$!

attempt=0
while test ! -S "$HOME_DIR/Library/Application Support/com.agentpartytime.xapt/run/control.sock"; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 100; then
    cat "$TEMP/daemon-error.log" >&2
    exit 1
  fi
  sleep 0.05
done

set +e
STATUS=$(HOME="$HOME_DIR" PATH="$HOME_DIR/.local/bin:/usr/bin:/bin" "$XAPT" daemon status)
STATUS_CODE=$?
set -e
test "$STATUS_CODE" -eq 1
printf '%s\n' "$STATUS" | grep -q '本机服务      正在运行'
printf '%s\n' "$STATUS" | grep -q "版本          $VERSION"
printf 'xapt %s Release 安装与 daemon 启动验收通过。\n' "$VERSION"

PREVIOUS_RELEASE=${XAPT_PREVIOUS_RELEASE_DIR:-$ROOT/dist/previous}
if test ! -f "$PREVIOUS_RELEASE/$ASSET"; then
  printf '未提供上一版本资产，跳过跨版本更新验收。\n'
  exit 0
fi

mkdir "$TEMP/previous"
tar -xzf "$PREVIOUS_RELEASE/$ASSET" -C "$TEMP/previous"
PREVIOUS_XAPT="$TEMP/previous/xapt"
PREVIOUS_VERSION=$("$PREVIOUS_XAPT" --version | sed -n '1s/^xapt //p')
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
if ! "$PREVIOUS_XAPT" internal-render-install-state - "$NOW" > /dev/null 2>&1; then
  printf 'xapt %s 尚无候选 Release 验收协议；当前版本作为桥接版。\n' "$PREVIOUS_VERSION"
  exit 0
fi

UPDATE_HOME="$TEMP/update-home"
UPDATE_ROOT="$TEMP/update-server"
UPDATE_INSTALL="$UPDATE_HOME/.local/share/xapt"
UPDATE_APP="$UPDATE_HOME/Library/Application Support/com.agentpartytime.xapt"
mkdir -p \
  "$UPDATE_INSTALL/versions/$PREVIOUS_VERSION" \
  "$UPDATE_HOME/.local/bin" \
  "$UPDATE_APP/run" \
  "$UPDATE_APP/state/outbox" \
  "$UPDATE_APP/state/executions" \
  "$UPDATE_APP/state/workspaces" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/updates" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/attachments" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/executions" \
  "$UPDATE_HOME/Library/Logs/com.agentpartytime.xapt" \
  "$UPDATE_ROOT/repos/test/xapt/releases"
chmod 700 \
  "$UPDATE_INSTALL" \
  "$UPDATE_INSTALL/versions" \
  "$UPDATE_INSTALL/versions/$PREVIOUS_VERSION" \
  "$UPDATE_APP" \
  "$UPDATE_APP/run" \
  "$UPDATE_APP/state" \
  "$UPDATE_APP/state/outbox" \
  "$UPDATE_APP/state/executions" \
  "$UPDATE_APP/state/workspaces" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/updates" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/attachments" \
  "$UPDATE_HOME/Library/Caches/com.agentpartytime.xapt/executions" \
  "$UPDATE_HOME/Library/Logs/com.agentpartytime.xapt"
cp "$PREVIOUS_XAPT" "$UPDATE_INSTALL/versions/$PREVIOUS_VERSION/xapt"
chmod 755 "$UPDATE_INSTALL/versions/$PREVIOUS_VERSION/xapt"
ln -s "versions/$PREVIOUS_VERSION" "$UPDATE_INSTALL/current"
ln -s "../share/xapt/current/xapt" "$UPDATE_HOME/.local/bin/xapt"
"$PREVIOUS_XAPT" internal-render-install-state - "$NOW" > "$UPDATE_INSTALL/install.json"
chmod 600 "$UPDATE_INSTALL/install.json"
cp "$HOME_DIR/.local/bin/codex" "$UPDATE_HOME/.local/bin/codex"

cp "$RELEASE/$ASSET" "$UPDATE_ROOT/$ASSET"
cp "$RELEASE/$ASSET.sha256" "$UPDATE_ROOT/$ASSET.sha256"
PORT_FILE="$TEMP/update-port"
python3 - "$UPDATE_ROOT" "$PORT_FILE" <<'PY' &
import functools
import http.server
import pathlib
import socketserver
import sys

root = sys.argv[1]
port_file = pathlib.Path(sys.argv[2])
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)

class QuietServer(socketserver.TCPServer):
    allow_reuse_address = True

with QuietServer(('127.0.0.1', 0), handler) as server:
    port_file.write_text(str(server.server_address[1]))
    server.serve_forever()
PY
SERVER_PID=$!

attempt=0
while test ! -f "$PORT_FILE"; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 100 || exit 1
  sleep 0.05
done
PORT=$(cat "$PORT_FILE")
printf '{"tag_name":"v%s","draft":false,"prerelease":false,"assets":[{"name":"%s","browser_download_url":"http://127.0.0.1:%s/%s"},{"name":"%s.sha256","browser_download_url":"http://127.0.0.1:%s/%s.sha256"}]}\n' \
  "$VERSION" "$ASSET" "$PORT" "$ASSET" "$ASSET" "$PORT" "$ASSET" \
  > "$UPDATE_ROOT/repos/test/xapt/releases/latest"

HOME="$UPDATE_HOME" \
PATH="$UPDATE_HOME/.local/bin:/usr/bin:/bin" \
XAPT_GITHUB_API="http://127.0.0.1:$PORT" \
XAPT_GITHUB_REPOSITORY=test/xapt \
"$UPDATE_HOME/.local/bin/xapt" update

test "$(readlink "$UPDATE_INSTALL/current")" = "versions/$VERSION"
test "$("$UPDATE_HOME/.local/bin/xapt" --version | sed -n '1s/^xapt //p')" = "$VERSION"
printf 'xapt %s → %s 跨版本更新与健康检查验收通过。\n' "$PREVIOUS_VERSION" "$VERSION"
