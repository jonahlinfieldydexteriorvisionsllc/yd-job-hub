"""Names a function reads BEFORE the line that binds them locally (an import,
an assignment, a loop variable). Python then treats the name as local for the
whole function, and the early read fails with UnboundLocalError -- as
inboxdesk.draft() did on 30 Oct 2026 (import voice, after calling voice()).

    python .claude/unbound.py functions/*.py      (prints nothing when clean)
"""
import ast, sys

def own_nodes(fn):
    """Nodes of fn, not of functions/classes/lambdas/comprehensions inside it."""
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        n = stack.pop()
        yield n
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            continue
        stack.extend(ast.iter_child_nodes(n))

def check(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        declared = set()
        bound = {}
        loads = []
        args = {a.arg for a in fn.args.args + fn.args.kwonlyargs + fn.args.posonlyargs}
        if fn.args.vararg: args.add(fn.args.vararg.arg)
        if fn.args.kwarg: args.add(fn.args.kwarg.arg)
        for n in own_nodes(fn):
            if isinstance(n, (ast.Global, ast.Nonlocal)):
                declared |= set(n.names)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                for a in n.names:
                    nm = (a.asname or a.name).split(".")[0]
                    bound[nm] = min(bound.get(nm, 10**9), n.lineno)
            elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                bound[n.id] = min(bound.get(n.id, 10**9), n.lineno)
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not fn:
                bound[n.name] = min(bound.get(n.name, 10**9), n.lineno)
            elif isinstance(n, ast.ExceptHandler) and n.name:
                bound[n.name] = min(bound.get(n.name, 10**9), n.lineno)
            elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                loads.append((n.lineno, n.id))
        for line, nm in loads:
            if nm in args or nm in declared or nm not in bound:
                continue
            if line < bound[nm]:
                out.append("%s:%d %s() reads %r before binding it on line %d" % (path, line, fn.name, nm, bound[nm]))
    return out

for p in sys.argv[1:]:
    for x in check(p):
        print(x)
