#!/usr/bin/env bash
set -euo pipefail

# nvm / Node.js のセットアップ担当です。
# nvm 読み込み、`.nvmrc` 補完、指定バージョンの導入と有効化を行います。
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# リポジトリの `.gitignore` に追記するエントリです。
GITIGNORE_ENTRIES="
node_modules
"

# `.gitignore` がなければ作成します。
if [ ! -f "$PWD/.gitignore" ]; then
  touch "$PWD/.gitignore"
fi

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

# nvm 未導入時は失敗扱いにせず、案内のみで終了します。
# このスクリプト単体の失敗で全セットアップを止めないためです。
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "[nvm] not found: $NVM_DIR/nvm.sh" >&2
  echo "[nvm] install nvm first: https://github.com/nvm-sh/nvm" >&2
  exit 0
fi

. "$NVM_DIR/nvm.sh"

# `.nvmrc` がない場合は LTS 最新系列を既定値として採用します。
if [ ! -f "$PWD/.nvmrc" ]; then
  printf "lts/*\n" > "$PWD/.nvmrc"
fi

# 空白除去後に空なら設定異常として停止します。
target="$(tr -d '[:space:]' < "$PWD/.nvmrc")"
if [ -z "$target" ]; then
  echo "[nvm] .nvmrc is empty" >&2
  exit 1
fi

# 既存インストールがあれば、リモート参照が必要な `nvm install` を避けます。
# オフライン/制限環境でも再実行できるようにするためです。
resolved="$(nvm version "$target" 2>/dev/null || true)"
if [ -z "$resolved" ] || [ "$resolved" = "N/A" ]; then
  # 未導入時のみ install を実行します。
  nvm install "$target" --latest-npm
fi

# 続く `npm` コマンドを即利用できるよう `use` まで実行します。
nvm use --silent "$target" >/dev/null
