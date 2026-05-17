"""
Orchestrator — главный координатор multi-agent архитектуры.
Управляет циклом: PlannerAgent → WorkerAgent → replan при необходимости.
"""
import uuid

from config import MAX_REPLANS, MAX_STEPS, MAX_ITERATIONS
from modules import logger
from modules.conversation_store import append_message
from classes.types import UserTask, OrchestratorResult
from classes import planner_agent, worker_agent


def run(task: UserTask, context: dict = None) -> OrchestratorResult:
    """
    Запускает полный цикл решения задачи.
    context: {"conversation_id": str, "history": [...], "retrieval": [...]}
    """
    context = context or {}
    conv_id = context.get("conversation_id")
    replans = 0
    steps_completed = 0
    iterations = 0
    all_outputs = []

    # Записываем задачу пользователя
    _store(conv_id, "user", task.text)
    logger.separator(f"Orchestrator: {task.text[:40]}")

    # ── Шаг 1: Планирование ───────────────────────────────────
    plan = planner_agent.plan(task, context)
    _store(conv_id, "planner", f"[ПЛАН] {plan.goal}\n" + "\n".join(
        f"  {i+1}. {s.title}" for i, s in enumerate(plan.steps)
    ))

    # Если planner сразу дал ответ — возвращаем без worker
    if plan.done:
        logger.info("[Orchestrator] Planner ответил напрямую.")
        _store(conv_id, "orchestrator", plan.reasoning_summary)
        return OrchestratorResult(
            success=True,
            final_answer=plan.reasoning_summary,
            steps_completed=0,
            replans=0,
            messages_used=1,
        )

    # ── Шаг 2: Выполнение шагов ───────────────────────────────
    current_steps = plan.steps[:MAX_STEPS]
    goal = plan.goal

    while current_steps and iterations < MAX_ITERATIONS:
        step = current_steps.pop(0)
        iterations += 1

        result = worker_agent.solve_subtask(step, context)
        _store(conv_id, "worker", f"[{step.title}] {result.output}")

        if result.status == "done":
            steps_completed += 1
            output_text = _normalize_output(result.output)
            if output_text:
                all_outputs.append(output_text)
            logger.info(...)

        elif result.status == "needs_replan":
            replans += 1
            logger.warn(f"[Orchestrator] Шаг '{step.title}' требует перепланирования ({replans}/{MAX_REPLANS}).")

            if replans >= MAX_REPLANS:
                msg = f"Достигнут лимит перепланирования ({MAX_REPLANS}). Остановлено."
                logger.error(f"[Orchestrator] {msg}")
                return OrchestratorResult(
                    success=False,
                    final_answer=msg,
                    steps_completed=steps_completed,
                    replans=replans,
                    messages_used=iterations,
                )

            new_plan = planner_agent.replan(step.step_id, result.reason or "", goal, context)
            _store(conv_id, "planner", f"[ПЕРЕПЛАН] {new_plan.goal}")
            all_outputs.clear()
            current_steps = new_plan.steps[:MAX_STEPS] + current_steps

        elif result.status == "failed":
            logger.warn(f"[Orchestrator] Шаг '{step.title}' завершился с ошибкой: {result.error}")
            if result.output.strip():
                all_outputs.append(result.output.strip())

    # ── Шаг 3: Финальный ответ ────────────────────────────────
    # Фильтруем пустые строки и собираем осмысленный ответ
    non_empty = [o for o in all_outputs if o.strip() and not o.endswith(": ")]
    if non_empty:
        final = "\n\n".join(non_empty)
    else:
        final = "Задача выполнена, но агент не вернул текстовый ответ."
    _store(conv_id, "orchestrator", final)
    logger.info(f"[Orchestrator] Готово. Шагов: {steps_completed}, переплан: {replans}.")

    return OrchestratorResult(
        success=True,
        final_answer=final,
        steps_completed=steps_completed,
        replans=replans,
        messages_used=iterations,
    )

def _normalize_output(output) -> str:
    """Приводит output любого типа к читаемой строке."""
    if not output:
        return ""
    if isinstance(output, str):
        return output.strip()
    if isinstance(output, list):
        # Список строк → через перенос
        parts = []
        for item in output:
            if isinstance(item, dict):
                # {"method": "append()", "description": "..."} → "append() — ..."
                if "method" in item and "description" in item:
                    parts.append(f"- {item['method']} — {item['description']}")
                elif "example" in item and "description" in item:
                    parts.append(f"- {item['example']}: {item['description']}")
                else:
                    parts.append(str(item))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    if isinstance(output, dict):
        # Вложенный dict — рекурсивно собираем значения
        return "\n".join(str(v) for v in output.values() if v)
    return str(output)

def _store(conv_id: str, role: str, content: str):
    """Безопасно сохраняет сообщение в ConversationStore."""
    if conv_id:
        try:
            append_message(conv_id, role, content)
        except Exception:
            pass