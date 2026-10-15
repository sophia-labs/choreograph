"""Trusted pure-Python ABI evaluator for Sophia Prime extension v1.

Candidate code is compiled only after a strict AST scan and executes with a
small builtins dictionary. Choreograph's enabled personal-evolution plane runs
this program inside a no-network bubblewrap evaluator sandbox; local cross-
platform tests additionally exercise the restricted interpreter directly.
"""

from __future__ import annotations

import ast
import json
import resource
import sys
from pathlib import Path
from typing import Any


SAFE_BUILTINS = {
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "Exception": Exception,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "ValueError": ValueError,
    "zip": zip,
}
SAFE_METHODS = {"copy", "count", "get", "index", "items", "keys", "lower", "strip", "upper", "values"}
DENIED_NODES = (
    ast.AsyncFunctionDef,
    ast.Await,
    ast.ClassDef,
    ast.Delete,
    ast.Global,
    ast.Import,
    ast.ImportFrom,
    ast.Lambda,
    ast.Nonlocal,
    ast.Raise,
    ast.Try,
    ast.With,
    ast.AsyncWith,
    ast.Yield,
    ast.YieldFrom,
)


def constrain_process() -> None:
    """Bound hostile CPU/memory/output even outside the production bwrap worker."""
    limits = (
        (resource.RLIMIT_CORE, 0, 0),
        (resource.RLIMIT_CPU, 5, 6),
        (resource.RLIMIT_FSIZE, 2 * 1024 * 1024, 2 * 1024 * 1024),
        (resource.RLIMIT_NOFILE, 32, 32),
        (resource.RLIMIT_AS, 256 * 1024 * 1024, 256 * 1024 * 1024),
    )
    for resource_id, soft, hard in limits:
        current_soft, current_hard = resource.getrlimit(resource_id)
        bounded_hard = hard if current_hard == resource.RLIM_INFINITY else min(hard, current_hard)
        bounded_soft = min(soft, bounded_hard)
        try:
            resource.setrlimit(resource_id, (bounded_soft, bounded_hard))
        except (OSError, ValueError):
            # macOS exposes RLIMIT_AS but rejects every finite value. Production
            # evaluation runs on Linux, where this limit is mandatory.
            if sys.platform != "darwin" or resource_id != resource.RLIMIT_AS:
                raise


class ContractScanner(ast.NodeVisitor):
    def __init__(self) -> None:
        self.issues: list[str] = []
        self.functions: set[str] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        if node.name.startswith("_"):
            self.issues.append(f"private-or-dunder-function:{node.name}")
        self.functions.add(node.name)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> Any:
        if node.id.startswith("__"):
            self.issues.append(f"dunder-name:{node.id}")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> Any:
        if node.attr.startswith("_") or node.attr not in SAFE_METHODS:
            self.issues.append(f"attribute-denied:{node.attr}")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> Any:
        if isinstance(node.func, ast.Name):
            if node.func.id not in SAFE_BUILTINS and node.func.id not in self.functions:
                self.issues.append(f"call-denied:{node.func.id}")
        elif isinstance(node.func, ast.Attribute):
            if node.func.attr not in SAFE_METHODS:
                self.issues.append(f"method-call-denied:{node.func.attr}")
        else:
            self.issues.append("indirect-call-denied")
        self.generic_visit(node)

    def generic_visit(self, node: ast.AST) -> Any:
        if isinstance(node, DENIED_NODES):
            self.issues.append(f"syntax-denied:{type(node).__name__}")
        return super().generic_visit(node)


def scan(path: Path) -> list[str]:
    try:
        tree = ast.parse(path.read_bytes(), filename=path.name)
    except SyntaxError as error:
        return [f"syntax-error:{error.lineno}:{error.offset}"]
    scanner = ContractScanner()
    scanner.visit(tree)
    return sorted(set(scanner.issues))


def execute(path: Path, function_name: str, input_value: Any) -> Any:
    issues = scan(path)
    if issues:
        raise ValueError("source failed contract scan: " + ",".join(issues))
    globals_: dict[str, Any] = {"__builtins__": SAFE_BUILTINS}
    exec(compile(path.read_bytes(), path.name, "exec"), globals_, globals_)
    function = globals_.get(function_name)
    if not callable(function):
        raise ValueError("entrypoint function is absent")
    return function(input_value)


def main() -> None:
    constrain_process()
    if len(sys.argv) < 3:
        raise SystemExit("usage: extension-evaluator.py scan|run PATH [FUNCTION INPUT_JSON]")
    mode = sys.argv[1]
    path = Path(sys.argv[2]).resolve(strict=True)
    if mode == "scan":
        print(json.dumps({"issues": scan(path)}, sort_keys=True, separators=(",", ":")))
        return
    if mode == "run" and len(sys.argv) == 5:
        value = execute(path, sys.argv[3], json.loads(sys.argv[4]))
        print(json.dumps({"output": value}, sort_keys=True, separators=(",", ":")))
        return
    raise SystemExit("invalid evaluator invocation")


if __name__ == "__main__":
    main()
