"""
ConversationStore — хранение истории бесед в PostgreSQL.
Зависимости: psycopg2-binary (уже должен быть в requirements.txt)
"""
import json
import uuid
from datetime import datetime

import psycopg2
import psycopg2.extras
from config import DB_DSN  # DSN строка: postgresql://user:pass@host/dbname


def _connect():
    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = False
    return conn


def init_db() -> None:
    """Создаёт таблицы и индексы если их нет. Идемпотентно."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id          TEXT PRIMARY KEY,
                    project_id  TEXT,
                    title       TEXT,
                    model       TEXT,
                    created_at  TIMESTAMPTZ DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    model           TEXT        DEFAULT NULL,
                    rating          SMALLINT    DEFAULT NULL,
                    rating_note     TEXT        DEFAULT NULL,
                    tokens_used     INT         DEFAULT NULL,
                    meta            JSONB       DEFAULT '{}',
                    created_at      TIMESTAMPTZ DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_messages_conv
                    ON messages(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_messages_rating
                    ON messages(conversation_id, rating)
                    WHERE rating IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_messages_model
                    ON messages(model)
                    WHERE model IS NOT NULL;

                -- Безопасные миграции для существующих таблиц
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS model       TEXT     DEFAULT NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS rating      SMALLINT DEFAULT NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS rating_note TEXT     DEFAULT NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS tokens_used INT      DEFAULT NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta        JSONB    DEFAULT '{}';
            """)
        conn.commit()


def create_conversation(project_id: str = None, model: str = None) -> str:
    """Создаёт новую беседу, возвращает её id."""
    conv_id = str(uuid.uuid4())
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO conversations (id, project_id, model) VALUES (%s, %s, %s)",
                (conv_id, project_id, model)
            )
        conn.commit()
    return conv_id


def append_message(
    conversation_id: str,
    role: str,
    content: str,
    meta: dict = None,
    tokens_used: int = None,
    model: str = None,       # ← добавили
) -> str:
    """
    Добавляет сообщение. role: user / planner / worker / orchestrator
    Возвращает id сообщения.
    """
    msg_id = str(uuid.uuid4())
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO messages
                    (id, conversation_id, role, content, meta, tokens_used, model)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (msg_id, conversation_id, role, content,
                 json.dumps(meta or {}), tokens_used, model)
            )
        conn.commit()
    return msg_id


def rate_message(message_id: str, rating: int | None, note: str = None) -> None:
    """rating=None снимает оценку, +1/-1 ставит."""
    if rating is not None and rating not in (1, -1):
        raise ValueError("rating: +1, -1 или None")
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE messages SET rating = %s, rating_note = %s WHERE id = %s",
                (rating, note, message_id)
            )
        conn.commit()


def get_messages(conversation_id: str) -> list[dict]:
    with _connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, role, content, rating, rating_note, model, created_at
                FROM messages
                WHERE conversation_id = %s
                ORDER BY created_at ASC
                """,
                (conversation_id,)
            )
            rows = cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if hasattr(d.get("created_at"), "isoformat"):
            d["created_at"] = d["created_at"].isoformat()
        result.append(d)
    return result


def get_context_window(conversation_id: str, max_pairs: int = 6) -> list[dict]:
    """
    Возвращает последние max_pairs пар (user + orchestrator) для контекста LLM.
    Planner/worker не включаем — модели не нужен внутренний reasoning.
    orchestrator → assistant (формат Ollama chat API).
    """
    with _connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT role, content FROM messages
                WHERE conversation_id = %s
                  AND role IN ('user', 'orchestrator')
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (conversation_id, max_pairs * 2)
            )
            rows = cur.fetchall()

    messages = [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
    for m in messages:
        if m["role"] == "orchestrator":
            m["role"] = "assistant"
    return messages


def get_positive_examples(limit: int = 10) -> list[dict]:
    """
    Возвращает лучшие оценённые ответы агента.
    Используется для few-shot примеров в промптах.
    """
    with _connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT m_user.content AS question,
                       m_orc.content  AS answer
                FROM messages m_orc
                JOIN messages m_user
                  ON m_user.conversation_id = m_orc.conversation_id
                 AND m_user.role = 'user'
                 AND m_user.created_at < m_orc.created_at
                WHERE m_orc.role = 'orchestrator'
                  AND m_orc.rating = 1
                ORDER BY m_orc.created_at DESC
                LIMIT %s
                """,
                (limit,)
            )
            return [dict(r) for r in cur.fetchall()]


def list_conversations(project_id: str = None) -> list[dict]:
    """Список бесед, опционально фильтрует по проекту."""
    with _connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if project_id:
                cur.execute(
                    "SELECT id, project_id, title, model, created_at FROM conversations WHERE project_id = %s ORDER BY created_at DESC",
                    (project_id,)
                )
            else:
                cur.execute(
                    "SELECT id, project_id, title, model, created_at FROM conversations ORDER BY created_at DESC"
                )
            return [dict(r) for r in cur.fetchall()]


def rename_conversation(conversation_id: str, title: str) -> None:
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE conversations SET title = %s WHERE id = %s",
                (title, conversation_id)
            )
        conn.commit()


def delete_conversation(conversation_id: str) -> None:
    """ON DELETE CASCADE сам удалит messages."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM conversations WHERE id = %s", (conversation_id,))
        conn.commit()

def delete_messages_after(conversation_id: str, after_created_at: str) -> None:
    """
    Удаляет все сообщения беседы после указанного времени.
    Используется при редактировании вопроса — старая ветка удаляется.
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM messages
                WHERE conversation_id = %s
                  AND created_at >= %s
                """,
                (conversation_id, after_created_at)
            )
        conn.commit()