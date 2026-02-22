#!/usr/bin/env bash

# GitHub / Git ユーザー設定を `config.toml` から解決して export します。
# `source` 前提のため、値は呼び出し元シェルへ反映されます。
CONFIG_FILE="$PWD/.devenv/config.toml"

read_toml_string() {
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

# `[git].user_name` / `[git].user_email` があれば優先。なければ `~/.gitconfig` の既定値を使用します。
GIT_USER_NAME=""
GIT_USER_EMAIL=""
if [ -f "$CONFIG_FILE" ]; then
  GIT_USER_NAME="$(read_toml_string "git" "user_name" "$CONFIG_FILE")"
  GIT_USER_EMAIL="$(read_toml_string "git" "user_email" "$CONFIG_FILE")"
fi
if [ -z "$GIT_USER_NAME" ]; then
  GIT_USER_NAME="$(git config --file "$HOME/.gitconfig" --get user.name 2>/dev/null || true)"
fi
if [ -z "$GIT_USER_EMAIL" ]; then
  GIT_USER_EMAIL="$(git config --file "$HOME/.gitconfig" --get user.email 2>/dev/null || true)"
fi

export GIT_USER_NAME="${GIT_USER_NAME:-}"
export GIT_USER_EMAIL="${GIT_USER_EMAIL:-}"

# `source` 時点で、必要ならリポジトリローカル設定へ同期します。
# setup 実行有無に依存せず、`config.toml` の変更を `.git/config` へ反映させます。
sync_git_local_identity() {
  # Git 管理外ディレクトリでは何もしません。
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  local current_name current_email
  current_name="$(git config --local --get user.name 2>/dev/null || true)"
  current_email="$(git config --local --get user.email 2>/dev/null || true)"

  if [ -n "$GIT_USER_NAME" ] && [ "$current_name" != "$GIT_USER_NAME" ]; then
    git config --local user.name "$GIT_USER_NAME"
  fi

  if [ -n "$GIT_USER_EMAIL" ] && [ "$current_email" != "$GIT_USER_EMAIL" ]; then
    git config --local user.email "$GIT_USER_EMAIL"
  fi
}

sync_git_local_identity
