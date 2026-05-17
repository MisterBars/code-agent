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
            all_outputs.append(f"{step.title}: {result.output}")
            logger.info(f"[Orchestrator] Шаг '{step.title}' выполнен.")

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
            current_steps = new_plan.steps[:MAX_STEPS] + current_steps

        elif result.status == "failed":
            logger.warn(f"[Orchestrator] Шаг '{step.title}' завершился с ошибкой: {result.error}")
            all_outputs.append(f"{step.title}: ОШИБКА — {result.error}")

    # ── Шаг 3: Финальный ответ ────────────────────────────────
    final = "\n".join(all_outputs) if all_outputs else "Задача выполнена."
    _store(conv_id, "orchestrator", final)
    logger.info(f"[Orchestrator] Готово. Шагов: {steps_completed}, переплан: {replans}.")

    return OrchestratorResult(
        success=True,
        final_answer=final,
        steps_completed=steps_completed,
        replans=replans,
        messages_used=iterations,
    )


def _store(conv_id: str, role: str, content: str):
    """Безопасно сохраняет сообщение в ConversationStore."""
    if conv_id:
        try:
            append_message(conv_id, role, content)
        except Exception:
            pass