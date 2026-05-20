import ast
import re
import builtins

_BUILTINS: set[str] = set(dir(builtins))

# ── Роутинг по языкам ─────────────────────────────────────────────────────────
# Чтобы добавить новый язык — напиши _validate_<lang>_block и зарегистрируй здесь
_VALIDATORS: dict[str, callable] = {
    "python": None,  # заполняется после определения функции
}


def validate_code_blocks(text: str) -> tuple[bool, list[str]]:
    """
    Ищет все ```<lang> блоки в тексте.
    Для известных языков запускает соответствующий валидатор.
    Неизвестные языки пропускает.
    Никогда не бросает исключений наружу.
    """
    try:
        pattern = r"```(\w+)\s*\n(.*?)```"
        blocks = re.findall(pattern, text, re.DOTALL)

        if not blocks:
            return True, []

        errors: list[str] = []
        for i, (lang, block) in enumerate(blocks, 1):
            validator = _VALIDATORS.get(lang.lower())
            if validator is None:
                continue  # язык не зарегистрирован — пропускаем
            try:
                block_errors = validator(block, i)
                errors.extend(block_errors)
            except Exception:
                pass  # ошибка в самом валидаторе — не ломаем пайплайн

        return len(errors) == 0, errors

    except Exception:
        return True, []


# ── Python валидатор ──────────────────────────────────────────────────────────

def _validate_python_block(block: str, block_num: int) -> list[str]:
    errors: list[str] = []

    # 1. Синтаксис
    try:
        tree = ast.parse(block)
    except SyntaxError as e:
        errors.append(f"Блок {block_num}: строка {e.lineno} — {e.msg}")
        return errors  # дальше не анализируем сломанный блок

    # 2. Неимпортированные имена
    try:
        undefined = _find_undefined_names(tree)
        if undefined:
            errors.append(
                f"Блок {block_num}: используется без импорта — "
                f"{', '.join(sorted(undefined))}"
            )
    except Exception:
        pass  # анализ импортов некритичен

    return errors


def _find_undefined_names(tree: ast.Module) -> set[str]:
    defined: set[str] = set(_BUILTINS)
    used: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name.split(".")
                defined.add(name)

        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name
                defined.add(name)

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defined.add(node.name)
            for arg in node.args.args:
                defined.add(arg.arg)

        elif isinstance(node, ast.ClassDef):
            defined.add(node.name)

        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    defined.add(target.id)

        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            if isinstance(node.target, ast.Name):
                defined.add(node.target.id)

        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            used.add(node.id)

    return used - defined


# Регистрируем после определения
_VALIDATORS["python"] = _validate_python_block

# ── Заглушки для будущих языков ───────────────────────────────────────────────
# def _validate_js_block(block: str, block_num: int) -> list[str]: ...
# _VALIDATORS["javascript"] = _validate_js_block
# _VALIDATORS["js"] = _validate_js_block

# def _validate_bash_block(block: str, block_num: int) -> list[str]: ...
# _VALIDATORS["bash"] = _validate_bash_block