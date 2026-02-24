from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable

DEFAULT_EXTENSIONS = {
    ".py",
    ".html",
    ".htm",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".jsx",
    ".tsx",
    ".json",
    ".jsonc",
    ".txt",
    ".md",
    ".css",
    ".scss",
    ".less",
    ".sass",
    ".xml",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".cfg",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".bat",
    ".cmd",
    ".ps1",
    ".sql",
    ".graphql",
    ".gql",
    ".java",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".go",
    ".rs",
    ".php",
    ".rb",
    ".swift",
    ".kt",
    ".kts",
    ".dart",
    ".vue",
    ".svelte",
    ".jl",
    ".qss",
}

SPECIAL_FILENAMES = {
    "Dockerfile",
    "dockerfile",
    "Makefile",
    "makefile",
    "CMakeLists.txt",
}

EXCLUDED_FILENAME_PATTERN = re.compile(r"^\.env(\..+)?$", re.IGNORECASE)

FENCE_LANGUAGE_MAP = {
    ".py": "python",
    ".html": "html",
    ".htm": "html",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".jsx": "jsx",
    ".tsx": "tsx",
    ".json": "json",
    ".jsonc": "json",
    ".txt": "text",
    ".md": "markdown",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".sass": "sass",
    ".xml": "xml",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".env": "bash",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "zsh",
    ".fish": "fish",
    ".bat": "bat",
    ".cmd": "bat",
    ".ps1": "powershell",
    ".sql": "sql",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".java": "java",
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".dart": "dart",
    ".vue": "vue",
    ".svelte": "svelte",
    ".jl": "julia",
    ".qss": "css",
}

IGNORE_DIR_NAMES = {
    ".git",
    ".idea",
    ".vscode",
    "node_modules",
    ".venv",
    "venv",
    "env",
    ".env",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    ".next",
}

ENCODINGS_TO_TRY = ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1")


def is_source_file(path: Path) -> bool:
    if not path.is_file():
        return False

    # 기본적으로 민감정보 가능성이 높은 .env 계열 파일 제외
    if EXCLUDED_FILENAME_PATTERN.match(path.name):
        return False

    if path.name in SPECIAL_FILENAMES:
        return True

    suffix = path.suffix.lower()
    if suffix in DEFAULT_EXTENSIONS:
        return True

    # 확장자 없이 .env처럼 시작하는 파일 대응
    if path.name.startswith(".") and path.name.lower() in DEFAULT_EXTENSIONS:
        return True

    return False


def iter_relevant_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if path.is_dir() and path.name in IGNORE_DIR_NAMES:
            continue
        if any(part in IGNORE_DIR_NAMES for part in path.parts):
            continue
        if is_source_file(path):
            files.append(path)
    return sorted(files, key=lambda p: p.relative_to(root).as_posix().lower())


def build_tree_lines(current: Path, root: Path, prefix: str = "") -> list[str]:
    entries = [
        p
        for p in sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        if not any(part in IGNORE_DIR_NAMES for part in p.relative_to(root).parts)
    ]

    lines: list[str] = []
    for index, entry in enumerate(entries):
        is_last = index == len(entries) - 1
        branch = "`-- " if is_last else "|-- "
        lines.append(f"{prefix}{branch}{entry.name}")
        if entry.is_dir():
            extension = "    " if is_last else "|   "
            lines.extend(build_tree_lines(entry, root, prefix + extension))
    return lines


def detect_language(path: Path) -> str:
    if path.name in SPECIAL_FILENAMES:
        if "docker" in path.name.lower():
            return "dockerfile"
        if "makefile" in path.name.lower():
            return "makefile"
        if path.name == "CMakeLists.txt":
            return "cmake"

    return FENCE_LANGUAGE_MAP.get(path.suffix.lower(), "text")


def read_text(path: Path) -> str:
    for encoding in ENCODINGS_TO_TRY:
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    # 마지막 방어: 깨진 문자는 치환
    return path.read_text(encoding="utf-8", errors="replace")


def sanitize_output_name(input_path: str) -> str:
    cleaned = input_path.strip().rstrip("/\\")
    if not cleaned:
        cleaned = "output"
    sanitized = re.sub(r"[<>:\"/\\|?*]", "_", cleaned)
    sanitized = sanitized.replace(" ", "_")
    return f"{sanitized}.md"


def serialize_codebase(target_dir: Path, output_path: Path) -> None:
    files = iter_relevant_files(target_dir)

    lines: list[str] = []
    lines.append(f"# Source Snapshot: {target_dir}")
    lines.append("")
    lines.append("## Directory Structure")
    lines.append("")
    lines.append("```text")
    lines.append(target_dir.name)
    lines.extend(build_tree_lines(target_dir, target_dir))
    lines.append("```")
    lines.append("")
    lines.append("## Files")
    lines.append("")

    for file_path in files:
        rel = file_path.relative_to(target_dir).as_posix()
        lang = detect_language(file_path)
        content = read_text(file_path).rstrip("\n")

        lines.append(f"### {rel}")
        lines.append("")
        lines.append(f"```{lang}")
        if content:
            lines.append(content)
        lines.append("```")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="지정한 폴더의 소스코드를 수집해 Markdown 파일로 저장합니다."
    )
    parser.add_argument("folder", help="수집할 폴더 경로")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    target_dir = Path(args.folder).expanduser().resolve()

    if not target_dir.exists():
        raise FileNotFoundError(f"폴더를 찾을 수 없습니다: {target_dir}")
    if not target_dir.is_dir():
        raise NotADirectoryError(f"디렉토리가 아닙니다: {target_dir}")

    output_name = sanitize_output_name(args.folder)
    output_path = Path.cwd() / output_name
    serialize_codebase(target_dir, output_path)

    print(f"완료: {output_path}")


if __name__ == "__main__":
    main()
