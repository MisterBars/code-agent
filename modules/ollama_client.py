import requests
import re

# @desc: Клиент для работы с Ollama REST API
# @role: LLM / Infrastructure
# @todo: Добавить поддержку streaming для отображения прогресса

try:
    from config import OLLAMA_URL as _BASE_URL, DEFAULT_MODEL, OLLAMA_TIMEOUT
    OLLAMA_BASE = _BASE_URL
except ImportError:
    OLLAMA_BASE = "http://localhost:11434"
    DEFAULT_MODEL = "qwen2.5-coder:7b"
    OLLAMA_TIMEOUT = 120

OLLAMA_URL = OLLAMA_BASE + "/api/chat"

def ask(prompt: str, model: str = None, system: str = None) -> str:
    """Отправляет запрос в Ollama, возвращает текст ответа."""
    model = model or DEFAULT_MODEL
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=OLLAMA_TIMEOUT)
        response.raise_for_status()
        return response.json()["message"]["content"]
    except requests.exceptions.ConnectionError:
        raise RuntimeError("Ollama не запущен. Запусти: ollama serve")
    except Exception as e:
        raise RuntimeError(f"Ошибка Ollama API: {e}")

def extract_python_code(text: str) -> str:
    """Извлекает Python-код из markdown-блока."""
    match = re.search(r"```python\s*(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()

def list_models() -> list[str]:
    """Возвращает список доступных моделей."""
    try:
        response = requests.get(OLLAMA_BASE + "/api/tags", timeout=10)
        response.raise_for_status()
        return [m["name"] for m in response.json().get("models", [])]
    except Exception:
        return []

# ─── Тест-запуск (не рабочий, только для проверки импорта) ───
if __name__ == "__main__":
    models = list_models()
    print("Доступные модели:", models if models else "Ollama не запущен")
