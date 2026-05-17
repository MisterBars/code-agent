"""Code Agent — точка входа.

Запуск:
    python main.py            # интерактивный REPL
    python main.py "задача"   # однократный запуск (TODO)
"""
# TODO: Подключить CodeAgent после реализации classes/code_agent.py
# from classes.code_agent import CodeAgent
from modules import logger
from modules import ollama_client


def main():
    logger.info("Code Agent запускается...")

    models = ollama_client.list_models()
    if models:
        logger.info(f"Доступные модели Ollama: {', '.join(models)}")
    else:
        logger.warn("Ollama не отвечает — убедись что запущен: ollama serve")
        return

    logger.info("Готов к работе. Введи задачу (или 'exit' для выхода):")

    while True:
        try:
            task = input("\n>> ").strip()
        except (KeyboardInterrupt, EOFError):
            break

        if task.lower() in ("exit", "quit", "q"):
            break
        if not task:
            continue

        logger.separator(f"Задача: {task[:40]}")
        # TODO: answer = CodeAgent().solve(task)
        # Пока прямой запрос к LLM для теста:
        logger.info("Отправляю запрос в LLM...")
        try:
            raw = ollama_client.ask(task)
            code = ollama_client.extract_python_code(raw)
            logger.info("Код получен:")
            print(code)
        except RuntimeError as e:
            logger.error(str(e))

    logger.info("Агент завершил работу.")
    logger.close()


if __name__ == "__main__":
    main()
