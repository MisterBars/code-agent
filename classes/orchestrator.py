"""
Orchestrator — главный координатор multi-agent архитектуры.
Рекурсивное выполнение с глубиной до MAX_REPLAN_DEPTH уровней:

Уровень 0: Planner → [шаг1, шаг2, шаг3]
                Worker(шаг1) → needs_replan
Уровень 1:   Planner → [шаг1.1, шаг1.2]
                  Worker(шаг1.1) → needs_replan
Уровень 2:     Planner → [шаг1.1.1, шаг1.1.2]
                      Worker → done (или depth=MAX → "требует уточнения")
             ↑ возвращаемся на уровень 1, продолжаем шаг1.2
         ↑ возвращаемся на уровень 0, продолжаем шаг2, шаг3
"""
import uuid

from config import MAX_REPLAN_DEPTH, MAX_STEPS, MAX_ITERATIONS, DEFAULT_MODEL
from modules import logger
from modules.conversation_store import append_message
from classes.types import UserTask, PlanStep, OrchestratorResult
from classes import planner_agent, worker_agent
from modules import ollama_client as _ollama
import json, re


def run(task: UserTask, context: dict = None) -> OrchestratorResult:
    context = context or {}
    conv_id     = context.get("conversation_id")
    model       = context.get("model", DEFAULT_MODEL)
    on_event    = context.get("on_event")
    should_stop = context.get("should_stop")

    stats = {"steps_completed": 0, "replans": 0, "iterations": 0}
    all_outputs = []

    def emit(event_type: str, **data):
        if on_event:
            try:
                on_event(event_type, data)
            except Exception:
                pass

    def is_cancelled() -> bool:
        return callable(should_stop) and should_stop()

    def store(role: str, content: str, model_name: str = None) -> str | None:
        if conv_id:
            try:
                return append_message(conv_id, role, content, model=model_name)
            except Exception:
                pass
        return None

    store("user", task.text)
    logger.separator(f"Orchestrator: {task.text[:40]}")

    # ── Шаг 1: Первичное планирование ────────────────────────
    emit("planner_start", message="Планирую задачу...")
    try:
        plan = planner_agent.plan(task, context, model=model)
    except RuntimeError as e:
        err_msg = str(e)
        emit("answer", content=f"❌ Ошибка: {err_msg}", success=False, message_id=None)
        return OrchestratorResult(
            success=False, final_answer=err_msg, message_id=None,
            steps_completed=0, replans=0, messages_used=0,
        )

    plan_text = f"[ПЛАН] {plan.goal}\n" + "\n".join(
        f"  {i+1}. {s.title}" for i, s in enumerate(plan.steps)
    )
    store("planner", plan_text)
    emit("planner_done", message=plan_text, steps_total=len(plan.steps))

    # Простой вопрос — planner отвечает сам
    if plan.done:
        logger.info("[Orchestrator] Planner ответил напрямую.")
        msg_id = store("orchestrator", plan.reasoning_summary, model_name=model)
        emit("answer", message_id=msg_id, content=plan.reasoning_summary)
        return OrchestratorResult(
            success=True,
            final_answer=plan.reasoning_summary,
            message_id=msg_id,
            steps_completed=0,
            replans=0,
            messages_used=1,
        )

    # ── Шаг 2: Рекурсивное выполнение ────────────────────────
    root_steps = plan.steps[:MAX_STEPS]
    for s in root_steps:
        s.depth = 0

    _execute_steps(
        steps=root_steps,
        goal=plan.goal,
        context=context,
        model=model,
        stats=stats,
        all_outputs=all_outputs,
        emit=emit,
        store=store,
        is_cancelled=is_cancelled,
    )

    # ── Шаг 3: Проверка отмены ───────────────────────────────
    if is_cancelled():
        msg = "⏹ Задача остановлена."
        msg_id = store("orchestrator", msg)
        emit("answer", message_id=msg_id, content=msg, success=False)
        return OrchestratorResult(
            success=False, final_answer=msg, message_id=msg_id,
            steps_completed=stats["steps_completed"],
            replans=stats["replans"],
            messages_used=stats["iterations"],
        )

    # ── Шаг 4: Финальный ответ ────────────────────────────────
    non_empty = [o for o in all_outputs if o.strip()]
    if not non_empty:
        raw_final = "Задача выполнена, но агент не вернул текстовый ответ."
    else:
        raw_final = _build_final(non_empty, root_steps)
        # Synthesis pass — финальная «причёска» ответа через LLM
        # Включается если шагов > 2 (для одиночных шагов не нужно)
        if len(non_empty) > 2:
            try:
                synthesis_prompt = (
                    f"Исходный вопрос: {task.text}\n\n"
                    f"Собранный ответ от агентов:\n{raw_final}\n\n"
                    "Перепиши это как единый связный ответ для пользователя. "
                    "Требования:\n"
                    "- Не повторяй структуру плана (без заголовков вида 'Объяснить:', 'Показать код:').\n"
                    "- Используй ## только для реальных смысловых разделов (не названий шагов).\n"
                    "- Сохрани все таблицы, примеры кода и числовые данные дословно.\n"
                    "- Пометь незавершённые части текстом: ⚠️ *Требует уточнения*\n"
                    "- Убери JSON-объекты, статусы, технические метки.\n"
                    "Ответ должен звучать как написанный человеком-экспертом."
                )
                synthesized = _ollama.ask(synthesis_prompt, model=model)
                if synthesized and len(synthesized) > 100:
                    raw_final = synthesized
            except Exception as e:
                logger.warn(f"[Orchestrator] Synthesis pass не удался: {e}")
                # Оставляем raw_final как есть

    final = _deduplicate_answer(raw_final)

    msg_id = store("orchestrator", final, model_name=model)
    emit("answer", message_id=msg_id, content=final, success=True)
    logger.info(
        f"[Orchestrator] Готово. Шагов: {stats['steps_completed']}, "
        f"переплан: {stats['replans']}."
    )

    return OrchestratorResult(
        success=True,
        final_answer=final,
        message_id=msg_id,
        steps_completed=stats["steps_completed"],
        replans=stats["replans"],
        messages_used=stats["iterations"],
    )


def _execute_steps(
    steps: list,
    goal: str,
    context: dict,
    model: str,
    stats: dict,
    all_outputs: list,
    emit,
    store,
    is_cancelled,
) -> None:
    """
    Рекурсивно выполняет список шагов.
    При needs_replan — планирует подшаги и рекурсивно выполняет их,
    затем продолжает оставшиеся шаги текущего уровня.
    """
    for step in steps:
        if is_cancelled():
            return

        if stats["iterations"] >= MAX_ITERATIONS:
            logger.warn("[Orchestrator] Достигнут лимит итераций.")
            return

        stats["iterations"] += 1
        depth = step.depth

        emit(
            "worker_start",
            step=stats["iterations"],
            depth=depth,
            message=f"{'  ' * depth}[глубина {depth}] Шаг: {step.title}",
        )

        result = worker_agent.solve_subtask(step, context, model=model)
        store("worker", f"[{step.title}] {result.output}")

        if result.status == "done":
            stats["steps_completed"] += 1
            output = _normalize_output(result.output)
            if output:
                all_outputs.append(output)
            emit(
                "worker_done",
                step=stats["iterations"],
                depth=depth,
                message=f"{'  ' * depth}✓ {step.title}: {output[:120]}{'...' if len(output) > 120 else ''}",
            )
            logger.info(f"[Orchestrator] Шаг '{step.title}' (глубина {depth}) выполнен.")

        elif result.status == "needs_replan":
            if depth >= MAX_REPLAN_DEPTH:
                partial = result.output or result.reason or "нет данных"
                clarification_note = f"⚠️ *Требует уточнения* — {step.title}: {partial}"
                all_outputs.append(clarification_note)
                emit(
                    "worker_done",
                    step=stats["iterations"],
                    depth=depth,
                    message=f"{'  ' * depth}⚠ {step.title}: требует уточнения (макс. глубина)",
                )
            else:
                stats["replans"] += 1
                new_depth = depth + 1

                emit(
                    "replan",
                    step=stats["iterations"],
                    depth=new_depth,
                    message=(
                        f"{'  ' * depth}↳ Углубляюсь до уровня {new_depth}/{MAX_REPLAN_DEPTH}: "
                        f"{result.reason or step.title}"
                    ),
                )

                clean_context = {"retrieval": context.get("retrieval", [])}

                sub_plan = planner_agent.subplan(
                    step_title=step.title,
                    step_description=step.description,
                    parent_goal=goal,
                    context=clean_context,
                    model=model,
                )

                sub_plan_text = (
                    f"[ПОДПЛАН глубина {new_depth}] {sub_plan.goal}\n" +
                    "\n".join(
                        f"{'  ' * new_depth}{i+1}. {s.title}"
                        for i, s in enumerate(sub_plan.steps)
                    )
                )
                store("planner", sub_plan_text)
                emit(
                    "planner_done",
                    depth=new_depth,
                    message=sub_plan_text,
                    steps_total=len(sub_plan.steps),
                )

                if sub_plan.done:
                    output = _normalize_output(sub_plan.reasoning_summary)
                    if output:
                        all_outputs.append(output)
                    emit(
                        "worker_done",
                        step=stats["iterations"],
                        depth=new_depth,
                        message=f"{'  ' * new_depth}✓ (preplanned) {step.title}",
                    )
                else:
                    sub_steps = sub_plan.steps[:MAX_STEPS]
                    for s in sub_steps:
                        s.depth = new_depth
                        s.parent_step_id = step.step_id

                    # ── РЕКУРСИЯ ──────────────────────────────
                    _execute_steps(
                        steps=sub_steps,
                        goal=sub_plan.goal,
                        context=context,
                        model=model,
                        stats=stats,
                        all_outputs=all_outputs,
                        emit=emit,
                        store=store,
                        is_cancelled=is_cancelled,
                    )
                    # После возврата из рекурсии — продолжаем шаги текущего уровня

        elif result.status == "failed":
            logger.warn(f"[Orchestrator] Шаг '{step.title}' завершился с ошибкой: {result.error}")
            emit(
                "worker_done",
                step=stats["iterations"],
                depth=depth,
                message=f"{'  ' * depth}✗ {step.title}: {result.error or 'ошибка'}",
                failed=True,
            )
            if result.output and result.output.strip():
                all_outputs.append(result.output.strip())


def _build_final(outputs: list, root_steps: list) -> str:
    """
    Собирает финальный ответ.
    Корневые шаги получают ## заголовок — но очищенный от служебных префиксов.
    Подшаги склеиваются без дополнительного заголовка.
    """
    _PREFIXES = (
        "Объяснить: ", "Перечислить: ", "Показать код: ", "Сравнить: ",
        "Привести пример: ", "Подвести итог: ", "Определить: ", "Составить: ",
        "Показать: ", "Описать: ", "Рассмотреть: ", "Изучить: ",
    )

    def clean_title(title: str) -> str:
        for p in _PREFIXES:
            if title.startswith(p):
                return title[len(p):]
        return title

    parts = []
    root_count = len(root_steps)

    for i, output in enumerate(outputs):
        if not output.strip():
            continue
        if i < root_count:
            title = clean_title(root_steps[i].title)
            parts.append(f"## {title}\n\n{output}")
        else:
            parts.append(output)

    return "\n\n---\n\n".join(parts)


def _normalize_output(output) -> str:
    """Конвертирует любой формат output worker-а в чистую строку."""
    if not output:
        return ""

    # ── list/dict → строка ───────────────────────────────────
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

    text = str(output).strip()

    # ── 1. JSON-обёртка {"status":..., "output":...} ────────
    if text.startswith("{"):
        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            data = json.loads(text[start:end])
            if isinstance(data, dict):
                text = data.get("output") or data.get("reason") or text
                text = str(text).strip()
        except Exception:
            pass

    # ── 2. Экранированные \n которые пришли как строка ───────
    # worker иногда возвращает "строка\\nстрока" вместо реальных переносов
    if "\\n" in text and "\n" not in text:
        text = text.replace("\\n", "\n").replace("\\t", "\t")

    # ── 3. Неправильный язык у code-блоков ──────────────────
    # Go/C++ код помечен как ```python — меняем на ```
    text = re.sub(
        r"```python\n(?=(//|package main|#include|import \"fmt\"|class [A-Z]))",
        "```\n",
        text,
    )

    # ── 4. JSON-мусор в начале текста ───────────────────────
    text = re.sub(r'^\{\s*"status"\s*:.*?\}\s*\n+', '', text, flags=re.S)

    return text.strip()



def _deduplicate_answer(text: str) -> str:
    """
    Детерминированная дедупликация без LLM.
    Убирает абзацы которые являются близким дублем уже виденных (overlap > 80%).
    Заголовки ## никогда не удаляются.
    """
    if not text or len(text) < 100:
        return text

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    seen: list[str] = []
    result: list[str] = []

    for para in paragraphs:
        # Заголовки никогда не удаляем
        if para.startswith("#") or para.startswith("---"):
            result.append(para)
            continue

        normalized = " ".join(para.lower().split())
        is_duplicate = False

        for s in seen:
            words_para = set(normalized.split())
            words_seen = set(s.split())
            if not words_para:
                continue
            overlap = len(words_para & words_seen) / len(words_para)
            if overlap > 0.8:
                is_duplicate = True
                break

        if not is_duplicate:
            seen.append(normalized)
            result.append(para)

    return "\n\n".join(result)

