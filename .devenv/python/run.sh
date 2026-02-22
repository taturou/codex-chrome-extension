#!/usr/bin/env bash

# シェル起動時に Python 仮想環境を有効化する補助スクリプトです。
# `source` 前提のため、ここでの `source .venv/bin/activate` により、
# 呼び出し元シェルの `PATH` / `VIRTUAL_ENV` を直接更新できます。
#
# このファイルでは「軽い処理」のみを行います。
# Python インストールや `.venv` 再作成のような重い処理は `.devenv/python/setup.sh` 側の責務です。

# uv がない環境では何もせず終了します。
# uv 非依存の作業（例: Node のみ触る作業）を阻害しないためです。
if ! command -v uv >/dev/null 2>&1; then
  return 0
fi

# プロジェクトで Python バージョン固定をしていない場合は何もしません。
# 明示的な利用意思がない状態で `.venv` を強制有効化しないためです。
if [ ! -f "$PWD/.python-version" ]; then
  return 0
fi

# `.python-version` からターゲットを確定します。
# 空値は異常設定ですが、毎回処理側では静かに抜けて起動コストとノイズを抑えます。
target="$(tr -d '[:space:]' < "$PWD/.python-version")"
if [ -z "$target" ]; then
  return 0
fi

# 対象 Python が未導入なら、毎回処理でインストールせず案内だけを出します。
# シェル入場のたびにダウンロード処理が走る設計を避けるためです。
if ! uv python find "$target" >/dev/null 2>&1; then
  echo "[uv] python '$target' is not installed. run: ./.devenv/setup.sh" >&2
  return 0
fi

# 仮想環境が存在しない場合も、ここでは作成せず案内のみ行います。
if [ ! -d "$PWD/.venv" ]; then
  echo "[uv] .venv not found. run: ./.devenv/setup.sh" >&2
  return 0
fi

# activate スクリプトがない壊れた状態も検出し、再セットアップを促します。
if [ ! -f "$PWD/.venv/bin/activate" ]; then
  echo "[uv] .venv is broken (missing activate). run: ./.devenv/setup.sh" >&2
  return 0
fi

# 既に同じ `.venv` が有効なら再 source しません。
# 毎回 source すると PATH が冗長に積み上がるケースがあるためです。
if [ "${VIRTUAL_ENV:-}" = "$PWD/.venv" ]; then
  return 0
fi

# shellcheck disable=SC1091
source "$PWD/.venv/bin/activate"
