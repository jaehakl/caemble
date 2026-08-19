from __future__ import annotations

import ast
from dataclasses import dataclass


@dataclass(frozen=True)
class PythonDiagnostic:
    code: str
    message: str
    line: int | None = None
    column: int | None = None

    def as_dict(self) -> dict[str, object]:
        value: dict[str, object] = {"code": self.code, "message": self.message}
        if self.line is not None:
            value["line"] = self.line
        if self.column is not None:
            value["column"] = self.column
        return value


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
    "abs",
    "bool",
    "enumerate",
    "float",
    "int",
    "len",
    "max",
    "min",
    "range",
    "round",
    "str",
    "sum",
    "tuple",
    "zip",
}
_SIM_METHODS = {"run", "record", "release"}
_RESERVED_NAMES = {*_ALLOWED_BUILTINS, "sim", "tasks", "vars"}


def validate_simulation_source(source: str) -> list[PythonDiagnostic]:
    if not source.strip():
        return [PythonDiagnostic("python_source_required", "Python simulation source is required")]
    try:
        tree = ast.parse(source, filename="simulate.py", mode="exec")
    except SyntaxError as error:
        return [
            PythonDiagnostic(
                "python_syntax_error",
                error.msg,
                line=error.lineno,
                column=error.offset,
            )
        ]
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.AsyncFunctionDef):
        return [
            PythonDiagnostic(
                "python_entrypoint",
                "Source must contain exactly one async simulate function",
            )
        ]
    function = tree.body[0]
    if function.name != "simulate" or function.decorator_list:
        return [
            PythonDiagnostic(
                "python_entrypoint",
                "Entrypoint must be an undecorated async simulate function",
                line=function.lineno,
                column=function.col_offset + 1,
            )
        ]
    args = function.args
    if (
        args.posonlyargs
        or args.args
        or args.vararg
        or args.kwarg
        or [arg.arg for arg in args.kwonlyargs] != ["sim", "tasks", "vars"]
        or any(default is not None for default in args.kw_defaults)
    ):
        return [
            PythonDiagnostic(
                "python_signature",
                "Entrypoint signature must be async def simulate(*, sim, tasks, vars)",
                line=function.lineno,
                column=function.col_offset + 1,
            )
        ]

    for node in ast.walk(tree):
        diagnostic = _validate_node(node)
        if diagnostic is not None:
            return [diagnostic]
    try:
        compile(tree, "simulate.py", "exec")
    except Exception:
        return [PythonDiagnostic("python_compile_error", "Python simulation source could not be compiled")]
    return []


def _validate_node(node: ast.AST) -> PythonDiagnostic | None:
    line = getattr(node, "lineno", None)
    column = getattr(node, "col_offset", None)
    column = column + 1 if isinstance(column, int) else None
    if type(node) not in _ALLOWED_NODES:
        return PythonDiagnostic(
            "python_construct_not_allowed",
            f"Python construct {type(node).__name__} is not allowed",
            line,
            column,
        )
    if isinstance(node, ast.Assign):
        for target in node.targets:
            error = _assignment_error(target)
            if error:
                return PythonDiagnostic("python_assignment_not_allowed", error, line, column)
    if isinstance(node, ast.AnnAssign):
        error = _assignment_error(node.target)
        if error:
            return PythonDiagnostic("python_assignment_not_allowed", error, line, column)
    if isinstance(node, (ast.For, ast.AsyncFor)):
        error = _assignment_error(node.target, allow_unpacking=True)
        if error:
            return PythonDiagnostic("python_assignment_not_allowed", error, line, column)
    if isinstance(node, ast.Name) and node.id.startswith("_"):
        return PythonDiagnostic("python_private_name", "Private names are not allowed", line, column)
    if isinstance(node, ast.Attribute):
        if node.attr.startswith("_"):
            return PythonDiagnostic("python_private_attribute", "Private attributes are not allowed", line, column)
        if not isinstance(node.value, ast.Name) or node.value.id != "sim" or node.attr not in _SIM_METHODS:
            return PythonDiagnostic(
                "python_attribute_not_allowed",
                "Only direct sim.run/record/release attributes are allowed",
                line,
                column,
            )
    if isinstance(node, ast.Call):
        error = _call_error(node)
        if error:
            return PythonDiagnostic("python_call_not_allowed", error, line, column)
    return None


def _assignment_error(node: ast.expr, *, allow_unpacking: bool = False) -> str | None:
    if isinstance(node, ast.Name):
        if node.id in _RESERVED_NAMES:
            return f"Assignment to reserved name {node.id} is not allowed"
        return None
    if allow_unpacking and isinstance(node, (ast.List, ast.Tuple)):
        for item in node.elts:
            error = _assignment_error(item, allow_unpacking=True)
            if error:
                return error
        return None
    return "Assignment targets must be local names"


def _call_error(node: ast.Call) -> str | None:
    function = node.func
    if isinstance(function, ast.Name):
        return None if function.id in _ALLOWED_BUILTINS else f"Call to {function.id} is not allowed"
    if (
        isinstance(function, ast.Attribute)
        and isinstance(function.value, ast.Name)
        and function.value.id == "sim"
        and function.attr in _SIM_METHODS
    ):
        return None
    return "Only approved builtins and sim.run/record/release may be called"
