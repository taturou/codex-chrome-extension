#!/usr/bin/env bash
set -euo pipefail

# 開発環境セットアップの統合入口です。
# `.envrc` のリンク作成、Codex 初期化、nvm/Node 初期化を順に実行します。
# `set -euo pipefail` で未定義変数や途中失敗を即時検出し、不完全状態を防ぎます。
GITIGNORE_ENTRIES="
.envrc
"

for entry in $GITIGNORE_ENTRIES; do
  exists_in_gitignore() {
    grep -Fqx -- "$1" "$PWD/.gitignore"
  }
  # 未登録エントリだけを追記して重複を防ぎます。
  if ! exists_in_gitignore "$entry"; then
    printf "%s\n" "$entry" >> "$PWD/.gitignore"
  fi
done

# `.devenv/config.toml` が未作成のときだけテンプレートから生成します。
# 既存のローカル編集を維持し、セットアップ再実行での上書きを防ぎます。
if [ ! -e "$PWD/.devenv/config.toml" ]; then
  cp "$PWD/.devenv/config.template.toml" "$PWD/.devenv/config.toml"
fi

ln -sfn "$PWD/.devenv/run.sh" "$PWD/.envrc"

# direnv がある環境では `.envrc` を即時承認します。
# 未導入/承認失敗でもセットアップ全体は継続します。
if command -v direnv >/dev/null 2>&1; then
  if ! direnv allow "$PWD"; then
    echo "[direnv] failed to allow '$PWD/.envrc'" >&2
    echo "[direnv] run manually: direnv allow $PWD" >&2
  fi
fi

bash "$PWD/.devenv/node.js/setup.sh"
bash "$PWD/.devenv/codex/setup.sh"
bash "$PWD/.devenv/serena/setup.sh"
bash "$PWD/.devenv/python/setup.sh"
bash "$PWD/.devenv/git/setup.sh"
