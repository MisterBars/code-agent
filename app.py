from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import uuid
from classes.types import UserTask
from classes.orchestrator import run
from modules.conversation_store import (
    init_db, create_conversation, append_message,
    get_messages, get_context_window,
    list_conversations, rename_conversation, delete_conversation,
    rate_message, delete_messages_after
)
import asyncio, json
from config import DEFAULT_MODEL
import threading

app = FastAPI(title="Code Agent WebUI")

app.mount("/static", StaticFiles(directory="web/static"), name="static")
templates = Jinja2Templates(directory="web/templates")

# Глобальный реестр: conversation_id → threading.Event
active_tasks: dict[str, threading.Event] = {}

class ChatRequest(BaseModel):
    conversation_id: str
    text: str
    model: str = None


@app.on_event("startup")
def startup():
    init_db()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "chat.html")


@app.get("/api/conversations")
def api_list_conversations():
    return {"items": list_conversations()}


@app.post("/api/conversations")
def api_create_conversation():
    conv_id = create_conversation()
    return {"conversation_id": conv_id}


@app.get("/api/conversations/{conversation_id}/messages")
def api_get_messages(conversation_id: str):
    return {"items": get_messages(conversation_id)}

class RenameRequest(BaseModel):
    title: str


@app.patch("/api/conversations/{conversation_id}")
def api_rename_conversation(conversation_id: str, payload: RenameRequest):
    rename_conversation(conversation_id, payload.title.strip())
    return {"ok": True}


@app.delete("/api/conversations/{conversation_id}")
def api_delete_conversation(conversation_id: str):
    delete_conversation(conversation_id)
    return {"ok": True}

@app.post("/api/chat")
def api_chat(payload: ChatRequest):
    text = payload.text.strip()
    if not text:
        return JSONResponse({"error": "Пустое сообщение"}, status_code=400)

    task = UserTask(
        text=text,
        task_id=str(uuid.uuid4())[:8],
        conversation_id=payload.conversation_id,
    )

    context = {
        "conversation_id": payload.conversation_id,
        "history": get_context_window(payload.conversation_id, max_pairs=6),
        "model": payload.model or DEFAULT_MODEL,    # ← пробрасываем
    }

    result = run(task, context)
    messages = get_messages(payload.conversation_id)

    return {
        "ok": True,
        "message_id": result.message_id,   # ← добавили
        "result": {
            "success":         result.success,
            "final_answer":    result.final_answer,
            "steps_completed": result.steps_completed,
            "replans":         result.replans,
            "messages_used":   result.messages_used,
            "error":           getattr(result, "error", None),
        },
        "messages": messages,
    }

@app.post("/api/chat/stream")
async def api_chat_stream(payload: ChatRequest):
    """
    SSE-стрим: отдаёт события reasoning в реальном времени,
    затем финальный ответ.
    """
    text = payload.text.strip()
    if not text:
        return JSONResponse({"error": "Пустое сообщение"}, status_code=400)

    if not payload.conversation_id:
        return JSONResponse({"error": "conversation_id обязателен"}, status_code=400)

    task = UserTask(
        text=text,
        task_id=str(uuid.uuid4())[:8],
        conversation_id=payload.conversation_id,
    )

    async def event_stream():
        loop = asyncio.get_event_loop()
        queue = asyncio.Queue()

        stop_event = threading.Event()
        active_tasks[payload.conversation_id] = stop_event  # регистрируем

        def on_event(event_type: str, data: dict):
            loop.call_soon_threadsafe(queue.put_nowait, {"type": event_type, **data})

        def run_agent():
            context = {
                "conversation_id": payload.conversation_id,
                "history": get_context_window(payload.conversation_id, max_pairs=6),
                "on_event": on_event,
                "model": payload.model or DEFAULT_MODEL,
                "should_stop": stop_event.is_set,  # ← лямбда проверяет Event
            }
            try:
                result = run(task, context)
                loop.call_soon_threadsafe(queue.put_nowait, {
                    "type": "done",
                    "message_id":      result.message_id,
                    "success":         result.success,
                    "final_answer":    result.final_answer,
                    "steps_completed": result.steps_completed,
                    "replans":         result.replans,
                })
            except Exception as e:
                loop.call_soon_threadsafe(queue.put_nowait, {
                    "type": "done", "success": False, "final_answer": str(e),
                })
            finally:
                active_tasks.pop(payload.conversation_id, None)  # снимаем регистрацию

        import concurrent.futures
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        loop.run_in_executor(executor, run_agent)

        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") == "done":
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )

class RatingRequest(BaseModel):
    rating: int        # +1, -1, или 0 (снять оценку)
    note: str = None

@app.post("/api/messages/{message_id}/rate")
def api_rate_message(message_id: str, payload: RatingRequest):
    if payload.rating not in (1, -1, 0):
        return JSONResponse({"error": "rating: 1, -1 или 0"}, status_code=400)
    actual_rating = None if payload.rating == 0 else payload.rating
    rate_message(message_id, actual_rating, payload.note)
    return {"ok": True}

class EditRequest(BaseModel):
    text: str
    after_created_at: str   # ISO timestamp сообщения которое редактируем
    model: str = None

@app.post("/api/chat/edit/{conversation_id}")
def api_edit_message(conversation_id: str, payload: EditRequest):
    """
    Удаляет всё начиная с after_created_at и отправляет новый запрос.
    """
    # Удаляем старую ветку
    delete_messages_after(conversation_id, payload.after_created_at)

    # Запускаем агента заново с новым текстом
    task = UserTask(
        text=payload.text.strip(),
        task_id=str(uuid.uuid4())[:8],
        conversation_id=conversation_id,
    )
    context = {
        "conversation_id": conversation_id,
        "history": get_context_window(conversation_id, max_pairs=6),
        "model": payload.model or DEFAULT_MODEL,
    }
    result = run(task, context)
    return {
        "ok": True,
        "message_id": result.message_id,
        "result": {
            "success":      result.success,
            "final_answer": result.final_answer,
        },
    }

@app.post("/api/chat/cancel/{conversation_id}")
def api_cancel(conversation_id: str):
    event = active_tasks.get(conversation_id)
    if event:
        event.set()  # сигнал остановки
    return {"ok": True}

class EditDeleteRequest(BaseModel):
    after_created_at: str

@app.post("/api/chat/delete-branch/{conversation_id}")
def api_delete_branch(conversation_id: str, payload: EditDeleteRequest):
    delete_messages_after(conversation_id, payload.after_created_at)
    return {"ok": True}