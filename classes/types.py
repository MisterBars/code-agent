"""
Контракты и типы данных проекта.
Все структуры данных определены здесь — ни один модуль не должен
создавать свои собственные dict-схемы.
"""
from dataclasses import dataclass, field
from typing import Optional


# ─── Входная задача ───────────────────────────────────────────

@dataclass
class UserTask:
    text: str
    task_id: str = ""
    conversation_id: Optional[str] = None
    project_id: Optional[str] = None
    meta: dict = field(default_factory=dict)


# ─── Шаг плана ────────────────────────────────────────────────

@dataclass
class PlanStep:
    step_id: str
    title: str
    description: str
    priority: int = 0
    status: str = "pending"       # pending / in_progress / done / failed / needs_replan
    depends_on: list = field(default_factory=list)
    tool_hint: Optional[str] = None


# ─── Результат PlannerAgent ───────────────────────────────────

@dataclass
class PlanResult:
    plan_id: str
    goal: str
    steps: list                   # list[PlanStep]
    reasoning_summary: str = ""
    done: bool = False            # True если задача проста и не требует worker
    needs_worker: bool = True


# ─── Результат WorkerAgent ────────────────────────────────────

@dataclass
class WorkerResult:
    step_id: str
    status: str                   # done / failed / needs_replan
    output: str = ""
    artifacts: list = field(default_factory=list)
    error: Optional[str] = None
    reason: Optional[str] = None  # обязателен при needs_replan


# ─── Результат Orchestrator ───────────────────────────────────

@dataclass
class OrchestratorResult:
    success:         bool
    final_answer:    str
    steps_completed: int
    replans:         int
    messages_used:   int
    message_id:      str | None = None  # ← id финального сообщения для оценки


# ─── RAG ──────────────────────────────────────────────────────

@dataclass
class RetrievalChunk:
    chunk_id: str
    source_id: str
    text: str
    score: float = 0.0
    project_id: Optional[str] = None
    meta: dict = field(default_factory=dict)


@dataclass
class IngestResult:
    source_id: str
    chunks_count: int
    status: str                   # ok / error
    message: str = ""
    project_id: Optional[str] = None