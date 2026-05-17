"""
PlannerAgent — агент-планировщик.
Получает UserTask → анализирует → возвращает PlanResult со списком PlanStep.
При needs_replan от worker — перепланирует на основе feedback.
"""
import json
import uuid

from modules import ollama_client, logger
from classes.types import UserTask, PlanResult, PlanStep, WorkerResult


SYSTEM_PROMPT = """Ты — агент-планировщик. Твоя задача — разобрать задачу пользователя и разбить её на конкретные подзадачи.

Правила:
- Каждая подзадача должна быть атомарной и выполнимой отдельно
- Если задача простая и не требует разбивки — выполни её сам и поставь done: true
- Возвращай ТОЛЬКО валидный JSON, без пояснений и markdown
- Максимум 10 шагов

Формат ответа:
{
  "goal": "краткое описание цели",
  "done": false,
  "direct_answer": "",
  "steps": [
    {"step_id": "s1", "title": "...", "description": "...", "priority": 1}
  ]
}

Если done=true — заполни direct_answer и оставь steps пустым.
"""


def plan(task: UserTask, context: dict = None, model: str = None) -> PlanResult:
    """
    Строит план по задаче пользователя.
    context: {"history": [...], "retrieval": [...]}
    """
    context = context or {}
    prompt = _build_prompt(task.text, context)

    logger.info(f"[PlannerAgent] Планирую задачу: {task.text[:60]}")

    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT)
    return _parse_plan_result(raw)

def replan(step_id: str, feedback: str, original_goal: str,
           context: dict = None, model: str = None) -> PlanResult:
    """
    Перепланирует после возврата подзадачи от worker.
    """
    context = context or {}
    prompt = (
        f"Задача: {original_goal}\n\n"
        f"Шаг '{step_id}' не удалось выполнить.\n"
        f"Причина от worker: {feedback}\n\n"
        f"Перестрой план с учётом этой информации."
    )

    logger.info(f"[PlannerAgent] Перепланирование. Причина: {feedback[:60]}")

    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT)
    return _parse_plan_result(raw)


def _build_prompt(task_text: str, context: dict) -> str:
    parts = [f"Задача: {task_text}"]

    if context.get("retrieval"):
        parts.append("\nКонтекст из базы знаний:")
        for chunk in context["retrieval"][:3]:
            parts.append(f"- {chunk.get('text', '')[:200]}")

    if context.get("history"):
        parts.append("\nПоследние сообщения беседы:")
        for msg in context["history"][-4:]:
            parts.append(f"[{msg.get('role', '?')}]: {msg.get('content', '')[:100]}")

    return "\n".join(parts)


def _parse_plan_result(raw: str) -> PlanResult:
    """Парсит JSON-ответ LLM в PlanResult. При ошибке — возвращает fallback."""
    try:
        # Пробуем извлечь JSON из текста
        start = raw.find("{")
        end = raw.rfind("}") + 1
        data = json.loads(raw[start:end])

        steps = [
            PlanStep(
                step_id=s.get("step_id", str(uuid.uuid4())[:8]),
                title=s.get("title", ""),
                description=s.get("description", ""),
                priority=s.get("priority", 0),
            )
            for s in data.get("steps", [])
        ]

        return PlanResult(
            plan_id=str(uuid.uuid4())[:8],
            goal=data.get("goal", ""),
            steps=steps,
            reasoning_summary=data.get("direct_answer") or data.get("reasoning") or data.get("output") or "",
            done=data.get("done", False),
            needs_worker=not data.get("done", False),
        )

    except Exception as e:
        logger.warn(f"[PlannerAgent] Не удалось распарсить план: {e}. Возвращаю прямой ответ.")
        return PlanResult(
            plan_id=str(uuid.uuid4())[:8],
            goal="Прямой ответ",
            steps=[],
            reasoning_summary=raw,
            done=True,
            needs_worker=False,
        )