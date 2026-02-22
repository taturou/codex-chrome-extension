#!/usr/bin/env python3
"""Generate .clangd from compile_commands.json files in the repository.

目的:
- リポジトリ内に複数存在する compile_commands.json から、
  clangd が参照する単一の `.clangd` を自動生成します。
- 各ソースファイルを適切な CompilationDatabase に割り当て、
  `If.PathMatch` を最小限の断片に圧縮します。
- ディレクトリ命名規則に依存せず、compile_commands の実データのみで動作します。

使い方:
1. 既定（リポジトリルートを自動判定し `.clangd` を上書き）
   python3 .devenv/clangd/generate_clangd.py
2. 出力先を明示
   python3 .devenv/clangd/generate_clangd.py --output /path/to/.clangd
3. `.devenv/config.toml` で除外を指定（任意）
   [clangd]
   # .clangd の CompileFlags.PathMatch 生成対象から除外するパス
   exclude_path = ["source/foo/generated", "source/bar/test"]
   # .clangd へ Index.Background: Skip を出力するパス
   background_skip_path = ["source/foo/third_party"]

出力:
- 生成先 `.clangd`
- 標準出力に統計情報（DB件数、断片数、競合数）
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
import tomllib


@dataclass
class TrieNode:
    # 1 パス要素を 1 ノードとして持つトライ木。
    # 子ノードを辿ることで "a/b/c.c" のような相対パスを表現する。
    children: Dict[str, "TrieNode"] = field(default_factory=dict)
    # このノードで終端となるファイルが属する compile database の集合。
    # 例: "source/foo.c" が dbA に属していれば、foo.c に対応するノードに dbA が入る。
    terminal_dbs: Set[str] = field(default_factory=set)
    # 部分木全体が単一 DB に収束するとき、その DB 名を保持する。
    # 複数 DB が混在する場合は None（= 圧縮不可）にする。
    label: Optional[str] = None


@dataclass
class NodeSelection:
    # .clangd の If.PathMatch へ出力する対象パス（repo-root からの相対パス）
    path: str
    # True: 単一ファイルの葉ノード, False: ディレクトリ相当（配下を含む）
    is_file_leaf: bool
    # path が対応する compile database キー（repo-root から見た DB ディレクトリ）
    db: str


def parse_args() -> argparse.Namespace:
    # スクリプト配置:
    #   <repo>/.devenv/clangd/generate_clangd.py
    # の想定なので、parents[2] で repo-root を得る。
    script_path = Path(__file__).resolve()
    default_repo_root = script_path.parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=default_repo_root,
        help=f"Repository root (default: {default_repo_root})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output .clangd path (default: <repo-root>/.clangd)",
    )
    return parser.parse_args()


def normalize_path_prefix(prefix: str) -> str:
    # プレフィックス比較を安定化するため、区切りを "/" に揃え、先頭 "/" を除去する。
    # 末尾は常に "/" で統一し、"a/b" と "a/b/" を同値として扱う。
    p = prefix.replace("\\", "/").lstrip("/")
    if p and not p.endswith("/"):
        p += "/"
    return p


def load_clangd_config(repo_root: Path) -> Tuple[List[str], List[str]]:
    # `.devenv/config.toml` から [clangd] 設定を読み込む。
    # - exclude_path:
    #   compile_commands 探索 / PathMatch 生成から除外するパス。
    #   ここに入れたファイルは DB 割当にも PathMatch にも現れない。
    # - background_skip_path:
    #   `.clangd` に `Index.Background: Skip` を出力するパス。
    #   ここに入れたファイルは clangd の背景インデックス対象外になる。
    #
    # 両者は意図的に独立:
    # - 「PathMatch には残すが、背景インデックスだけ止める」
    # - 「生成対象から除外するが、背景インデックス設定は別管理」
    # の両方に対応できるようにする。
    # 要件上、以下はいずれも非エラー扱い:
    # - ファイルが存在しない
    # - [clangd] セクションが存在しない
    config_path = repo_root / ".devenv" / "config.toml"
    if not config_path.exists():
        return [], []
    try:
        raw = config_path.read_bytes()
        data = tomllib.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        # 設定破損時でも生成処理を止めず、除外なしで継続する。
        return [], []
    if not isinstance(data, dict):
        return [], []
    clangd = data.get("clangd")
    if not isinstance(clangd, dict):
        return [], []

    exclude_path = clangd.get("exclude_path")
    exclude_values = exclude_path if isinstance(exclude_path, list) else []
    exclude_paths = [
        normalize_path_prefix(v)
        for v in exclude_values
        if isinstance(v, str) and v
    ]

    background_skip_path = clangd.get("background_skip_path")
    background_values = background_skip_path if isinstance(background_skip_path, list) else []
    background_skip_paths = [
        normalize_path_prefix(v)
        for v in background_values
        if isinstance(v, str) and v
    ]
    return exclude_paths, background_skip_paths


def is_excluded_path(rel_path: str, excluded_prefixes: Tuple[str, ...]) -> bool:
    # rel_path が excluded_prefixes のいずれか配下かを判定する。
    # path 区切り差異（Windows/Unix）吸収のため "/" に正規化して比較する。
    rel = rel_path.replace("\\", "/")
    for prefix in excluded_prefixes:
        # "a/b" と "a/b/" の両方を同値扱いするため、完全一致も許可する。
        if rel == prefix[:-1] or rel.startswith(prefix):
            return True
    return False


def discover_compile_commands(repo_root: Path, excluded_prefixes: Tuple[str, ...]) -> List[Path]:
    # リポジトリ配下の全 compile_commands.json を収集する。
    # sorted しておくことで、後続の処理結果を安定化させる。
    discovered: List[Path] = []
    for db in sorted(repo_root.rglob("compile_commands.json")):
        rel_db = db.relative_to(repo_root).as_posix()
        # まずは CLI/設定指定の除外を適用する。
        if is_excluded_path(rel_db, excluded_prefixes):
            continue
        discovered.append(db)
    return discovered


def resolve_entry_file(entry: dict, db_dir: Path) -> Optional[Path]:
    # compile_commands の 1 エントリから「実ファイル絶対パス」を解決する。
    # JSON 仕様上、file は相対/絶対の両方があり得るため両対応にする。
    file_value = entry.get("file")
    if not file_value:
        # 壊れたエントリは静かにスキップする。
        return None

    file_path = Path(file_value)
    if file_path.is_absolute():
        # strict=False にして、実ファイル未存在でも正規化だけ実施する。
        return file_path.resolve(strict=False)

    # 相対 file の基準は directory（あれば）を優先。
    # directory も相対パスの可能性があるため db_dir 基準で再解決する。
    directory_value = entry.get("directory")
    if directory_value:
        directory_path = Path(directory_value)
        if not directory_path.is_absolute():
            directory_path = (db_dir / directory_path).resolve(strict=False)
    else:
        directory_path = db_dir

    return (directory_path / file_path).resolve(strict=False)


def load_assignments(
    repo_root: Path,
    compile_dbs: List[Path],
    excluded_prefixes: Tuple[str, ...],
) -> Tuple[Dict[str, str], Dict[str, Set[str]]]:
    # 役割:
    # - compile_commands 群を横断し、`repo内ファイル -> DB候補集合` を構築する。
    # - 競合時は決定規則で 1 DB に落とし込み、最終割当を確定する。
    # - 併せて `DB -> repo内ファイル集合` も収集する。
    # file_to_dbs:
    #   "source/a.c" -> {"build/boardA", "build/boardB"} のように
    #   1 ファイルが複数 DB に現れる競合を保持する。
    file_to_dbs: Dict[str, Set[str]] = defaultdict(set)

    for db_path in compile_dbs:
        # 出力 .clangd の CompilationDatabase には repo-root 相対パスを使う。
        db_key = db_path.parent.relative_to(repo_root).as_posix()
        try:
            data = json.loads(db_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # 壊れた DB は無視して継続する（全体失敗にしない）。
            continue

        if not isinstance(data, list):
            continue

        for entry in data:
            if not isinstance(entry, dict):
                # 配列内に不正要素があっても継続する。
                continue
            resolved = resolve_entry_file(entry, db_path.parent)
            if resolved is None:
                continue
            try:
                rel = resolved.relative_to(repo_root).as_posix()
            except ValueError:
                # repo 外のファイルは .clangd の PathMatch 対象外なので除外する。
                continue
            if is_excluded_path(rel, excluded_prefixes):
                continue
            file_to_dbs[rel].add(db_key)

    assigned: Dict[str, str] = {}
    conflicts: Dict[str, Set[str]] = {}
    for rel_file, dbs in file_to_dbs.items():
        if len(dbs) > 1:
            # レポート用に競合情報を保持する（生成は継続）。
            conflicts[rel_file] = set(dbs)
        # 競合時は「長いパス優先、同長なら辞書順」で決定する。
        # より特化した build DB を優先し、広い DB への吸い込みを避ける。
        chosen = sorted(dbs, key=lambda p: (-len(p), p))[0]
        assigned[rel_file] = chosen

    return assigned, conflicts


def insert_path(root: TrieNode, path_parts: List[str], db: str) -> None:
    # "a/b/c.c" -> root["a"]["b"]["c.c"] の形でノードを作り、
    # 末端ノードに DB を記録する。
    node = root
    for part in path_parts:
        # ノードが無ければ作り、あれば再利用する。
        node = node.children.setdefault(part, TrieNode())
    node.terminal_dbs.add(db)


def annotate_labels(node: TrieNode) -> Optional[str]:
    # 下位ノードを再帰的に見て、
    # - 部分木全体が同じ DB ならその DB 名
    # - 混在していれば None
    # を付与する。
    #
    # "__MIXED__" は内部処理用の番兵値。
    labels: Set[str] = set(node.terminal_dbs)
    for child in node.children.values():
        child_label = annotate_labels(child)
        if child_label is None:
            labels.add("__MIXED__")
        else:
            labels.add(child_label)
    if len(labels) == 1:
        label = next(iter(labels))
        if label == "__MIXED__":
            node.label = None
        else:
            node.label = label
    else:
        node.label = None
    return node.label


def select_nodes(
    node: TrieNode,
    current_parts: List[str],
    parent_label: Optional[str],
) -> List[NodeSelection]:
    # 役割:
    # - トライ木から「PathMatchとして出力すべき境界ノード」を抽出する。
    # - 親と同じラベル(DB)は省略し、異なる境界のみ残す。
    # 親と同じラベルを持つノードは、親側でまとめて表現できるため出力しない。
    # 「親と異なるラベルの境界」だけを抜き出すことで PathMatch を最小化する。
    results: List[NodeSelection] = []
    if node.label is not None and node.label != parent_label:
        path = "/".join(current_parts)
        is_file_leaf = len(node.children) == 0
        results.append(NodeSelection(path=path, is_file_leaf=is_file_leaf, db=node.label))
        return results

    for part, child in sorted(node.children.items()):
        results.extend(select_nodes(child, current_parts + [part], node.label))
    return results


def regex_for_path(path: str, is_file_leaf: bool) -> str:
    # .clangd の If.PathMatch 用に正規表現化する。
    # - 葉ノード（単一ファイル）: 完全一致
    # - それ以外（ディレクトリ境界）: 配下すべて
    # 除外は PathExclude 側に寄せるため、ここでは PathMatch を最小化する。
    escaped = re.escape(path)
    if is_file_leaf:
        return f"^{escaped}$"
    return f"^{escaped}/.*"


def build_fragments(
    repo_root: Path,
    compile_dbs: List[Path],
    assignments: Dict[str, str],
) -> Dict[str, List[str]]:
    # 役割:
    # - 割当結果をトライ木に積んで圧縮し、DBごとの PathMatch 配列を構築する。
    trie = TrieNode()
    for rel_file, db in assignments.items():
        insert_path(trie, rel_file.split("/"), db)
    annotate_labels(trie)
    selections = select_nodes(trie, [], None)

    db_to_regexes: Dict[str, List[str]] = defaultdict(list)
    for sel in selections:
        db_to_regexes[sel.db].append(regex_for_path(sel.path, sel.is_file_leaf))

    # compile_commands.json は存在するが assignments に 1 件も現れない DB でも、
    # .clangd に最低 1 エントリは残す。
    for db_path in compile_dbs:
        db_key = db_path.parent.relative_to(repo_root).as_posix()
        if db_key in db_to_regexes:
            continue
        fallback = f"^{re.escape(db_key)}/.*"
        db_to_regexes[db_key].append(fallback)

    # 出力安定化:
    # - 重複除去
    # - より具体的な（長い）正規表現を先に並べる
    # - 同長は辞書順
    for db_key, regexes in list(db_to_regexes.items()):
        unique = sorted(set(regexes), key=lambda s: (-len(s), s))
        db_to_regexes[db_key] = unique

    # 安全弁:
    # 圧縮結果により除外配下へマッチする可能性は PathExclude で制御する。
    # そのため、ここではファイル単位へのフォールバックは行わない。

    return dict(sorted(db_to_regexes.items(), key=lambda kv: kv[0]))


def render_clangd(
    db_to_regexes: Dict[str, List[str]],
    conflicts: Dict[str, Set[str]],
    excluded_prefixes: Tuple[str, ...],
    background_skip_prefixes: Tuple[str, ...],
) -> str:
    # clangd のマルチドキュメント YAML 形式に変換する。
    # 1 DB につき 1 ドキュメントを作る。
    lines: List[str] = []
    lines.append("# This file is auto-generated by .devenv/clangd/generate_clangd.py")
    if conflicts:
        lines.append(f"# Conflicts: {len(conflicts)} files were found in multiple compile databases.")
        lines.append("# The generator selected one database deterministically per file.")
    lines.append("")

    first = True
    for prefix in background_skip_prefixes:
        if not first:
            lines.append("---")
        first = False
        escaped = re.escape(prefix[:-1] if prefix.endswith("/") else prefix)
        lines.append("If:")
        lines.append(f"  PathMatch: ^{escaped}/.*")
        lines.append("Index:")
        lines.append("  Background: Skip")

    for db, regexes in db_to_regexes.items():
        if not first:
            lines.append("---")
        first = False
        lines.append("If:")
        lines.append(f"  PathMatch: {'|'.join(regexes)}")
        if excluded_prefixes:
            ex_parts = []
            for prefix in excluded_prefixes:
                trimmed = prefix[:-1] if prefix.endswith("/") else prefix
                ex_parts.append(f"{re.escape(trimmed)}(?:/.*)?")
            lines.append(f"  PathExclude: ^(?:{'|'.join(ex_parts)})$")
        lines.append("CompileFlags:")
        lines.append(f"  CompilationDatabase: {db}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    # 1) 入力解決
    args = parse_args()
    repo_root = args.repo_root.resolve()
    output = args.output.resolve() if args.output else repo_root / ".clangd"
    config_excludes, config_background_skips = load_clangd_config(repo_root)
    excluded_prefixes = tuple(sorted(set(config_excludes)))
    background_skip_prefixes = tuple(sorted(set(config_background_skips)))

    # 2) compile_commands 一覧を収集
    compile_dbs = discover_compile_commands(repo_root, excluded_prefixes)
    if not compile_dbs:
        raise SystemExit("No compile_commands.json found.")

    # 3) file -> db 割当
    assignments, conflicts = load_assignments(repo_root, compile_dbs, excluded_prefixes)

    # 4) 最小 PathMatch 断片生成
    db_to_regexes = build_fragments(
        repo_root,
        compile_dbs,
        assignments,
    )

    # 5) .clangd YAML へレンダリングして書き込み
    content = render_clangd(
        db_to_regexes,
        conflicts,
        excluded_prefixes,
        background_skip_prefixes,
    )
    output.write_text(content, encoding="utf-8")

    # 6) 実行統計を出力（CIログや手元確認用）
    print(f"Generated: {output}")
    print(f"compile_commands.json files: {len(compile_dbs)}")
    print(f"PathMatch fragments: {len(db_to_regexes)}")
    print(f"Cross-database file conflicts: {len(conflicts)}")
    print(f"Excluded path prefixes: {len(excluded_prefixes)}")
    print(f"Background-index skip prefixes: {len(background_skip_prefixes)}")
    return 0


if __name__ == "__main__":
    # main の戻り値をプロセス終了コードとして返す。
    raise SystemExit(main())
