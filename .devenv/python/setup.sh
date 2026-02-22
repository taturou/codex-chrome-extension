#!/usr/bin/env bash
set -euo pipefail

# uv / Python のセットアップ担当です。
# ここでは「重い処理」をまとめて実行します。
# - `.python-version` の補完
# - 対象 Python のインストール
# - 仮想環境 `.venv` の作成（または再生成）
# そのため、通常のシェル入場時には呼ばず、`setup.sh` からのみ呼ぶ前提です。

# リポジトリで生成される Python 関連ファイルを Git 管理外にするためのエントリです。
# `.python-version` はチーム方針次第で追跡対象にするケースもありますが、
# 本リポジトリでは nvm の `.nvmrc` と同様にローカルセットアップ側で生成する方針のため、
# ここで ignore へ追加します。
GITIGNORE_ENTRIES="
.venv
"

# `.gitignore` が未作成でも後続処理が失敗しないよう、先に空ファイルを用意します。
if [ ! -f "$PWD/.gitignore" ]; then
  touch "$PWD/.gitignore"
fi

# 固定文字列かつ行完全一致で既存判定するためのヘルパーです。
# 部分一致では誤判定（例: `.venv` と `.venv_backup`）が発生するため、
# `grep -Fqx` を使って厳密一致にします。
exists_in_gitignore() {
  grep -Fqx -- "$1" "$PWD/.gitignore"
}

# 重複行を作らないよう、未登録エントリだけを追記します。
for entry in $GITIGNORE_ENTRIES; do
  if ! exists_in_gitignore "$entry"; then
    printf "%s\n" "$entry" >> "$PWD/.gitignore"
  fi
done

# uv が未導入なら、このスクリプト単体では失敗扱いにしません。
# 理由:
# - 現在の `.devenv/node.js/setup.sh` と同じ失敗ポリシーにそろえるため
# - uv 未使用の開発者環境を許容し、全体セットアップ停止を避けるため
if ! command -v uv >/dev/null 2>&1; then
  echo "[uv] not found" >&2
  echo "[uv] install uv first: https://github.com/astral-sh/uv" >&2
  exit 0
fi

# `.python-version` がなければ Python 3 系の最新安定版を意味する `3` を採用します。
# 明示バージョンを固定したい場合は、利用者が事前に具体値（例: `3.12.8`）を書けばそれを優先します。
if [ ! -f "$PWD/.python-version" ]; then
  printf "3\n" > "$PWD/.python-version"
fi

# 空白と改行を除去し、実際に uv へ渡すターゲット値を確定します。
# 空文字は設定異常として停止します（誤った空設定を見逃さないため）。
target="$(tr -d '[:space:]' < "$PWD/.python-version")"
if [ -z "$target" ]; then
  echo "[uv] .python-version is empty" >&2
  exit 1
fi

# 対象 Python をインストールします。
# 既に導入済みなら uv 側で再利用されるため、繰り返し実行しても問題ありません。
uv python install "$target"

# `.venv` を対象 Python で作成します。
# 既存 `.venv` がある場合も同コマンドで整合した状態へ寄せられるため、
# 「初回作成」と「再セットアップ」を同一手順にしています。
uv venv --python "$target" "$PWD/.venv"
