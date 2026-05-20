import requests
import re

try:
    from config import OLLAMA_URL as _BASE_URL, DEFAULT_MODEL, OLLAMA_TIMEOUT
    OLLAMA_BASE = _BASE_URL
except ImportError:
    OLLAMA_BASE = "http://localhost:11434"
    DEFAULT_MODEL = "qwen2.5-coder:7b"
    OLLAMA_TIMEOUT = 120

OLLAMA_URL = OLLAMA_BASE + "/api/chat"


def _get_gpu_options() -> dict:
    try:
        from config import VRAM_GB
        # num_gpu=999 — Ollama сама влезет сколько слоёв поместится в VRAM
        # остаток автоматически уйдёт в RAM
        return {"num_gpu": 999, "num_thread": 8}
    except ImportError:
        return {}


def ask(prompt: str, model: str = None, system: str = None) -> str:
    model = model or DEFAULT_MODEL
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model":    model,
        "messages": messages,
        "stream":   False,
        "options":  _get_gpu_options(),
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=OLLAMA_TIMEOUT)
        response.raise_for_status()
        return response.json()["message"]["content"]
    except requests.exceptions.ConnectionError:
        raise RuntimeError("Ollama не запущен. Запусти: ollama serve")
    except requests.exceptions.Timeout:
        raise RuntimeError(
            f"Ollama не ответила за {OLLAMA_TIMEOUT}с. "
            "Увеличь OLLAMA_TIMEOUT в .env или используй меньшую модель."
        )
    except Exception as e:
        raise RuntimeError(f"Ошибка Ollama API: {e}")


def extract_python_code(text: str) -> str:
    match = re.search(r"```python\s*(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


def list_models() -> list[str]:
    try:
        response = requests.get(OLLAMA_BASE + "/api/tags", timeout=10)
        response.raise_for_status()
        return [m["name"] for m in response.json().get("models", [])]
    except Exception:
        return []