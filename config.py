"""
Конфигурация проекта.
Все настройки берутся отсюда — не разбросаны по модулям.

Переменные окружения загружаются из .env (см. .env.example).
.env НЕ коммитится в git — он в .gitignore.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# Ищем .env начиная от корня проекта
load_dotenv(Path(__file__).parent / ".env")

# ── PostgreSQL ────────────────────────────────────────────────
# Формат: postgresql://USER:PASSWORD@HOST:PORT/DBNAME
# Пример: postgresql://postgres:secret@localhost:5432/code_agent
DB_DSN: str = os.environ["DATABASE_URL"]

# ── Ollama ────────────────────────────────────────────────────
OLLAMA_URL:    str = os.getenv("OLLAMA_URL",    "http://localhost:11434")
DEFAULT_MODEL: str = os.getenv("DEFAULT_MODEL", "qwen2.5-coder:7b")
OLLAMA_TIMEOUT: int = 120

# ── Orchestrator ──────────────────────────────────────────────
MAX_REPLAN_DEPTH = 3
MAX_STEPS:      int = 10
MAX_ITERATIONS: int = 20

# ── Logger ────────────────────────────────────────────────────
LOG_FILE: str = "agent.log"