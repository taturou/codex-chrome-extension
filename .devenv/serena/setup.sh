#!/usr/bin/env bash
set -euo pipefail

# `.devenv/config.toml` の [serena].enable が true のときだけ、
# `$CODEX_HOME/config.toml` に serena の MCP 設定を追記します。
CONFIG_FILE="$PWD/.devenv/config.toml"
SERENA_MCP_CONFIG_SNIPPET="$PWD/.devenv/serena/template/codex_mcp_serena.toml"

main() {
  if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$SERENA_MCP_CONFIG_SNIPPET" ]; then
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  enabled="$({
    python3 - "$CONFIG_FILE" <<'PY'
from pathlib import Path
import sys
import tomllib

config_path = Path(sys.argv[1])
try:
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
except Exception:
    print("false")
    raise SystemExit(0)

serena = data.get("serena")
if isinstance(serena, dict) and serena.get("enable") is True:
    print("true")
else:
    print("false")
PY
  } 2>/dev/null || echo "false")"

  if [ "$enabled" != "true" ]; then
    return 0
  fi

  if [ -z "${CODEX_HOME:-}" ]; then
    return 0
  fi

  target_config="$CODEX_HOME/config.toml"
  if [ ! -f "$target_config" ]; then
    return 0
  fi

  # 同一セクションの重複追記を防止します。
  if grep -Fq "[mcp_servers.serena]" "$target_config"; then
    return 0
  fi

  if [ -s "$target_config" ]; then
    # 末尾が空行でない場合のみ、テンプレート前に空行を1つ挟みます。
    # 末尾改行なしファイルでは `\n\n`、末尾改行ありでは `\n` を補います。
    if [ -n "$(tail -n 1 "$target_config")" ]; then
      if [ -n "$(tail -c 1 "$target_config")" ]; then
        printf "\n\n" >> "$target_config"
      else
        printf "\n" >> "$target_config"
      fi
    fi
  fi
  cat "$SERENA_MCP_CONFIG_SNIPPET" >> "$target_config"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  main "$@"
  return $?
fi

main "$@"
exit $?
