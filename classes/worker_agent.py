"""
WorkerAgent — агент-исполнитель.
Получает PlanStep → выполняет → возвращает WorkerResult.
Если задача слишком сложная — возвращает status=needs_replan.
"""
import json

from modules import ollama_client, logger
from classes.types import PlanStep, WorkerResult


SYSTEM_PROMPT = """Ты — агент-исполнитель. Твоя задача — выполнить конкретный шаг и дать полезный ответ.

Правила:
- Выполни шаг и напиши конкретный результат в поле output — объяснение, пример кода или данные
- Поле output НИКОГДА не должно быть пустым при status=done
- Если шаг требует разбивки на несколько независимых частей — верни needs_replan
- Не возвращай needs_replan если можешь дать хоть какой-то полезный ответ
- Возвращай ТОЛЬКО валидный JSON, без пояснений и markdown

Формат ответа:
{
  "status": "done",
  "output": "конкретный результат выполнения шага — текст, код или объяснение",
  "reason": ""
}
"""


def solve_subtask(step: PlanStep, context: dict = None, model: str = None) -> WorkerResult:
    """
    Выполняет подзадачу.
    context: {"history": [...], "retrieval": [...]}
    """
    context = context or {}
    prompt = _build_prompt(step, context)

    logger.info(f"[WorkerAgent] Выполняю шаг [{step.step_id}]: {step.title[:60]}")

    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT)
    return _parse_worker_result(raw, step.step_id)

def _build_prompt(step: PlanStep, context: dict) -> str:
    parts = [
        f"Шаг: {step.title}",
        f"Описание: {step.description}",
    ]

    if context.get("retrieval"):
        parts.append("\nКонтекст из базы знаний:")
        for chunk in context["retrieval"][:3]:
            parts.append(f"- {chunk.get('text', '')[:200]}")

    if context.get("history"):
        parts.append("\nПоследние сообщения беседы:")
        for msg in context["history"][-4:]:
            parts.append(f"[{msg.get('role', '?')}]: {msg.get('content', '')[:100]}")

    return "\n".join(parts)


def _parse_worker_result(raw: str, step_id: str) -> WorkerResult:
    """Парсит JSON-ответ LLM в WorkerResult. При ошибке — считает выполненным."""
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