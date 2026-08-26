from __future__ import annotations

import ast
import inspect
from collections.abc import Collection
from typing import Any

from app.errors import CaeError

_ALLOWED_NODES = {
    ast.Module,
    ast.AsyncFunctionDef,
    ast.arguments,
    ast.arg,
    ast.Return,
    ast.Assign,
    ast.AnnAssign,
    ast.Expr,
    ast.Await,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Store,
    ast.Constant,
    ast.Subscript,
    ast.Attribute,
    ast.Dict,
    ast.List,
    ast.Tuple,
    ast.keyword,
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.Compare,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Slice,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
    ast.Pass,
    ast.Break,
    ast.Continue,
}
_ALLOWED_BUILTINS = {
    "abs": abs,
    "bool": bool,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "max": max,
    "min": min,
    "range": range,
    "round": round,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}
_SIM_METHODS = {"run", "record", "release"}
_RESERVED_NAMES = {*_ALLOWED_BUILTINS, "sim", "tasks", "vars"}


def validate_and_load_simulate(
    source: str,
    *,
    task_names: Collection[str],
    recorded_names: Collection[str],
) -> Any:
    if not isinstance(source, str) or not source.strip():
        raise CaeError("invalid_program", "Python simulation source is required")
    try:
        tree = ast.parse(source, filename="simulate.py", mode="exec")
    except SyntaxError as exc:
        raise CaeError("invalid_program", f"Python syntax error: {exc.msg} at line {exc.lineno}") from exc
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.AsyncFunctionDef):
        raise CaeError("invalid_program", "source must contain exactly one async simulate function")
    function = tree.body[0]
    if function.name != "simulate" or function.decorator_list:
        raise CaeError("invalid_program", "entrypoint must be an undecorated async simulate function")
    args = function.args
    if (
        args.posonlyargs
        or args.args
        or args.vararg
        or args.kwarg
        or [arg.arg for arg in args.kwonlyargs] != ["sim", "tasks", "vars"]
        or any(default is not None for default in args.kw_defaults)
    ):
        raise CaeError(
            "invalid_program",
            "entrypoint signature must be async def simulate(*, sim, tasks, vars)",
        )
    for node in ast.walk(tree):
        if type(node) not in _ALLOWED_NODES:
            raise CaeError("invalid_program", f"Python construct {type(node).__name__} is not allowed")
        if isinstance(node, ast.Assign):
            for target in node.targets:
                _validate_assignment_target(target)
        if isinstance(node, ast.AnnAssign):
            _validate_assignment_target(node.target)
        if isinstance(node, (ast.For, ast.AsyncFor)):
            _validate_assignment_target(node.target, allow_unpacking=True)
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise CaeError("invalid_program", "private names are not allowed")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                raise CaeError("invalid_program", "private attributes are not allowed")
            if (
                not isinstance(node.value, ast.Name)
                or node.value.id != "sim"
                or node.attr not in _SIM_METHODS
            ):
                raise CaeError(
                    "invalid_program",
                    "only direct sim.run/record/release attributes are allowed",
                )
        if isinstance(node, ast.Call):
            _validate_call(node)
            if (
                isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "sim"
                and node.func.attr == "record"
            ):
                name_node = node.args[0] if node.args else next(
                    (keyword.value for keyword in node.keywords if keyword.arg == "name"),
                    None,
                )
                if (
                    isinstance(name_node, ast.Constant)
                    and name_node.value not in recorded_names
                ):
                    raise CaeError(
                        "invalid_program",
                        f"simulate.py line {node.lineno}: RecordedData "
                        f"{name_node.value!r} is not declared",
                    )
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == "tasks"
            and isinstance(node.slice, ast.Constant)
            and node.slice.value not in task_names
        ):
            raise CaeError(
                "invalid_program",
                f"simulate.py line {node.lineno}: task {node.slice.value!r} is not declared",
            )
    globals_dict = {"__builtins__": _ALLOWED_BUILTINS}
    locals_dict: dict[str, Any] = {}
    try:
        exec(compile(tree, "simulate.py", "exec"), globals_dict, locals_dict)
    except Exception as exc:
        raise CaeError("invalid_program", "Python simulation source could not be loaded") from exc
    simulate = locals_dict.get("simulate")
    if not inspect.iscoroutinefunction(simulate):
        raise CaeError("invalid_program", "simulate must be async")
    return simulate


def _validate_assignment_target(node: ast.expr, *, allow_unpacking: bool = False) -> None:
    if isinstance(node, ast.Name):
        if node.id in _RESERVED_NAMES:
            raise CaeError("invalid_program", f"assignment to reserved name {node.id} is not allowed")
        return
    if allow_unpacking and isinstance(node, (ast.List, ast.Tuple)):
        for item in node.elts:
            _validate_assignment_target(item, allow_unpacking=True)
        return
    raise CaeError("invalid_program", "assignment targets must be local names")


def _validate_call(node: ast.Call) -> None:
    function = node.func
    if isinstance(function, ast.Name):
        if function.id not in _ALLOWED_BUILTINS:
            raise CaeError("invalid_program", f"call to {function.id} is not allowed")
        return
    if (
        not isinstance(function, ast.Attribute)
        or not isinstance(function.value, ast.Name)
        or function.value.id != "sim"
        or function.attr not in _SIM_METHODS
    ):
        raise CaeError("invalid_program", "only approved builtins and sim.run/record/release may be called")
