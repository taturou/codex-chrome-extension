#!/usr/bin/env bash

# シェル起動時に `.nvmrc` の Node.js へ合わせる補助スクリプトです。
# `source` 前提のため、nvm の関数と環境変数を現在シェルへ反映します。
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# nvm がない環境では何もせず終了します。
# Node を使わない開発者環境との差分を許容するためです。
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  return 0
fi

. "$NVM_DIR/nvm.sh"

# プロジェクトでバージョン固定していない場合も何もしません。
if [ ! -f "$PWD/.nvmrc" ]; then
  return 0
fi

# `.nvmrc` から空白を除去して対象バージョンを確定します。
target="$(tr -d '[:space:]' < "$PWD/.nvmrc")"
if [ -z "$target" ]; then
  return 0
fi

# current: 現在有効な Node バージョン
# resolved: target を解決した実体バージョン（alias 指定を展開）
current="$(nvm current 2>/dev/null || true)"
resolved="$(nvm version "$target" 2>/dev/null || true)"

# 未インストール時は自動インストールせず、案内だけ出します。
# シェル起動時の重い処理を避けるためです。
if [ -z "$resolved" ] || [ "$resolved" = "N/A" ]; then
  echo "[nvm] $target is not installed. run: ./.devenv/setup.sh" >&2
  return 0
fi

# すでに一致している場合は `nvm use` を呼ばず、起動コストを抑えます。
# 一致判定は次を許容します:
# current == target
# v$current == target（target が v 付き指定）
# current == resolved（alias 展開後の一致）
if [ "$current" != "$target" ] && [ "v$current" != "$target" ] && [ "$current" != "$resolved" ]; then
  nvm use --silent "$target" >/dev/null
fi
