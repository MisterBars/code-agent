"""
PlannerAgent — агент-планировщик.
"""
import json
import uuid

from modules import ollama_client, logger
from classes.types import UserTask, PlanResult, PlanStep


SYSTEM_PROMPT = """Ты — агент-планировщик. Твоя задача — разобрать задачу и разбить её на конкретные подзадачи.

Правила:
- Каждая подзадача должна быть атомарной и выполнимой отдельно
- Подзадачи должны покрывать ТОЛЬКО текущую задачу — не выходи за её рамки
- Название шага должно быть КОНКРЕТНЫМ — не "Примеры использования X", а "Пример кода: запуск корутины через asyncio.run"
- Название шага должно однозначно говорить что нужно сделать: объяснить / показать код / сравнить / перечислить
- Если задача простая и не требует разбивки — выполни её сам и поставь done: true
- Возвращай ТОЛЬКО валидный JSON, без пояснений и markdown
- Максимум 5 шагов на один уровень — лучше меньше, но точнее

Формат ответа:
{
  "goal": "краткое описание цели",
  "done": false,
  "direct_answer": "",
  "steps": [
    {"step_id": "s1", "title": "Объяснить: что такое event loop в asyncio", "description": "...", "priority": 1},
    {"step_id": "s2", "title": "Показать код: базовая корутина с async/await", "description": "...", "priority": 2}
  ]
}

Если done=true — заполни direct_answer и оставь steps пустым.
"""

SYSTEM_PROMPT_SUBPLAN = """Ты — агент-планировщик. Тебе нужно разбить ОДИН конкретный шаг на подшаги.

ВАЖНО:
- Планируй ТОЛЬКО то, что относится к данному шагу — ничего лишнего
- Не включай задачи из родительского плана или соседних шагов
- Подшаги должны быть конкретными и атомарными
- Если шаг можно выполнить напрямую — поставь done: true и дай ответ
- Максимум 5 подшагов — лучше меньше, но точнее
- Возвращай ТОЛЬКО валидный JSON, без пояснений и markdown

Формат ответа:
{
  "goal": "краткое описание цели подшага",
  "done": false,
  "direct_answer": "",
  "steps": [
    {"step_id": "s1", "title": "...", "description": "...", "priority": 1}
  ]
}

Название каждого шага должно начинаться с действия:
- "Объяснить: ..." — для концепций
- "Показать код: ..." — для примеров
- "Сравнить: ..." — для сравнений
- "Перечислить: ..." — для списков
"""


def plan(task: UserTask, context: dict = None, model: str = None) -> PlanResult:
    context = context or {}
    prompt = _build_prompt(task.text, context)
    logger.info(f"[PlannerAgent] Планирую задачу: {task.text[:60]}")
    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT)
    return _parse_plan_result(raw)


def subplan(step_title: str, step_description: str, parent_goal: str,
            context: dict = None, model: str = None) -> PlanResult:
    # subplan не получает историю — только шаг и родительскую цель
    prompt = (
        f"Родительская цель: {parent_goal}\n\n"
        f"Шаг который нужно разбить: {step_title}\n"
        f"Описание шага: {step_description}\n\n"
        f"Разбей ТОЛЬКО этот шаг на конкретные подшаги (максимум 5). "
        f"Не включай ничего из родительской цели кроме того, "
        f"что напрямую относится к данному шагу."
    )
    # context передаём без history — только retrieval если есть
    clean_context = {"retrieval": (context or {}).get("retrieval", [])}

    logger.info(f"[PlannerAgent] Подплан для шага: {step_title[:60]}")
    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT_SUBPLAN)
    return _parse_plan_result(raw)


def replan(step_id: str, feedback: str, original_goal: str,
           context: dict = None, model: str = None) -> PlanResult:
    context = context or {}
    prompt = (
        f"Задача: {original_goal}\n\n"
        f"Шаг '{step_id}' не удалось выполнить.\n"
        f"Причина: {feedback}\n\n"
        f"Перестрой план ТОЛЬКО для этого шага с учётом причины."
    )
    logger.info(f"[PlannerAgent] Перепланирование. Причина: {feedback[:60]}")
    raw = ollama_client.ask(prompt, model=model, system=SYSTEM_PROMPT_SUBPLAN)
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
    try:
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