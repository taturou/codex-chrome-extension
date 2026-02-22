#!/usr/bin/env python3
"""
目的:
    `.devenv/config.toml` の `[serena].ignored_paths` を読み取り、
    `.serena/project.yml` の `ignored_paths` に追記・同期します。

使用方法:
    1) リポジトリルートで実行
       python3 .devenv/serena/update_serena_config.py
    2) `.serena/project.yml` の `ignored_paths` が更新されます
       - 既存値は保持
       - 新規値を追加
       - 重複は削除
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib  # type: ignore


ROOT = Path(__file__).resolve().parents[2]
CONFIG_TOML = ROOT / ".devenv" / "config.toml"
PROJECT_YML = ROOT / ".serena" / "project.yml"


def read_paths_from_config(config_path: Path) -> list[str]:
    # TOML から serena.ignored_paths を読み取ります。
    # 想定フォーマット:
    # [serena]
    # ignored_paths = ["path/a", "path/b"]
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    serena = data.get("serena", {})
    ignored_paths = serena.get("ignored_paths", [])

    # 型崩れを早期検知して、壊れた設定のまま書き込みしないようにします。
    if not isinstance(ignored_paths, list):
        raise ValueError("[serena].ignored_paths must be an array")

    # 空文字・非文字列を除外し、順序を維持したまま重複を除去します。
    result: list[str] = []
    for value in ignored_paths:
        if isinstance(value, str) and value and value not in result:
            result.append(value)
    return result


def parse_yaml_scalar_list(raw: str) -> list[str]:
    # `ignored_paths: []` や `ignored_paths: ["a", "b"]` のような
    # インライン配列表現をパースします。
    raw = raw.strip()
    if not raw:
        return []
    try:
        parsed = ast.literal_eval(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [v for v in parsed if isinstance(v, str)]


def parse_yaml_block_list(lines: list[str]) -> list[str]:
    # 次のようなブロック配列表現をパースします。
    # ignored_paths:
    #   - "a"
    #   - "b"
    #
    # コメント付き行（例: - "a" # note）にも対応します。
    values: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        item = stripped[1:].strip()
        if not item:
            continue
        if item.startswith('"') or item.startswith("'"):
            try:
                parsed = ast.literal_eval(item)
                if isinstance(parsed, str):
                    values.append(parsed)
                    continue
            except Exception:
                pass
        values.append(item.split(" #", 1)[0].strip())
    return values


def dump_yaml_block(key_indent: str, key: str, values: list[str]) -> list[str]:
    # `ignored_paths` を YAML のブロックリスト形式で出力します。
    # 値が空の場合は `ignored_paths: []` の1行形式で出力します。
    if not values:
        return [f"{key_indent}{key}: []\n"]
    out = [f"{key_indent}{key}:\n"]
    for value in values:
        out.append(f"{key_indent}  - {json.dumps(value, ensure_ascii=False)}\n")
    return out


def merge_ignored_paths(project_path: Path, new_paths: list[str]) -> bool:
    # project.yml 全体を行単位で扱い、ignored_paths セクションのみを安全に差し替えます。
    # YAML 全体を厳密パースしない設計にすることで、
    # コメントや並び順など既存の可読性を保ちます。
    text = project_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    # `ignored_paths:` の定義位置を特定します。
    # 末尾側に別の同名キーがあるケースは想定せず、最初の一致を採用します。
    key_pattern = re.compile(r"^(\s*)ignored_paths:\s*(.*)$")
    idx = -1
    key_indent = ""
    inline_value = ""
    for i, line in enumerate(lines):
        match = key_pattern.match(line.rstrip("\n"))
        if match:
            idx = i
            key_indent = match.group(1)
            inline_value = match.group(2).strip()
            break

    # キー自体がない場合は末尾に新規追加します。
    if idx == -1:
        merged = list(dict.fromkeys(new_paths))
        block = dump_yaml_block("", "ignored_paths", merged)
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.extend(block)
        project_path.write_text("".join(lines), encoding="utf-8")
        return True

    key_indent_len = len(key_indent)
    end = idx + 1
    # ignored_paths セクションの終端を見つけます。
    # 同じインデント以下の非空行が出たら次のキーに入ったと判断します。
    while end < len(lines):
        line = lines[end]
        # ignored_paths の直後の空行はセクション外として扱い、書き戻し時に保持します。
        if not line.strip():
            break
        leading = len(line) - len(line.lstrip(" "))
        if leading > key_indent_len:
            end += 1
            continue
        # 旧バージョンの誤出力（キーと同インデントの `- item`）を吸収します。
        if line.startswith(f"{key_indent}- "):
            end += 1
            continue
        break

    # 既存値（インライン + ブロック）を読み取り、新規値を後ろに連結して重複除去します。
    # 先勝ち（先に出たものを優先）で順序を保持します。
    existing: list[str] = []
    if inline_value:
        existing.extend(parse_yaml_scalar_list(inline_value))
    existing.extend(parse_yaml_block_list(lines[idx + 1 : end]))

    merged = list(dict.fromkeys([*existing, *new_paths]))
    replacement = dump_yaml_block(key_indent, "ignored_paths", merged)

    updated = lines[:idx] + replacement + lines[end:]
    if updated == lines:
        return False
    project_path.write_text("".join(updated), encoding="utf-8")
    return True


def main() -> int:
    # 1. config.toml から追加対象パスを取得
    # 2. project.yml の ignored_paths にマージ
    # 3. 変更有無を標準出力に表示
    if not PROJECT_YML.exists():
        return 0

    new_paths = read_paths_from_config(CONFIG_TOML)
    changed = merge_ignored_paths(PROJECT_YML, new_paths)
    print("updated" if changed else "no changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
