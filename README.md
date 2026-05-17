# Code Agent 🤖

Локальный AI-агент на Python, работающий через Ollama.

## Идея

Агент принимает задачу на русском языке, отправляет её в локальную LLM через Ollama, получает Python-код, запускает его и при ошибке отправляет traceback обратно в модель для исправления.

Цикл:
1. Пользователь вводит задачу.
2. LLM генерирует Python-код.
3. Код запускается во временном файле через subprocess.
4. Если есть ошибка — stderr отправляется обратно в LLM.
5. Повтор до 3 попыток.

## Стек

- Python 3.11+
- Ollama
- `requests`
- `subprocess`
- `tempfile`
- локальная модель по умолчанию: `qwen2.5-coder:7b`

## Структура

```text
code-agent/
├── main.py
├── requirements.txt
├── .gitignore
├── modules/
│   ├── __init__.py
│   ├── ollama_client.py
│   └── logger.py
└── classes/
    ├── __init__.py
    ├── code_runner.py
    ├── fix_loop.py
    └── code_agent.py
```

## Виртуальное окружение

Зависимости устанавливаются не в глобальный Python, а в отдельное окружение проекта.

### Windows

Проверить доступные версии Python:

```bat
py -0p
```

Создать окружение на Python 3.11:

```bat
py -3.11 -m venv .venv
```

Активировать:

```bat
.venv\Scripts\activate
```

Обновить pip и установить зависимости:

```bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Linux / WSL

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Запуск

Убедись, что Ollama запущен:

```bash
ollama serve
```

Проверить модели:

```bash
ollama list
```

Запуск агента:

```bash
python main.py
```

## Текущий статус

Готово:
- `modules/ollama_client.py`
- `modules/logger.py`
- базовая точка входа `main.py`

Следующие этапы:
- `CodeRunner`
- `FixLoop`
- `CodeAgent`

## Модели Ollama

Сейчас доступны:

- `deepseek-coder-v2:16b`
- `gpt-oss:20b`
- `qwen3-coder:30b`
- `sleechengn/nomic-embed-text:latest`
- `nomic-embed-text-v2-moe:latest`
- `qwen2.5-coder:7b`
- `qwen2.5-coder:14b`
- `my-gpu-coder:latest`

## Документация

Архитектура и карточки модулей/классов ведутся в Obsidian Vault:
`10 Projects/code-agent/`
