# Code Agent 🤖

Локальный AI-агент на Python с multi-agent архитектурой.  
Работает полностью офлайн через [Ollama](https://ollama.ai).

## Идея

Агент принимает задачу на русском языке и решает её через цепочку:
User → Orchestrator → PlannerAgent → WorkerAgent → ответ

## Стек

- Python 3.11+
- Ollama (локально)
- `requests`, `sqlite3` (стандартная библиотека)
- Модели по умолчанию: `qwen2.5-coder:7b`

## Структура

```text
code-agent/
├── main.py # точка входа, REPL
├── config.py # все настройки проекта
├── requirements.txt
├── modules/
│ ├── ollama_client.py # HTTP-клиент к Ollama
│ ├── logger.py # логирование
│ └── conversation_store.py # хранение бесед (SQLite)
└── classes/
├── types.py # контракты и типы данных
├── orchestrator.py # координатор planner/worker
├── planner_agent.py # агент-планировщик
├── worker_agent.py # агент-исполнитель
├── code_runner.py # (v1 foundation) запуск кода
├── fix_loop.py # (v1 foundation) авто-исправление
└── code_agent.py # (v1 legacy) старый фасад
```

## Установка

```bash
git clone https://github.com/MisterBars/code-agent.git
cd code-agent
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux / macOS / WSL
source .venv/bin/activate

pip install -r requirements.txt
```

## Запуск

Убедись, что Ollama запущен:
```bash
ollama serve
```

Запустить агента:
```bash
python main.py
```

Или однократная задача:
```bash
python main.py "Напиши функцию сортировки пузырьком"
```

## Доступные модели Ollama

| Модель | Когда использовать |
|---|---|
| `qwen2.5-coder:7b` | Default — быстрый |
| `qwen2.5-coder:14b` | Более точный |
| `my-gpu-coder:latest` | Если fine-tune под свои задачи |
| `qwen3-coder:30b` | Максимальное качество |
| `deepseek-coder-v2:16b` | Альтернатива |

Изменить модель:
```python
# config.py
DEFAULT_MODEL = "qwen2.5-coder:14b"
```

## Текущий статус

**Phase 1 — multi-agent текстовые ответы:**
- ✅ `OllamaClient` — HTTP-клиент к Ollama
- ✅ `Logger` — логирование
- ✅ `ConversationStore` — хранение бесед (SQLite)
- ✅ `types.py` — контракты и типы данных
- ✅ `PlannerAgent` — декомпозиция задач
- ✅ `WorkerAgent` — выполнение подзадач
- ✅ `Orchestrator` — координация

**Следующие фазы:**
- 🔲 Web UI
- 🔲 RAG / загрузка файлов
- 🔲 Tools: CodeRunner, FileReader, GitReader
- 🔲 Web tools

## Документация

Архитектура и карточки модулей/классов в Obsidian Vault:  
[MisterBars/MyVault → 10 Projects/code-agent](https://github.com/MisterBars/MyVault/tree/main/10%20Projects/code-agent)