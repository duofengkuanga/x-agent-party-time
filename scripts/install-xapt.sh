#!/bin/sh
set -eu

REPOSITORY=${XAPT_GITHUB_REPOSITORY:-duofengkuanga/x-agent-party-time}
API=${XAPT_GITHUB_API:-https://api.github.com}
DOWNLOAD=${XAPT_GITHUB_DOWNLOAD:-https://github.com/$REPOSITORY/releases/download}
ASSET=xapt-darwin-arm64.tar.gz
BEGIN='# >>> xapt PATH >>>'
END='# <<< xapt PATH <<<'

fail() { printf 'xapt 安装失败：%s\n' "$1" >&2; exit 1; }
test "$(uname -s)" = Darwin || fail '仅支持 macOS'
test "$(uname -m)" = arm64 || fail '仅支持 Apple Silicon arm64'

TMP=$(mktemp -d "${TMPDIR:-/tmp}/xapt-install.XXXXXX") || fail '无法创建临时目录'
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

RELEASE_JSON=$(curl -fsSL "$API/repos/$REPOSITORY/releases/latest") || fail '无法读取最新稳定 Release'
TAG=$(printf '%s' "$RELEASE_JSON" | /usr/bin/plutil -extract tag_name raw -o - - 2>/dev/null || true)
DRAFT=$(printf '%s' "$RELEASE_JSON" | /usr/bin/plutil -extract draft raw -o - - 2>/dev/null || true)
PRERELEASE=$(printf '%s' "$RELEASE_JSON" | /usr/bin/plutil -extract prerelease raw -o - - 2>/dev/null || true)
test -n "$TAG" || fail 'Release 缺少 tag_name'
test "$DRAFT" = false && test "$PRERELEASE" = false || fail 'Release 不是稳定版本'
VERSION=${TAG#v}
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Release 不是稳定语义版本'

curl -fsSL "$DOWNLOAD/$TAG/$ASSET" -o "$TMP/$ASSET" || fail '无法下载资产'
curl -fsSL "$DOWNLOAD/$TAG/$ASSET.sha256" -o "$TMP/$ASSET.sha256" || fail '缺少 checksum'
EXPECTED=$(awk 'NF == 2 && $2 == "xapt-darwin-arm64.tar.gz" { print $1 }' "$TMP/$ASSET.sha256")
printf '%s' "$EXPECTED" | grep -Eq '^[a-f0-9]{64}$' || fail 'checksum 格式无效'
ACTUAL=$(/usr/bin/shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
test "$EXPECTED" = "$ACTUAL" || fail 'checksum 不匹配'

test "$(/usr/bin/tar -tzf "$TMP/$ASSET")" = xapt || fail '压缩包内容无效'
mkdir "$TMP/unpack"
/usr/bin/tar -xzf "$TMP/$ASSET" -C "$TMP/unpack"
test -f "$TMP/unpack/xapt" && test ! -L "$TMP/unpack/xapt" || fail 'xapt 文件类型无效'
chmod 755 "$TMP/unpack/xapt"
(/usr/bin/file "$TMP/unpack/xapt" | grep -Eq 'Mach-O 64-bit executable arm64') || fail 'xapt 不是 macOS arm64 可执行文件'
/usr/bin/codesign --verify --strict "$TMP/unpack/xapt" || fail 'xapt 签名结构无效'
INSTALLED_VERSION=$("$TMP/unpack/xapt" --version 2>/dev/null | sed -n '1s/^xapt //p') || fail 'xapt 二进制无法运行'
test "$INSTALLED_VERSION" = "$VERSION" || fail 'xapt 二进制版本与 Release 不一致'

ROOT="$HOME/.local/share/xapt"
VERSIONS="$ROOT/versions"
TARGET="$VERSIONS/$VERSION"
mkdir -p "$VERSIONS" "$HOME/.local/bin"
chmod 700 "$ROOT" "$VERSIONS"
test ! -e "$TARGET" || test -x "$TARGET/xapt" || fail '目标版本目录不完整'
if test ! -e "$TARGET"; then
  mv "$TMP/unpack" "$TARGET"
  chmod 700 "$TARGET"
else
  test -f "$TARGET/xapt" && test ! -L "$TARGET/xapt" || fail '已有目标版本文件类型无效'
  /usr/bin/codesign --verify --strict "$TARGET/xapt" || fail '已有目标版本签名结构无效'
  EXISTING_VERSION=$("$TARGET/xapt" --version 2>/dev/null | sed -n '1s/^xapt //p') || fail '已有目标版本无法运行'
  test "$EXISTING_VERSION" = "$VERSION" || fail '已有目标版本不一致'
fi
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
INSTALLED_AT=$NOW
test ! -e "$ROOT/install.json" || { test -f "$ROOT/install.json" && test ! -L "$ROOT/install.json"; } || fail 'install.json 文件类型无效'
test ! -e "$ROOT/current" || test -L "$ROOT/current" || fail 'current 入口文件类型无效'
test ! -e "$HOME/.local/bin/xapt" || test -L "$HOME/.local/bin/xapt" || fail '~/.local/bin/xapt 已存在且不是符号链接'

OLD_INSTALL=false
if test -f "$ROOT/install.json"; then
  cp "$ROOT/install.json" "$TMP/install.json.before"
  OLD_INSTALL=true
  OLD_INSTALL_MODE=$(stat -f '%Lp' "$ROOT/install.json")
  EXISTING_INSTALLED_AT=$(/usr/bin/plutil -extract installedAt raw -o - "$ROOT/install.json" 2>/dev/null || true)
  test -z "$EXISTING_INSTALLED_AT" || INSTALLED_AT=$EXISTING_INSTALLED_AT
fi
PREVIOUS_VERSION=-
OLD_CURRENT=false
OLD_CURRENT_TARGET=''
if test -L "$ROOT/current"; then
  OLD_CURRENT=true
  CURRENT_TARGET=$(readlink "$ROOT/current" || true)
  OLD_CURRENT_TARGET=$CURRENT_TARGET
  CURRENT_VERSION=${CURRENT_TARGET#versions/}
  if test "$CURRENT_TARGET" = "versions/$CURRENT_VERSION" && test "$CURRENT_VERSION" != "$VERSION" && printf '%s' "$CURRENT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    PREVIOUS_VERSION=$CURRENT_VERSION
  fi
fi
OLD_COMMAND=false
OLD_COMMAND_TARGET=''
if test -L "$HOME/.local/bin/xapt"; then
  OLD_COMMAND=true
  OLD_COMMAND_TARGET=$(readlink "$HOME/.local/bin/xapt" || true)
fi
INSTALL_TMP=$(mktemp "$ROOT/install.json.XXXXXX") || fail '无法写入安装状态'
"$TARGET/xapt" internal-render-install-state "$PREVIOUS_VERSION" "$INSTALLED_AT" > "$INSTALL_TMP" || fail '目标 xapt 无法生成安装状态'
chmod 600 "$INSTALL_TMP"
ln -sfn "versions/$VERSION" "$ROOT/current.next"
ln -sfn "../share/xapt/current/xapt" "$HOME/.local/bin/xapt.next"

SWITCH_ERROR=''
if ! mv -f "$ROOT/current.next" "$ROOT/current"; then
  SWITCH_ERROR='无法切换 current 入口'
elif ! mv -f "$HOME/.local/bin/xapt.next" "$HOME/.local/bin/xapt"; then
  SWITCH_ERROR='无法切换命令入口'
elif ! mv -f "$INSTALL_TMP" "$ROOT/install.json"; then
  SWITCH_ERROR='无法提交安装状态'
fi

if test -n "$SWITCH_ERROR"; then
  ROLLBACK_FAILED=false
  if test "$OLD_CURRENT" = true; then
    ln -sfn "$OLD_CURRENT_TARGET" "$ROOT/current.rollback" && mv -f "$ROOT/current.rollback" "$ROOT/current" || ROLLBACK_FAILED=true
  else
    rm -f "$ROOT/current" || ROLLBACK_FAILED=true
  fi
  if test "$OLD_COMMAND" = true; then
    ln -sfn "$OLD_COMMAND_TARGET" "$HOME/.local/bin/xapt.rollback" && mv -f "$HOME/.local/bin/xapt.rollback" "$HOME/.local/bin/xapt" || ROLLBACK_FAILED=true
  else
    rm -f "$HOME/.local/bin/xapt" || ROLLBACK_FAILED=true
  fi
  if test "$OLD_INSTALL" = true; then
    cp "$TMP/install.json.before" "$ROOT/install.json.rollback" && chmod "$OLD_INSTALL_MODE" "$ROOT/install.json.rollback" && mv -f "$ROOT/install.json.rollback" "$ROOT/install.json" || ROLLBACK_FAILED=true
  else
    rm -f "$ROOT/install.json" || ROLLBACK_FAILED=true
  fi
  test "$ROLLBACK_FAILED" = false || fail "${SWITCH_ERROR}，且回滚失败"
  fail "${SWITCH_ERROR}，已恢复原安装入口"
fi

ZDOT=$(/bin/zsh -lic 'print -r -- ${ZDOTDIR:-$HOME}' 2>/dev/null | tail -n 1 || printf '%s' "$HOME")
ZSHRC="$ZDOT/.zshrc"
PATH_CONFIGURED=false
if test "${SHELL:-}" = /bin/zsh && ZDOTDIR="$ZDOT" /bin/zsh -ic 'case ":${PATH:-}:" in *":$HOME/.local/bin:"*) exit 0;; *) exit 1;; esac' >/dev/null 2>&1; then
  PATH_CONFIGURED=true
elif test "${SHELL:-}" = /bin/zsh && test ! -L "$ZSHRC" && { test ! -e "$ZSHRC" || { test -f "$ZSHRC" && test -w "$ZSHRC" && test -O "$ZSHRC"; }; }; then
  mkdir -p "$ZDOT"
  BEFORE=$(grep -Fxc "$BEGIN" "$ZSHRC" 2>/dev/null || true)
  AFTER=$(grep -Fxc "$END" "$ZSHRC" 2>/dev/null || true)
  BEFORE=${BEFORE:-0}
  AFTER=${AFTER:-0}
  if test "$BEFORE" -eq 0 && test "$AFTER" -eq 0; then
    ZTMP=$(mktemp "$ZDOT/.zshrc.xapt.XXXXXX") || ZTMP=''
    ORIGINAL_ZSHRC=false
    if test -e "$ZSHRC"; then
      cp "$ZSHRC" "$TMP/zshrc.before"
      ORIGINAL_ZSHRC=true
      ZSHRC_MODE=$(stat -f '%Lp' "$ZSHRC")
    else
      ZSHRC_MODE=600
    fi
    if test -n "$ZTMP"; then {
      test ! -e "$ZSHRC" || cat "$ZSHRC"
      printf '\n%s\n' "$BEGIN"
      printf '%s\n' 'case ":${PATH:-}:" in'
      printf '%s\n' '  *":$HOME/.local/bin:"*) ;;'
      printf '%s\n' '  *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;'
      printf '%s\n' 'esac'
      printf '%s\n' "$END"
    } > "$ZTMP"
    chmod "$ZSHRC_MODE" "$ZTMP"
    mv "$ZTMP" "$ZSHRC"
    if ! ZDOTDIR="$ZDOT" /bin/zsh -ic 'command -v xapt >/dev/null 2>&1' >/dev/null 2>&1; then
      RESTORE=$(mktemp "$ZDOT/.zshrc.xapt.XXXXXX") || RESTORE=''
      if test "$ORIGINAL_ZSHRC" = true; then
        if test -n "$RESTORE"; then
          cp "$TMP/zshrc.before" "$RESTORE"
          chmod "$ZSHRC_MODE" "$RESTORE"
          mv "$RESTORE" "$ZSHRC"
        fi
      else
        rm -f "$ZSHRC"
      fi
    fi
    fi
  fi
  FINAL_BEFORE=$(grep -Fxc "$BEGIN" "$ZSHRC" 2>/dev/null || true)
  FINAL_AFTER=$(grep -Fxc "$END" "$ZSHRC" 2>/dev/null || true)
  if test "${FINAL_BEFORE:-0}" -eq 1 && test "${FINAL_AFTER:-0}" -eq 1; then
    PATH_CONFIGURED=true
  fi
fi

printf 'xapt %s 已安装。\n' "$VERSION"
printf '预览版使用 ad-hoc 签名，未经 Apple 公证。\n'
if test "$PATH_CONFIGURED" = false; then
  printf '请手工将 $HOME/.local/bin 加入 PATH。\n'
fi
printf '下一步：xapt daemon start\n'
