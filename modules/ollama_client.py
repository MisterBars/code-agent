import requests
import re

# @desc: Клиент для работы с Ollama REST API
# @role: LLM / Infrastructure
# @todo: Добавить поддержку streaming для отображения прогресса

OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "qwen2.5-coder:7b"


def ask(prompt: str, model: str = DEFAULT_MODEL, system: str = "") -> str:
    # @desc: Отправляет промпт в Ollama и возвращает текстовый ответ
    # @role: LLM
    # @todo: Добавить retry при ConnectionError (Ollama может быть не запущен)
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
    }
    if system:
        payload["system"] = system

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()
        return data.get("response", "").strip()
    except requests.exceptions.ConnectionError:
        raise RuntimeError("Ollama не запущен. Запусти: ollama serve")
    except requests.exceptions.Timeout:
        raise RuntimeError("Ollama не ответил за 120 секунд — попробуй модель поменьше")
    except Exception as e:
        raise RuntimeError(f"Ошибка Ollama API: {e}")


def extract_python_code(text: str) -> str:
    # @desc: Извлекает Python-код из блока ```python ... ``` в ответе LLM
    # @role: Parser
    # @todo: Обработать случай когда LLM вернул несколько блоков кода
    match = re.search(r"```python\s*([\s\S]*?)```", text)
    if match:
        return match.group(1).strip()
    # Если блока нет — возвращаем весь текст как есть
    return text.strip()


def list_models() -> list[str]:
    # @desc: Возвращает список доступных моделей Ollama
    # @role: Utility
    # @todo: Использовать при инициализации агента для проверки наличия нужной модели
    try:
        resp = requests.get("http://localhost:11434/api/tags", timeout=10)
        resp.raise_for_status()
        models = resp.json().get("models", [])
        return [m["name"] for m in models]
    except Exception:
        return []


# ─── Тест-запуск (не рабочий, только для проверки импорта) ───
if __name__ == "__main__":
    models = list_models()
    print("Доступные модели:", models if models else "Ollama не запущен")
