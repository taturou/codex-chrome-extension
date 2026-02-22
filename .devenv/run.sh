#!/usr/bin/env bash
set -euo pipefail

# direnv などから `source` される入口です。
# 下位スクリプトで export した値を、呼び出し元シェルへ反映します。
source "$PWD/.devenv/node.js/run.sh"
source "$PWD/.devenv/codex/run.sh"
source "$PWD/.devenv/python/run.sh"
source "$PWD/.devenv/git/run.sh"
source "$PWD/.devenv/clangd/run.sh"
source "$PWD/.devenv/serena/run.sh"
