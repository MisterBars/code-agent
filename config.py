"""
Конфигурация проекта. 
Все настройки берутся отсюда, не разбросаны по модулям.
"""

# Ollama
OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5-coder:7b"
OLLAMA_TIMEOUT = 120

# Orchestrator
MAX_REPLANS = 3
MAX_STEPS = 10
MAX_ITERATIONS = 20

# Logger
LOG_FILE = "agent.log"