from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
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
    rate_message,
)

app = FastAPI(title="Code Agent WebUI")

app.mount("/static", StaticFiles(directory="web/static"), name="static")
templates = Jinja2Templates(directory="web/templates")


class ChatRequest(BaseModel):
    conversation_id: str
    text: str


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
        "history": get_messages(payload.conversation_id),
    }

    result = run(task, context)

    messages = get_messages(payload.conversation_id)

    return {
        "ok": True,
        "result": {
            "success": result.success,
            "final_answer": result.final_answer,
            "steps_completed": result.steps_completed,
            "replans": result.replans,
            "messages_used": result.messages_used,
            "error": result.error,
        },
        "messages": messages,
    }

class RatingRequest(BaseModel):
    rating: int        # +1 или -1
    note: str = None

@app.post("/api/messages/{message_id}/rate")
def api_rate_message(message_id: str, payload: RatingRequest):
    rate_message(message_id, payload.rating, payload.note)
    return {"ok": True}
