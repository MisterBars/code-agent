import sys
from datetime import datetime
from pathlib import Path

# @desc: Настройки логгера
# @role: Config
# @todo: Вынести LOG_FILE в конфиг проекта

LOG_FILE = Path("agent.log")
_log_handle = None


def _get_handle():
    # @desc: Возвращает открытый файловый дескриптор для лога (ленивая инициализация)
    # @role: Internal
    # @todo: Добавить ротацию файла при превышении 1 МБ
    global _log_handle
    if _log_handle is None:
        _log_handle = open(LOG_FILE, "w", encoding="utf-8")
    return _log_handle


def _write(level: str, message: str):
    # @desc: Форматирует строку лога и пишет в консоль и файл
    # @role: Internal
    # @todo: Добавить цвета в консоль через colorama
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{level.upper():5s}] {message}"
    print(line, file=sys.stdout if level != "error" else sys.stderr)
    try:
        _get_handle().write(line + "\n")
        _get_handle().flush()
    except Exception:
        pass


def info(message: str):
    # @desc: Логирует информационное сообщение
    # @role: Logging
    _write("info", message)


def warn(message: str):
    # @desc: Логирует предупреждение
    # @role: Logging
    _write("warn", message)


def error(message: str):
    # @desc: Логирует ошибку
    # @role: Logging
    _write("error", message)


def separator(label: str = ""):
    # @desc: Пишет разделитель в лог для визуального разделения попыток
    # @role: Logging
    line = f"{'─' * 20} {label} {'─' * 20}" if label else "─" * 50
    _write("info", line)


def close():
    # @desc: Закрывает файловый дескриптор лога
    # @role: Lifecycle
    # @todo: Вызывать в finally основного скрипта
    global _log_handle
    if _log_handle:
        _log_handle.close()
        _log_handle = None


# ─── Тест-запуск ───
if __name__ == "__main__":
    info("Логгер запущен")
    warn("Это предупреждение")
    error("Это ошибка")
    separator("Попытка 1")
    close()
    print("Лог записан в:", LOG_FILE)
