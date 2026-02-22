#!/usr/bin/env bash

# Codex 用の環境変数を計算して export します。
# `source` 前提のため、値は呼び出し元シェルに残ります。
CONFIG_FILE="$PWD/.devenv/config.toml"
# config.toml に設定がない場合は既定値 ".codex" を使います。
CODEX_HOME_RELATIVE=""

read_toml_section_string() {
  local section="$1"
  local key="$2"
  local file="$3"
  awk -v target_section="$section" -v target_key="$key" '
    /^[[:space:]]*\[/ {
      in_section = ($0 ~ "^[[:space:]]*\\[" target_section "\\][[:space:]]*$")
      next
    }
    in_section {
      pattern = "^[[:space:]]*" target_key "[[:space:]]*=[[:space:]]*\"([^\"]*)\""
      if (match($0, pattern, m)) {
        print m[1]
        exit
      }
    }
  ' "$file"
}

if [ -f "$CONFIG_FILE" ]; then
  # TOML の [codex] セクションから `codex_home_relative="..."` を抽出します。
  # 先頭/末尾の空白を許容し、最初の一致だけ採用します。
  # 取得できない場合は空文字のままにし、後段で既定値へフォールバックします。
  CODEX_HOME_RELATIVE="$(read_toml_section_string "codex" "codex_home_relative" "$CONFIG_FILE")"
fi

if [ -z "$CODEX_HOME_RELATIVE" ]; then
  # 未定義または空値なら既定値に統一します。
  CODEX_HOME_RELATIVE=".codex"
fi

# 相対パスと絶対パスの両方を公開します。
# CODEX_HOME_RELATIVE: リポジトリルート起点の相対パス
# CODEX_HOME_ABSOLUTE / CODEX_HOME: 実体の絶対パス
export CODEX_HOME_RELATIVE="$CODEX_HOME_RELATIVE"
export CODEX_HOME_ABSOLUTE="$PWD/$CODEX_HOME_RELATIVE"
export CODEX_HOME="$CODEX_HOME_ABSOLUTE"

# ローカルインストール（`npm --prefix "$CODEX_HOME"`）時の実行パスを通します。
# これにより `codex` を npx なしで直接実行できます。
if [ -d "$CODEX_HOME/node_modules/.bin" ]; then
  export PATH="$CODEX_HOME/node_modules/.bin:$PATH"
fi
