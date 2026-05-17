const DEFAULT_MODEL = "qwen2.5-coder:7b";

let currentConversationId = null;

const conversationListEl = document.getElementById("conversation-list");
const messagesEl         = document.getElementById("messages");
const newChatBtn         = document.getElementById("new-chat-btn");
const sendBtn            = document.getElementById("send-btn");
const messageInput       = document.getElementById("message-input");
const conversationLabel  = document.getElementById("conversation-label");

// ── Marked ────────────────────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

// ── Auto-resize textarea ──────────────────────────────────────
messageInput.addEventListener("input", () => {
  messageInput.style.height = "52px";
  const h = Math.min(messageInput.scrollHeight, 200);
  messageInput.style.height = h + "px";
  messageInput.style.overflowY = h >= 200 ? "auto" : "hidden";
});

// ── API ───────────────────────────────────────────────────────
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ── Кастомный диалог (вместо prompt/confirm) ──────────────────
function showDialog({ title, input = false, defaultValue = "", confirmText = "OK", cancelText = "Отмена", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;z-index:9999;
    `;

    const box = document.createElement("div");
    box.style.cssText = `
      background:#1a1e27;border:1px solid #2a303b;border-radius:14px;
      padding:24px;min-width:320px;max-width:440px;width:90%;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
    `;

    let inputEl = null;
    box.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:${input ? 14 : 20}px;color:#e8ecf1;">${esc(title)}</div>
      ${input ? `<input type="text" value="${esc(defaultValue)}" style="
        width:100%;padding:10px 12px;border:1px solid #2a303b;border-radius:10px;
        background:#0f1115;color:#e8ecf1;font-size:14px;outline:none;box-sizing:border-box;margin-bottom:16px;
      " />` : ""}
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="cancel" style="
          background:none;border:1px solid #2a303b;color:#8e99a8;
          border-radius:8px;padding:8px 16px;cursor:pointer;font-size:13px;
        ">${esc(cancelText)}</button>
        <button class="confirm" style="
          background:${danger ? "#7a2222" : "#3d6fa3"};border:none;color:#e8ecf1;
          border-radius:8px;padding:8px 16px;cursor:pointer;font-size:13px;font-weight:600;
        ">${esc(confirmText)}</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (input) {
      inputEl = box.querySelector("input");
      inputEl.focus();
      inputEl.select();
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
    }

    const finish = (confirmed) => {
      overlay.remove();
      if (!confirmed) { resolve(null); return; }
      resolve(input ? (inputEl.value.trim() || null) : true);
    };

    box.querySelector(".confirm").addEventListener("click", () => finish(true));
    box.querySelector(".cancel").addEventListener("click",  () => finish(false));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
  });
}

// ── Markdown → HTML ───────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";

  // Конвертируем Python-dict строки в красивый markdown
  text = text.replace(/\{'([^']+)':\s*'([^']*)',\s*'code':\s*'((?:[^'\\]|\\.)*)(?:',\s*'result':\s*'((?:[^'\\]|\\.)*)')?\s*\}/g,
    (match, key, val, code, result) => {
      const decodedCode = code.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const lang = (val || "").toLowerCase().includes("java") && !(val || "").toLowerCase().includes("javascript") ? "java"
                 : (val || "").toLowerCase().includes("javascript") ? "javascript"
                 : (val || "").toLowerCase().includes("c#") ? "csharp"
                 : (val || "").toLowerCase().includes("python") ? "python"
                 : "python";
      let out = `**${val}**\n\`\`\`${lang}\n${decodedCode}\n\`\`\``;
      if (result) out += `\n> Результат: \`${result}\``;
      return out;
    }
  );

  // Обрабатываем словари с example/code
  text = text.replace(/\{'example':\s*'((?:[^'\\]|\\.)*)',\s*'code':\s*'((?:[^'\\]|\\.)*)'\}/g,
    (match, example, code) => {
      const decodedExample = example.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const decodedCode = code.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      return `**${decodedExample}**\n\`\`\`python\n${decodedCode}\n\`\`\``;
    }
  );

  // Сырые строки кода на отдельной строке (не в блоке) — обернём в inline code
  // Паттерн: строки начинающиеся с имени переменной/функции Python
  text = text.replace(/^([a-zA-Z_]\w*\s*[=\[({].*[=\])}].*)$/gm, (match) => {
    // Пропускаем если уже внутри markdown-блока
    if (match.trim().startsWith("`") || match.trim().startsWith("#")) return match;
    return `\`${match.trim()}\``;
  });
  // Сырые списки/значения на отдельной строке
  text = text.replace(/^(\[.+\]|\{.+\})$/gm, (match) => {
    if (match.trim().startsWith("`")) return match;
    return `\`${match.trim()}\``;
  });

  const renderer = new marked.Renderer();

  renderer.code = function(code, lang) {
    if (typeof code === "object" && code !== null) {
      lang = code.lang || "";
      code = code.text || "";
    }
    lang = lang || "text";

    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(String(code), { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(String(code)).value;
      }
    } catch {
      highlighted = esc(String(code));
    }

    const escaped = String(code)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");

    return `
      <div class="code-block">
        <div class="code-block-header">
          <span class="code-lang">${esc(lang)}</span>
          <button class="copy-btn" data-code="${escaped}">Копировать</button>
        </div>
        <pre><code class="hljs language-${esc(lang)}">${highlighted}</code></pre>
      </div>
    `;
  };

  marked.use({ renderer });
  return marked.parse(text);
}

// ── Навешиваем copy-кнопки после вставки HTML ─────────────────
function bindCopyButtons(container) {
  container.querySelectorAll(".copy-btn[data-code]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"');
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Скопировано ✓";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Копировать";
          btn.classList.remove("copied");
        }, 2000);
      });
    });
  });
}

// ── Render conversations ──────────────────────────────────────
function renderConversationList(items) {
  conversationListEl.innerHTML = "";
  if (!items.length) {
    conversationListEl.innerHTML = `<div style="padding:12px;font-size:12px;color:#6e7a8a;">Нет бесед</div>`;
    return;
  }

  for (const item of items) {
    const title    = item.title || item.id.slice(0, 8);
    const date     = (item.created_at || "").slice(0, 16).replace("T", " ");
    const isActive = item.id === currentConversationId;

    const btn = document.createElement("button");
    btn.className = "conversation-item" + (isActive ? " active" : "");
    btn.dataset.id = item.id;
    btn.innerHTML = `
      <div>
        <div class="conv-title">${esc(title)}</div>
        <div class="conv-date">${esc(date)}</div>
      </div>
      <div class="conv-actions">
        <button class="icon-btn rename-btn" title="Переименовать">✏️</button>
        <button class="icon-btn danger delete-btn" title="Удалить">🗑</button>
      </div>
    `;

    btn.addEventListener("click", (e) => {
      if (e.target.closest(".rename-btn")) { renameConversation(item.id, title); return; }
      if (e.target.closest(".delete-btn")) { deleteConversation(item.id); return; }
      selectConversation(item.id);
    });

    conversationListEl.appendChild(btn);
  }
}

// ── Render messages ───────────────────────────────────────────
function renderMessages(items) {
  messagesEl.innerHTML = "";
  if (!items.length) {
    messagesEl.innerHTML = `<div class="empty-state">Отправь первую задачу агенту ↓</div>`;
    return;
  }

  let i = 0;
  while (i < items.length) {
    const msg = items[i];

    if (msg.role === "user") {
      messagesEl.appendChild(makeUserBubble(msg.content));
      i++;
      continue;
    }

    if (msg.role === "planner" || msg.role === "worker") {
      const reasoningMsgs = [];
      while (i < items.length && (items[i].role === "planner" || items[i].role === "worker")) {
        reasoningMsgs.push(items[i++]);
      }
      const orcMsg = (i < items.length && items[i].role === "orchestrator") ? items[i++] : null;
      messagesEl.appendChild(makeAgentGroup(reasoningMsgs, orcMsg));
      continue;
    }

    if (msg.role === "orchestrator") {
      messagesEl.appendChild(makeAgentGroup([], msg));
      i++;
      continue;
    }

    i++;
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function makeUserBubble(content) {
  const wrap = document.createElement("div");
  wrap.className = "message user";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);

  // Кнопка копирования вопроса
  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;margin-top:5px;padding:0 4px;";

  const copyBtn = document.createElement("button");
  copyBtn.style.cssText = `
    background:none;border:none;color:#3a4555;
    font-size:11px;cursor:pointer;padding:2px 6px;
    border-radius:5px;transition:color 0.12s;
  `;
  copyBtn.textContent = "Копировать";
  copyBtn.addEventListener("mouseenter", () => { copyBtn.style.color = "#6e7a8a"; });
  copyBtn.addEventListener("mouseleave", () => {
    if (!copyBtn.dataset.copied) copyBtn.style.color = "#3a4555";
  });
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = "✓";
      copyBtn.dataset.copied = "1";
      copyBtn.style.color = "#2aaa65";
      setTimeout(() => {
        copyBtn.textContent = "Копировать";
        delete copyBtn.dataset.copied;
        copyBtn.style.color = "#3a4555";
      }, 2000);
    });
  });

  footer.appendChild(copyBtn);
  wrap.appendChild(footer);
  return wrap;
}

function makeAgentGroup(reasoningMsgs, orcMsg) {
  const wrap = document.createElement("div");
  wrap.className = "message orchestrator";

  if (reasoningMsgs.length > 0) {
    const plannerCount = reasoningMsgs.filter(m => m.role === "planner").length;
    const workerCount  = reasoningMsgs.filter(m => m.role === "worker").length;
    const parts = [];
    if (plannerCount) parts.push(`${plannerCount} план`);
    if (workerCount)  parts.push(`${workerCount} шагов`);

    const block = document.createElement("div");
    block.className = "reasoning-block";

    const toggle = document.createElement("button");
    toggle.className = "reasoning-toggle";
    toggle.innerHTML = `
      <i class="arrow">▶</i>
      <span class="reasoning-dot dot-planner"></span>
      <span>Reasoning — ${esc(parts.join(", "))}</span>
    `;

    const body = document.createElement("div");
    body.className = "reasoning-body";
    body.textContent = reasoningMsgs
      .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
      .join("\n\n─────\n\n");

    toggle.addEventListener("click", () => block.classList.toggle("open"));
    block.appendChild(toggle);
    block.appendChild(body);
    wrap.appendChild(block);
  }

  if (orcMsg) {
    // Имя модели
    const label = document.createElement("div");
    label.className = "model-label";
    label.textContent = DEFAULT_MODEL;
    wrap.appendChild(label);

    // Тело ответа
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(orcMsg.content || "");
    bindCopyButtons(bubble);
    wrap.appendChild(bubble);

    // Кнопка копирования ВНИЗУ
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;margin-top:6px;padding:0 4px;";

    const copyAllBtn = document.createElement("button");
    copyAllBtn.style.cssText = `
      background:none;border:1px solid #252932;color:#4e5a6a;
      border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;
      transition:all 0.12s;
    `;
    copyAllBtn.textContent = "Копировать ответ";

    copyAllBtn.addEventListener("mouseenter", () => {
      copyAllBtn.style.borderColor = "#4d85c0";
      copyAllBtn.style.color = "#b0c8e8";
    });
    copyAllBtn.addEventListener("mouseleave", () => {
      if (!copyAllBtn.dataset.copied) {
        copyAllBtn.style.borderColor = "#252932";
        copyAllBtn.style.color = "#4e5a6a";
      }
    });
    copyAllBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(orcMsg.content || "").then(() => {
        copyAllBtn.textContent = "Скопировано ✓";
        copyAllBtn.style.color = "#2aaa65";
        copyAllBtn.style.borderColor = "#2aaa65";
        copyAllBtn.dataset.copied = "1";
        setTimeout(() => {
          copyAllBtn.textContent = "Копировать ответ";
          copyAllBtn.style.color = "#4e5a6a";
          copyAllBtn.style.borderColor = "#252932";
          delete copyAllBtn.dataset.copied;
        }, 2000);
      });
    });

    footer.appendChild(copyAllBtn);
    wrap.appendChild(footer);
  }

  return wrap;
}

// ── CRUD ──────────────────────────────────────────────────────
async function loadConversations() {
  const data = await api("/api/conversations");
  renderConversationList(data.items || []);
}

async function loadMessages(conversationId) {
  const data = await api(`/api/conversations/${conversationId}/messages`);
  renderMessages(data.items || []);
}

async function selectConversation(conversationId) {
  currentConversationId = conversationId;
  conversationLabel.textContent = "Беседа: " + conversationId.slice(0, 8);
  await loadConversations();
  await loadMessages(conversationId);
}

async function createConversation() {
  const data = await api("/api/conversations", { method: "POST" });
  await loadConversations();
  await selectConversation(data.conversation_id);
}

async function renameConversation(conversationId, currentTitle) {
  const isDefault = currentTitle === conversationId.slice(0, 8);
  const newTitle = await showDialog({
    title: "Переименовать беседу",
    input: true,
    defaultValue: isDefault ? "" : currentTitle,
    confirmText: "Сохранить",
  });
  if (!newTitle) return;

  try {
    await api(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: newTitle }),
    });
    // Если переименовали текущую беседу — обновим подпись
    if (currentConversationId === conversationId) {
      conversationLabel.textContent = "Беседа: " + newTitle;
    }
    await loadConversations();
  } catch (err) {
    alert("Ошибка переименования: " + err.message);
  }
}

async function deleteConversation(conversationId) {
  const confirmed = await showDialog({
    title: "Удалить беседу и все сообщения?",
    confirmText: "Удалить",
    danger: true,
  });
  if (!confirmed) return;

  await api(`/api/conversations/${conversationId}`, { method: "DELETE" });

  if (currentConversationId === conversationId) {
    currentConversationId = null;
    conversationLabel.textContent = "Выбери или создай беседу";
    messagesEl.innerHTML = `<div class="empty-state">Выбери беседу слева или создай новую.</div>`;
  }
  await loadConversations();
}

// ── Send ──────────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  if (!currentConversationId) await createConversation();

  sendBtn.disabled      = true;
  messageInput.disabled = true;
  sendBtn.textContent   = "…";

  const optimistic = makeUserBubble(text);
  messagesEl.appendChild(optimistic);

  const loadingEl = document.createElement("div");
  loadingEl.className = "empty-state";
  loadingEl.style.cssText = "margin-top:16px;font-size:13px;";
  loadingEl.textContent = "Агент думает...";
  messagesEl.appendChild(loadingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversation_id: currentConversationId, text }),
    });
    messageInput.value = "";
    messageInput.style.height = "52px";
    await loadMessages(currentConversationId);
    await loadConversations();
  } catch (err) {
    optimistic.remove();
    loadingEl.remove();
    alert("Ошибка: " + err.message);
  } finally {
    sendBtn.disabled      = false;
    messageInput.disabled = false;
    sendBtn.textContent   = "↑";
    messageInput.focus();
  }
}

// ── Events ────────────────────────────────────────────────────
newChatBtn.addEventListener("click", createConversation);
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
});

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  await loadConversations();
  messagesEl.innerHTML = `<div class="empty-state">Выбери беседу слева или создай новую.</div>`;
})();