# Code Agent 🤖

Локальный AI-агент на Python, работающий через Ollama.

**Принцип работы:**
1. Принимаешь задачу на русском языке
2. Отправляет задачу в локальную LLM (Ollama)
3. Получает Python-код из ответа
4. Запускает код через `subprocess`
5. При ошибке — отправляет `stderr` обратно в LLM, до 3 попыток

## Стек
- Python 3.11+
- [Ollama](https://ollama.com) (локально, модель `qwen2.5-coder:7b`)
- `requests` — HTTP к Ollama API
- `subprocess` + `tempfile` — безопасный запуск кода

## Структура
```
code-agent/
├── main.py              # Точка входа, REPL-интерфейс
├── modules/
│   ├── __init__.py
│   ├── ollama_client.py # HTTP-клиент к Ollama
│   └── logger.py        # Логирование в консоль + agent.log
├── classes/
│   ├── __init__.py
│   ├── code_runner.py   # Безопасный запуск кода с таймаутом
│   ├── fix_loop.py      # Петля исправления ошибок
│   └── code_agent.py    # Фасад — метод solve() и interactive()
├── requirements.txt
└── .gitignore
```

## Быстрый старт
```bash
# 1. Установить зависимости
pip install -r requirements.txt

# 2. Убедиться что Ollama запущен
ollama serve

# 3. Скачать модель
ollama pull qwen2.5-coder:7b

# 4. Запустить агента
python main.py
```

## Документация
Карточки модулей и классов хранятся в [Obsidian Vault](https://github.com/MisterBars/MyVault/tree/main/10%20Projects/code-agent).
