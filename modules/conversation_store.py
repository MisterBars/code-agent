"""
ConversationStore — хранение истории бесед.
Первая версия: SQLite через стандартную библиотеку, без внешних зависимостей.
"""
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH = Path("conversations.db")


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Создаёт таблицы если их ещё нет."""
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT,
                meta TEXT DEFAULT '{}'
            );
        """)


def create_conversation(project_id: str = None) -> str:
    """Создаёт новую беседу, возвращает её id."""
    conv_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, project_id, created_at) VALUES (?, ?, ?)",
            (conv_id, project_id, datetime.now().isoformat())
        )
    return conv_id


def append_message(conversation_id: str, role: str, content: str, meta: dict = None) -> None:
    """
    Добавляет сообщение в беседу.
    role: user / planner / worker / orchestrator / system
    """
    import json
    msg_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)",
            (msg_id, conversation_id, role, content, datetime.now().isoformat(), json.dumps(meta or {}))
        )


def get_messages(conversation_id: str) -> list[dict]:
    """Возвращает все сообщения беседы в хронологическом порядке."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content, created_at, meta FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,)
        ).fetchall()
    return [dict(row) for row in rows]


def list_conversations(project_id: str = None) -> list[dict]:
    """Возвращает список бесед, опционально фильтрует по проекту."""
    with _connect() as conn:
        if project_id:
            rows = conn.execute(
                "SELECT id, project_id, created_at FROM conversations WHERE project_id = ? ORDER BY created_at DESC",
                (project_id,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, project_id, created_at FROM conversations ORDER BY created_at DESC"
            ).fetchall()
    return [dict(row) for row in rows]


# ─── Тест-запуск ───
if __name__ == "__main__":
    init_db()
    cid = create_conversation()
    append_message(cid, "user", "Напиши сортировку пузырьком")
    append_message(cid, "planner", "Шаг 1: написать функцию bubble_sort")
    msgs = get_messages(cid)
    for m in msgs:
        print(f"[{m['role']}] {m['content']}")