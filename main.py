"""
Code Agent — точка входа.

Запуск:
    python main.py               # интерактивный REPL
    python main.py "задача"      # однократный запуск
"""
import sys
import uuid

from modules import logger
from modules.conversation_store import init_db, create_conversation
from classes.types import UserTask
from classes.orchestrator import run


def main():
    init_db()
    logger.info("Code Agent запускается...")

    conv_id = create_conversation()
    logger.info(f"Беседа: {conv_id[:8]}")

    # Однократный запуск
    if len(sys.argv) > 1:
        task_text = " ".join(sys.argv[1:])
        _solve(task_text, conv_id)
        logger.close()
        return

    # Интерактивный REPL
    logger.info("Готов к работе. Введи задачу (или 'exit' для выхода):")

    while True:
        try:
            task_text = input("\n>> ").strip()
        except (KeyboardInterrupt, EOFError):
            break

        if task_text.lower() in ("exit", "quit", "q"):
            break
        if not task_text:
            continue

        _solve(task_text, conv_id)

    logger.info("Агент завершил работу.")
    logger.close()


def _solve(task_text: str, conv_id: str):
    task = UserTask(
        text=task_text,
        task_id=str(uuid.uuid4())[:8],
        conversation_id=conv_id,
    )

    context = {"conversation_id": conv_id}

    try:
        result = run(task, context)

        print("\n" + "─" * 50)
        print(result.final_answer)
        print("─" * 50)
        print(f"Шагов: {result.steps_completed} | Переплан: {result.replans} | Итераций: {result.messages_used}")

    except RuntimeError as e:
        logger.error(str(e))


if __name__ == "__main__":
    main()