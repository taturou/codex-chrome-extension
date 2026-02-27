#!/usr/bin/env bash
set -euo pipefail

# Codex 用ホーム配下を初期化します。
# 必要ファイルのリンク/コピーと `.gitignore` 追記を行います。
# 先に `.devenv/codex/run.sh` を読み込み、CODEX_HOME 系の値を確定させます。
source "$PWD/.devenv/codex/run.sh"

# Codex の導入状態を判定します。
LOCAL_CODEX_BIN="$CODEX_HOME/node_modules/.bin/codex"

has_local_codex() {
  [ -x "$LOCAL_CODEX_BIN" ]
}

has_global_codex() {
  npm list -g --depth=0 @openai/codex >/dev/null 2>&1
}

# Codex のインストール先を決定します。
# 優先順: 第1引数 > CODEX_INSTALL_SCOPE 環境変数 > 既存導入の自動判定 > 対話入力(tty時) > 既定値(global)
INSTALL_SCOPE="${1:-${CODEX_INSTALL_SCOPE:-}}"
if [ -z "$INSTALL_SCOPE" ]; then
  if has_local_codex; then
    INSTALL_SCOPE="local"
  elif has_global_codex; then
    INSTALL_SCOPE="global"
  else
    if [ -t 0 ] && [ -t 1 ]; then
      echo "Codex のインストール先を選択してください。"
      echo "1) global (npm install -g)"
      echo "2) local  (npm install --prefix \$CODEX_HOME)"
      read -r -p "選択 [1/2] (default: 1): " selection
      case "$selection" in
        2 | local | LOCAL) INSTALL_SCOPE="local" ;;
        "" | 1 | global | GLOBAL) INSTALL_SCOPE="global" ;;
        *)
          echo "不正な選択です: $selection" >&2
          exit 1
          ;;
      esac
    else
      INSTALL_SCOPE="global"
    fi
  fi
fi

case "$INSTALL_SCOPE" in
  global | local) ;;
  *)
    echo "INSTALL_SCOPE は global または local を指定してください: $INSTALL_SCOPE" >&2
    exit 1
    ;;
esac

# 共有元（`$HOME/.codex`）からシンボリックリンクで扱うファイル群です。
# 共有元の更新を即時反映したい設定・認証情報を対象にします。
SYMLINK_FILES="
AGENTS.md
auth.json
"

# テンプレートから実体コピーするファイル群です。
# ローカルで編集する可能性があるため、リンクではなくコピーします。
COPY_FILES="
config.toml
"

# リポジトリの `.gitignore` に追記するエントリです。
# 個人設定・キャッシュ・履歴など VCS 管理しないパスを列挙します。
GITIGNORE_ENTRIES="
$CODEX_HOME_RELATIVE/.personality_migration
$CODEX_HOME_RELATIVE/AGENTS.md
$CODEX_HOME_RELATIVE/auth.json
$CODEX_HOME_RELATIVE/history.jsonl
$CODEX_HOME_RELATIVE/log
$CODEX_HOME_RELATIVE/models_cache.json
$CODEX_HOME_RELATIVE/node_modules
$CODEX_HOME_RELATIVE/package-lock.json
$CODEX_HOME_RELATIVE/package.json
$CODEX_HOME_RELATIVE/shell_snapshots
$CODEX_HOME_RELATIVE/skills/.system
$CODEX_HOME_RELATIVE/state_5.sqlite
$CODEX_HOME_RELATIVE/state_5.sqlite-shm
$CODEX_HOME_RELATIVE/state_5.sqlite-wal
$CODEX_HOME_RELATIVE/tmp
$CODEX_HOME_RELATIVE/version.json
"

# Codex ホームディレクトリがなければ作成します。
if [ ! -d "$CODEX_HOME" ]; then
  mkdir -p "$CODEX_HOME"
fi

# `.gitignore` がなければ作成します。
if [ ! -f "$PWD/.gitignore" ]; then
  touch "$PWD/.gitignore"
fi

# 指定ファイルを「未作成時のみ」シンボリックリンクします。
# 既存ファイルがある場合は上書きしません。
for name in $SYMLINK_FILES; do
  dest="$CODEX_HOME/$name"
  src="$HOME/.codex/$name"
  if [ -e "$src" ] && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    ln -s "$src" "$dest"
  fi
done

# 指定ファイルを「未作成時のみ」コピーします。
# 既存ファイルを壊さないことを優先します。
for name in $COPY_FILES; do
  dest="$CODEX_HOME/$name"
  src="$PWD/.devenv/codex/template/$name"
  if [ -e "$src" ] && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    cp "$src" "$dest"
  fi
done

# `.gitignore` に同一行があるかを固定文字列の完全一致で判定します。
for entry in $GITIGNORE_ENTRIES; do
  exists_in_gitignore() {
    grep -Fqx -- "$1" "$PWD/.gitignore"
  }
  # 未登録エントリだけを追記して重複を防ぎます。
  if ! exists_in_gitignore "$entry"; then
    printf "%s\n" "$entry" >> "$PWD/.gitignore"
  fi
done

# Codex の npm パッケージを「未導入時のみ」インストールします。
if [ "$INSTALL_SCOPE" = "global" ]; then
  if ! has_global_codex; then
    npm install -g @openai/codex
  fi
else
  if ! has_local_codex; then
    npm install --prefix "$CODEX_HOME" @openai/codex
  fi
fi
