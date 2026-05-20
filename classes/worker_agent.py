"""
WorkerAgent — агент-исполнитель.
Получает PlanStep → выполняет → возвращает WorkerResult.
Если задача слишком сложная — возвращает needs_replan (только если depth < MAX_REPLAN_DEPTH).
Если depth >= MAX_REPLAN_DEPTH — отвечает сам с пометкой "требует уточнения".
"""
import json

from config import MAX_REPLAN_DEPTH
from modules import ollama_client, logger
from classes.types import PlanStep, WorkerResult
from modules.code_validator import validate_code_blocks


SYSTEM_PROMPT = """Ты — агент-исполнитель. Твоя задача — выполнить конкретный шаг максимально полно.

Правила качества ответа:
- Если шаг — объяснение концепции: дай определение + как работает внутри + зачем нужно + отличия от альтернатив. Минимум 5-6 предложений.
- Если шаг — пример кода: дай ПОЛНЫЙ рабочий код в ```python блоке, затем объясни каждую ключевую строку. Код должен быть актуальным (aiogram 3.x, Python 3.10+).
- Если шаг — сравнение: составь конкретный список отличий с примерами, не общие фразы.
- Если шаг — установка/настройка: дай конкретные команды и шаги.
- output при status=done НИКОГДА не должен быть короче 5 предложений (или содержать блок кода).
- needs_replan — ТОЛЬКО если шаг содержит 3+ независимых подтемы, каждая из которых сама по себе требует развёрнутого ответа.

ЗАПРЕЩЕНО:
- Писать "рассмотрим примеры" или "обратимся к коду" без самого примера/кода
- Писать "необходимо выполнить следующие шаги" и перечислять абстрактные пункты вместо конкретного ответа
- Использовать устаревший API (aiogram 2.x с executor/message_handler — устарел, используй aiogram 3.x)
- Писать `coroutine = async def func():` — это синтаксическая ошибка Python. Правильно: `async def func():`
- Писать `def handler(...):` без `async` если внутри есть `await`
- Давать ответ короче 5 предложений при status=done

Формат ответа — ТОЛЬКО валидный JSON без markdown вокруг:
{
  "status": "done",
  "output": "здесь полный ответ",
  "reason": ""
}

Язык ответа в output: русский.
Блоки кода внутри output оформляй в ```python ... ```.
"""

SYSTEM_PROMPT_MAX_DEPTH = """Ты — агент-исполнитель. Ты находишься на максимальной глубине анализа.

Правила:
- Ты ОБЯЗАН вернуть status=done — нельзя возвращать needs_replan
- Ответь насколько можешь, используя свои знания
- Если не можешь ответить полностью — ответь частично
- Возвращай ТОЛЬКО валидный JSON, без пояснений и markdown

Формат ответа:
{
  "status": "done",
  "output": "ответ по теме шага, насколько возможно",
  "reason": ""
}

Язык ответа: русский.
"""


def solve_subtask(step: PlanStep, context: dict = None, model: str = None) -> WorkerResult:
    context = context or {}
    at_max_depth = step.depth >= MAX_REPLAN_DEPTH

    system = SYSTEM_PROMPT_MAX_DEPTH if at_max_depth else SYSTEM_PROMPT
    prompt = _build_prompt(step, context, at_max_depth)

    logger.info(
        f"[WorkerAgent] Шаг [{step.step_id}] глубина={step.depth} "
        f"{'(макс. глубина)' if at_max_depth else ''}: {step.title[:60]}"
    )

    raw = ollama_client.ask(prompt, model=model, system=system)
    result = _parse_worker_result(raw, step.step_id)

    # ── Валидация кода в ответе ───────────────────────────────
    if result.status == "done" and result.output:
        valid, errors = validate_code_blocks(result.output)
        if not valid:
            logger.warn(
                f"[WorkerAgent] Шаг [{step.step_id}] содержит невалидный код: {errors}"
            )
            # error_note = "\n\n⚠️ *Внимание: в примере кода обнаружены синтаксические ошибки:*\n"
            # error_note += "\n".join(f"- {e}" for e in errors)
            # result = WorkerResult(
            #     step_id=result.step_id,
            #     status=result.status,
            #     output=result.output + error_note,
            #     error=result.error,
            #     reason=result.reason,
            # )
    # ─────────────────────────────────────────────────────────

    # На максимальной глубине принудительно запрещаем needs_replan
    if at_max_depth and result.status == "needs_replan":
        logger.warn(
            f"[WorkerAgent] Шаг [{step.step_id}] вернул needs_replan на макс. глубине — принудительно done."
        )
        output = result.output or result.reason or "Ответ требует дополнительного анализа."
        return WorkerResult(
            step_id=step.step_id,
            status="done",
            output=f"⚠️ *Требует уточнения* — {output}",
        )

    return result


def _build_prompt(step: PlanStep, context: dict, at_max_depth: bool = False) -> str:
    # Каждая часть — отдельная строка, join через \n
    parts = [
        f"Шаг: {step.title}",
        f"Описание: {step.description}",
    ]

    if step.depth > 0:
        parts.append(f"Уровень вложенности: {step.depth} из {MAX_REPLAN_DEPTH}")

    if at_max_depth:
        parts.append(
            "ВАЖНО: это максимальная глубина анализа. "
            "Отвечай насколько можешь — нельзя запросить дальнейшую разбивку."
        )

    if context.get("retrieval"):
        parts.append("\nКонтекст из базы знаний:")
        for chunk in context["retrieval"][:3]:
            parts.append(f"- {chunk.get('text', '')[:200]}")

    # История — только как справка о теме беседы, не как источник ответа
    if context.get("history"):
        last_msg = context["history"][-1].get("content", "")[:80]
        parts.append(f"\nСправка: беседа ведётся на тему — {last_msg}")
        parts.append(
            "ВАЖНО: отвечай строго по шагу выше. "
            "Не используй контекст беседы как источник ответа."
        )

    return "\n".join(parts)  # одинарный \n — корректный разделитель строк


def _parse_worker_result(raw: str, step_id: str) -> WorkerResult:
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        data = json.loads(raw[start:end])

        return WorkerResult(
            step_id=step_id,
            status=data.get("status", "done"),
            output=data.get("output", ""),
            error=data.get("error"),
            reason=data.get("reason"),
        )

    except Exception as e:
        logger.warn(f"[WorkerAgent] Не удалось распарсить ответ: {e}. Считаю done.")
        return WorkerResult(
            step_id=step_id,
            status="done",
            output=raw.strip(),
        )