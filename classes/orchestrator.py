"""
Orchestrator — главный координатор multi-agent архитектуры.
Управляет циклом: PlannerAgent → WorkerAgent → replan при необходимости.
"""
import uuid

from config import MAX_REPLAN_DEPTH, MAX_STEPS, MAX_ITERATIONS, DEFAULT_MODEL
from modules import logger
from modules.conversation_store import append_message
from classes.types import UserTask, OrchestratorResult
from classes import planner_agent, worker_agent
from modules import ollama_client as _ollama

def run(task: UserTask, context: dict = None) -> OrchestratorResult:
    context = context or {}
    conv_id     = context.get("conversation_id")
    model       = context.get("model", DEFAULT_MODEL)
    on_event    = context.get("on_event")
    should_stop = context.get("should_stop")          # ← лямбда () → bool или None
    replan_depth = 0        # текущая глубина ветвления
    total_replans = 0       # для статистики
    steps_completed = 0
    iterations  = 0
    all_outputs = []

    def emit(event_type: str, **data):
        if on_event:
            try:
                on_event(event_type, data)
            except Exception:
                pass

    def is_cancelled() -> bool:                       # ← вспомогательная функция
        return callable(should_stop) and should_stop()

    # Записываем задачу пользователя
    _store(conv_id, "user", task.text)
    logger.separator(f"Orchestrator: {task.text[:40]}")

    # ── Шаг 1: Планирование ───────────────────────────────────
    emit("planner_start", message="Планирую задачу...")
    plan = planner_agent.plan(task, context)

    plan_text = f"[ПЛАН] {plan.goal}\n" + "\n".join(
        f"  {i+1}. {s.title}" for i, s in enumerate(plan.steps)
    )
    _store(conv_id, "planner", plan_text)
    emit("planner_done", message=plan_text, steps_total=len(plan.steps))

    if plan.done:
        logger.info("[Orchestrator] Planner ответил напрямую.")
        msg_id = _store(conv_id, "orchestrator", plan.reasoning_summary, model=model)  # ← model
        emit("answer", message_id=msg_id, content=plan.reasoning_summary)
        return OrchestratorResult(
            success=True,
            final_answer=plan.reasoning_summary,
            message_id=msg_id,
            steps_completed=0,
            replans=0,
            messages_used=1,
        )

    # ── Шаг 2: Выполнение шагов ───────────────────────────────
    current_steps = plan.steps[:MAX_STEPS]
    goal = plan.goal

    while current_steps and iterations < MAX_ITERATIONS:

        # ── Проверка отмены ───────────────────────────────────  # ←
        if is_cancelled():                                         # ←
            logger.info("[Orchestrator] Задача отменена.")        # ←
            msg = "⏹ Задача остановлена."                        # ←
            msg_id = _store(conv_id, "orchestrator", msg)         # ←
            emit("answer", message_id=msg_id, content=msg, success=False)  # ←
            return OrchestratorResult(                             # ←
                success=False,                                     # ←
                final_answer=msg,                                  # ←
                message_id=msg_id,                                 # ←
                steps_completed=steps_completed,                   # ←
                replans=replans,                                   # ←
                messages_used=iterations,                         # ←
            )                                                      # ←

        step = current_steps.pop(0)
        iterations += 1

        emit("worker_start",
             step=iterations,
             steps_total=len(plan.steps),
             message=f"Шаг {iterations}: {step.title}")

        result = worker_agent.solve_subtask(step, context)
        _store(conv_id, "worker", f"[{step.title}] {result.output}")

        if result.status == "done":
            steps_completed += 1
            output_text = _normalize_output(result.output)
            if output_text:
                all_outputs.append(output_text)
            emit("worker_done",
                 step=iterations,
                 message=f"✓ {step.title}: {output_text[:120]}{'...' if len(output_text) > 120 else ''}")
            logger.info(f"[Orchestrator] Шаг '{step.title}' выполнен.")

        elif result.status == "needs_replan":
            replan_depth += 1
            total_replans += 1
            emit("replan",
                 step=iterations,
                 depth=replan_depth,
                 message=f"↺ Углубляюсь (глубина {replan_depth}/{MAX_REPLAN_DEPTH}): {result.reason or ''}...")

            if replan_depth >= MAX_REPLAN_DEPTH:
                # Не останавливаемся — пробуем ответить сами с пометкой
                partial = "\n\n".join(o for o in all_outputs if o.strip())
                msg = (
                    f"{partial}\n\n"
                    f"⚠️ *Требует уточнения* — достигнута максимальная глубина анализа ({MAX_REPLAN_DEPTH}). "
                    f"Часть задачи может быть решена не полностью."
                ) if partial else (
                    f"⚠️ *Требует уточнения* — не удалось найти решение за {MAX_REPLAN_DEPTH} уровня анализа."
                )
                msg_id = _store(conv_id, "orchestrator", msg, model=model)
                emit("answer", message_id=msg_id, content=msg, success=False, needs_clarification=True)
                return OrchestratorResult(
                    success=False,
                    final_answer=msg,
                    message_id=msg_id,
                    steps_completed=steps_completed,
                    replans=total_replans,
                    messages_used=iterations,
                )

            new_plan = planner_agent.replan(step.step_id, result.reason or "", goal, context)
            _store(conv_id, "planner", f"[ПЕРЕПЛАН глубина {replan_depth}] {new_plan.goal}")
            emit("planner_done",
                 message=f"[ПЕРЕПЛАН глубина {replan_depth}] {new_plan.goal}",
                 steps_total=len(new_plan.steps))
            # НЕ чистим all_outputs — сохраняем уже собранный контекст
            current_steps = new_plan.steps[:MAX_STEPS] + current_steps

        elif result.status == "failed":
            logger.warn(f"[Orchestrator] Шаг '{step.title}' завершился с ошибкой: {result.error}")
            emit("worker_done",
                 step=iterations,
                 message=f"✗ {step.title}: {result.error or 'ошибка'}",
                 failed=True)
            if result.output.strip():
                all_outputs.append(result.output.strip())

    # ── Шаг 3: Финальный ответ ────────────────────────────────
    non_empty = [o for o in all_outputs if o.strip() and not o.endswith(": ")]
    raw_final = "\n\n".join(non_empty) if non_empty else "Задача выполнена, но агент не вернул текстовый ответ."

    # Финальная проверка на повторения
    emit("dedup_start", message="Проверяю ответ на повторения...")
    final = _deduplicate_answer(raw_final, model)
    if final != raw_final:
        emit("dedup_done", message="Повторения убраны.")
    else:
        emit("dedup_done", message="Повторений не найдено.")

    msg_id = _store(conv_id, "orchestrator", final, model=model)
    emit("answer", message_id=msg_id, content=final, success=True)
    logger.info(f"[Orchestrator] Готово. Шагов: {steps_completed}, переплан: {replans}.")

    return OrchestratorResult(
        success=True,
        final_answer=final,
        message_id=msg_id,
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
        parts = []
        for item in output:
            if isinstance(item, dict):
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
        return "\n".join(str(v) for v in output.values() if v)
    return str(output)


def _store(conv_id: str, role: str, content: str, model: str = None) -> str | None:
    if conv_id:
        try:
            return append_message(conv_id, role, content, model=model)
        except Exception:
            pass
    return None


def _deduplicate_answer(text: str, model: str) -> str:
    """Финальный проход: убирает повторения из ответа."""
    if not text or len(text) < 100:
        return text
    prompt = (
        "Перед тобой финальный ответ агента. "
        "Убери все повторения, тавтологию и дублирующиеся мысли. "
        "Сохрани всю уникальную информацию. Не добавляй ничего нового. "
        "Верни только очищенный текст, без пояснений.\n\n"
        f"ОТВЕТ:\n{text}"
    )
    try:
        cleaned = _ollama.ask(prompt, model=model)
        return cleaned.strip() if cleaned and len(cleaned) > 20 else text
    except Exception:
        return text