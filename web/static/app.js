const DEFAULT_MODEL = "qwen2.5-coder:7b";

let currentModel = DEFAULT_MODEL;
let currentConversationId  = null;
let currentAbortController = null;
let _sending = false;

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

// ── Единое управление режимом отправки ───────────────────────
// mode: "idle" | "sending" | "streaming"
function setSendMode(mode) {
  _sending = mode !== "idle";
  if (mode === "idle") {
    sendBtn.textContent   = "↑";
    sendBtn.title         = "";
    sendBtn.style.background = "";
    sendBtn.disabled      = false;
    sendBtn.onclick       = null;
    messageInput.disabled = false;
    messageInput.style.borderColor = "";
  } else if (mode === "sending") {
    sendBtn.textContent   = "…";
    sendBtn.disabled      = true;
    messageInput.disabled = true;
  } else if (mode === "streaming") {
    sendBtn.textContent      = "■";
    sendBtn.title            = "Остановить";
    sendBtn.style.background = "#5a2020";
    sendBtn.disabled         = false;
    sendBtn.onclick = (e) => { e.stopPropagation(); stopGeneration(); };
  }
}

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

// ── Показать ошибку в чате ────────────────────────────────────
function showError(msg) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.style.color = "#e05c5c";
  div.textContent = "Ошибка: " + msg;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Удалить DOM-элементы сообщений начиная с createdAt ────────
function removeMessagesAfter(createdAt) {
  const all = Array.from(messagesEl.children);
  let found = false;
  for (const el of all) {
    if (el.dataset.createdAt === createdAt) { found = true; }
    if (found) el.remove();
  }
}

// ── Кастомный диалог ──────────────────────────────────────────
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
  text = text.replace(
    /\{'([^']+)':\s*'([^']*)',\s*'code':\s*'((?:[^'\\]|\\.)*)(?:',\s*'result':\s*'((?:[^'\\]|\\.)*)')?\s*\}/g,
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
  text = text.replace(
    /\{'example':\s*'((?:[^'\\]|\\.)*)',\s*'code':\s*'((?:[^'\\]|\\.)*)'\}/g,
    (match, example, code) => {
      const decodedExample = example.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const decodedCode = code.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      return `**${decodedExample}**\n\`\`\`python\n${decodedCode}\n\`\`\``;
    }
  );
  text = text.replace(/^([a-zA-Z_]\w*\s*[=\[({].*[=\])}].*)$/gm, (match) => {
    if (match.trim().startsWith("`") || match.trim().startsWith("#")) return match;
    return `\`${match.trim()}\``;
  });
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
    const escaped = String(code).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
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

function bindCopyButtons(container) {
  container.querySelectorAll(".copy-btn[data-code]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Скопировано ✓";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Копировать"; btn.classList.remove("copied"); }, 2000);
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
      messagesEl.appendChild(makeUserBubble(msg.content, msg.created_at));
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

// ── Маленькая кнопка (переиспользуется) ──────────────────────
function makeSmallBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.style.cssText = `
    background:none;border:none;color:#3a4555;font-size:11px;
    cursor:pointer;padding:2px 6px;border-radius:5px;transition:color 0.12s;
  `;
  btn.textContent = label;
  btn.addEventListener("mouseenter", () => { btn.style.color = "#6e7a8a"; });
  btn.addEventListener("mouseleave", () => { btn.style.color = "#3a4555"; });
  btn.addEventListener("click", onClick);
  return btn;
}

// ── Пузырь вопроса пользователя ──────────────────────────────
function makeUserBubble(content, createdAt) {
  const wrap = document.createElement("div");
  wrap.className = "message user";
  // data-created-at нужен для removeMessagesAfter
  if (createdAt) wrap.dataset.createdAt = createdAt;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;gap:6px;margin-top:5px;padding:0 4px;";

  const copyBtn = makeSmallBtn("Копировать", () => {
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = "✓";
      copyBtn.style.color = "#2aaa65";
      setTimeout(() => { copyBtn.textContent = "Копировать"; copyBtn.style.color = "#3a4555"; }, 2000);
    });
  });
  footer.appendChild(copyBtn);

  if (createdAt) {
    const retryBtn = makeSmallBtn("↺ Повторить", async () => {
      if (_sending) return;
      retryBtn.disabled = true;
      retryBtn.textContent = "...";
      await deleteAndResend(content, createdAt);
      retryBtn.disabled = false;
      retryBtn.textContent = "↺ Повторить";
    });

    const editBtn = makeSmallBtn("✏ Изменить", () => {
      messageInput.value = content;
      messageInput.style.height = "52px";
      const h = Math.min(messageInput.scrollHeight, 200);
      messageInput.style.height = h + "px";
      messageInput.dataset.editCreatedAt = createdAt;
      messageInput.focus();
      messageInput.style.borderColor = "#4d85c0";
      editBtn.textContent = "✏ (ред.)";
      editBtn.style.color = "#4d85c0";
    });

    footer.appendChild(retryBtn);
    footer.appendChild(editBtn);
  }

  wrap.appendChild(footer);
  return wrap;
}

// ── Тихое подтверждение рядом с кнопками ─────────────────────
function showRatingFeedback(nearEl, text) {
  nearEl.querySelector(".rating-tip")?.remove();
  const tip = document.createElement("span");
  tip.className = "rating-tip";
  tip.style.cssText = "font-size:11px;color:#4e5a6a;margin-left:6px;transition:opacity 0.5s;opacity:1;";
  tip.textContent = text;
  nearEl.appendChild(tip);
  setTimeout(() => { tip.style.opacity = "0"; }, 1500);
  setTimeout(() => { tip.remove(); }, 2100);
}

// ── Кнопки 👍 / 👎 ────────────────────────────────────────────
function makeRatingButtons(messageId, currentRating) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:4px;align-items:center;";
  if (currentRating === 1 || currentRating === -1) {
    wrap.dataset.active = String(currentRating);
  }
  const makeBtn = (emoji, value, label) => {
    const isActive    = currentRating === value;
    const activeColor = value === 1 ? "#2aaa65" : "#e05c5c";
    const activeBg    = value === 1 ? "#0d2b1a" : "#2a1010";
    const btn = document.createElement("button");
    btn.title = label;
    btn.dataset.value = String(value);
    btn.style.cssText = `
      background:${isActive ? activeBg : "none"};
      border:1px solid ${isActive ? activeColor : "#252932"};
      color:${isActive ? activeColor : "#6e7a8a"};
      border-radius:6px;padding:2px 9px;font-size:13px;cursor:pointer;transition:all 0.12s;
    `;
    btn.textContent = emoji;
    btn.addEventListener("mouseenter", () => {
      if (wrap.dataset.active !== String(value)) {
        btn.style.borderColor = activeColor;
        btn.style.color = activeColor;
      }
    });
    btn.addEventListener("mouseleave", () => {
      if (wrap.dataset.active !== String(value)) {
        btn.style.borderColor = "#252932";
        btn.style.color = "#6e7a8a";
        btn.style.background = "none";
      }
    });
    btn.addEventListener("click", async () => {
      const newRating  = parseInt(btn.dataset.value);
      const isSame     = wrap.dataset.active === String(newRating);
      const sendRating = isSame ? 0 : newRating;
      wrap.querySelectorAll("button[data-value]").forEach(b => {
        b.style.background = "none"; b.style.borderColor = "#252932"; b.style.color = "#6e7a8a";
      });
      if (isSame) {
        delete wrap.dataset.active;
        showRatingFeedback(wrap, "Оценка снята");
      } else {
        wrap.dataset.active = String(newRating);
        btn.style.background = activeBg;
        btn.style.borderColor = activeColor;
        btn.style.color = activeColor;
        showRatingFeedback(wrap, newRating === 1 ? "Полезно ✓" : "Отмечено ✓");
      }
      try {
        await api(`/api/messages/${messageId}/rate`, {
          method: "POST",
          body: JSON.stringify({ rating: sendRating }),
        });
      } catch (e) {
        wrap.querySelectorAll("button[data-value]").forEach(b => {
          b.style.background = "none"; b.style.borderColor = "#252932"; b.style.color = "#6e7a8a";
        });
        delete wrap.dataset.active;
        showRatingFeedback(wrap, "Ошибка :(");
        console.error("Ошибка оценки:", e);
      }
    });
    return btn;
  };
  wrap.appendChild(makeBtn("👍",  1, "Полезный ответ"));
  wrap.appendChild(makeBtn("👎", -1, "Бесполезный ответ"));
  return wrap;
}

// ── Группа сообщений агента ───────────────────────────────────
function makeAgentGroup(reasoningMsgs, orcMsg) {
  const wrap = document.createElement("div");
  wrap.className = "message orchestrator";

  if (reasoningMsgs.length > 0) {
    const plannerCount = reasoningMsgs.filter(m => m.role === "planner").length;
    const workerCount  = reasoningMsgs.filter(m => m.role === "worker").length;
    const parts = [];
    if (plannerCount) parts.push(`${plannerCount} план`);
    if (workerCount)  parts.push(`${workerCount} шагов`);

    const block  = document.createElement("div");
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
    const label = document.createElement("div");
    label.className = "model-label";
    label.textContent = orcMsg.model || DEFAULT_MODEL;
    wrap.appendChild(label);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(orcMsg.content || "");
    bindCopyButtons(bubble);
    wrap.appendChild(bubble);

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding:0 4px;";

    if (orcMsg.id) {
      footer.appendChild(makeRatingButtons(orcMsg.id, orcMsg.rating ?? null));
    } else {
      footer.appendChild(document.createElement("div"));
    }

    const copyAllBtn = document.createElement("button");
    copyAllBtn.style.cssText = `
      background:none;border:1px solid #252932;color:#4e5a6a;
      border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;transition:all 0.12s;
    `;
    copyAllBtn.textContent = "Копировать ответ";
    copyAllBtn.addEventListener("mouseenter", () => { copyAllBtn.style.borderColor = "#4d85c0"; copyAllBtn.style.color = "#b0c8e8"; });
    copyAllBtn.addEventListener("mouseleave", () => {
      if (!copyAllBtn.dataset.copied) { copyAllBtn.style.borderColor = "#252932"; copyAllBtn.style.color = "#4e5a6a"; }
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

// ── Стоп-кнопка ───────────────────────────────────────────────
async function stopGeneration() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (currentConversationId) {
    await fetch(`/api/chat/cancel/${currentConversationId}`, { method: "POST" }).catch(() => {});
  }
}

// ── Reasoning-блок ────────────────────────────────────────────
function makeReasoningBlock() {
  const agentWrap = document.createElement("div");
  agentWrap.className = "message orchestrator";

  const rBlock = document.createElement("div");
  rBlock.className = "reasoning-block";
  rBlock.dataset.open = "true";

  // ── Header: toggle + кнопка копирования ──────────────────
  const rHeader = document.createElement("div");
  rHeader.className = "reasoning-header";

  const rToggle = document.createElement("button");
  rToggle.className = "reasoning-toggle";
  rToggle.innerHTML = `<i class="arrow">▶</i> <span class="reasoning-dot dot-planner"></span> <span class="r-label">Агент думает...</span>`;

  const rCopyBtn = document.createElement("button");
  rCopyBtn.className = "reasoning-copy-btn";
  rCopyBtn.title = "Копировать рассуждения";
  rCopyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  const rBody = document.createElement("div");
  rBody.className = "reasoning-body";

  // ── Синхронизация состояния open/closed ──────────────────
  function _syncOpen() {
    const isOpen = rBlock.dataset.open === "true";
    rBody.hidden = !isOpen;
    rBlock.classList.toggle("open", isOpen);
  }

  rToggle.addEventListener("click", () => {
    rBlock.dataset.open = rBlock.dataset.open === "true" ? "false" : "true";
    _syncOpen();
  });

  // Копировать рассуждения (не сворачивает блок)
  rCopyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(_fullText).then(() => {
      rCopyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        rCopyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      }, 2000);
    });
  });

  rHeader.appendChild(rToggle);
  rHeader.appendChild(rCopyBtn);
  rBlock.appendChild(rHeader);
  rBlock.appendChild(rBody);
  agentWrap.appendChild(rBlock);

  _syncOpen(); // применяем начальное состояние

  const rLabel = rToggle.querySelector(".r-label");

  let _fullText = "";
  const _queue = [];
  let _typing = false;

  function _typeNextLine() {
    if (_queue.length === 0) { _typing = false; return; }
    _typing = true;
    const line = _queue.shift();
    const lineWithPrefix = (_fullText.length > 0 ? "\n" : "") + line;
    let pos = 0;
    const total = lineWithPrefix.length;
    const timer = setInterval(() => {
      pos = Math.min(pos + 2, total);
      rBody.textContent = _fullText + lineWithPrefix.slice(0, pos);
      setTimeout(() => { rBody.scrollTop = rBody.scrollHeight; }, 0);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (pos >= total) {
        clearInterval(timer);
        _fullText += lineWithPrefix;
        _typeNextLine();
      }
    }, 18);
  }

  function appendReasoning(line) {
    _queue.push(line);
    if (!_typing) _typeNextLine();
  }

  return { agentWrap, rBlock, rBody, rLabel, appendReasoning };
}

// ── Утилита: посимвольная печать markdown ────────────────────
function typewriterMarkdown(container, text, { charsPerTick = 3, delayMs = 25 } = {}) {
  return new Promise((resolve) => {
    let pos = 0;
    const total = text.length;

    const timer = setInterval(() => {
      pos = Math.min(pos + charsPerTick, total);
      container.innerHTML = renderMarkdown(text.slice(0, pos));
      bindCopyButtons(container);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      if (pos >= total) {
        clearInterval(timer);
        resolve();
      }
    }, delayMs);
  });
}

// ── SSE: читает поток и обновляет reasoning-блок ──────────────
async function consumeStream(response, { rBlock, rBody, rLabel, appendReasoning }) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";
  let   stepsDone  = 0;
  let   stepsTotal = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop();

    for (const chunk of lines) {
      const line = chunk.replace(/^data:\s*/, "").trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }

      switch (event.type) {
        case "planner_start":
          rLabel.textContent = "Планирую задачу...";
          appendReasoning("[planner] " + (event.message || ""));
          break;
        case "planner_done":
          appendReasoning("[planner] ✓ " + (event.message || ""));
          break;
        case "worker_start":
          stepsDone++;
          stepsTotal = event.steps_total || stepsTotal;
          rLabel.textContent = `Шаг ${stepsDone}${stepsTotal ? "/" + stepsTotal : ""}...`;
          appendReasoning(`[worker #${stepsDone}] ${event.message || ""}`);
          break;
        case "worker_done":
          appendReasoning(`[worker #${stepsDone}] ✓ ${event.message || ""}`);
          break;
        case "replan":
          rLabel.textContent = `Перепланирование (глубина ${event.depth || ""})...`;
          appendReasoning(`[replan] ${event.message || ""}`);
          break;
        case "fix_start":
          appendReasoning(`[fix] ${event.message || ""}`);
          break;
        case "fix_done":
          appendReasoning(`[fix] ✓ ${event.message || ""}`);
          break;
        case "dedup_start":
          rLabel.textContent = "Финальная проверка...";
          appendReasoning(`[check] ${event.message || ""}`);
          break;
        case "dedup_done":
          appendReasoning(`[check] ✓ ${event.message || ""}`);
          break;

        case "answer": {
          // Текст финального ответа — поле content (не final_answer)
          const finalText = event.content;

          rBlock.classList.remove("open");
          rBlock.dataset.open = "false";
          rBody.hidden = true;
          rLabel.textContent = `Reasoning — ...`;

          if (finalText) {
            // Создаём bubble сразу и печатаем посимвольно
            const modelLabel = document.createElement("div");
            modelLabel.className = "model-label";
            modelLabel.textContent = currentModel;

            const bubble = document.createElement("div");
            bubble.className = "message-bubble";

            const answerWrap = document.createElement("div");
            answerWrap.className = "message orchestrator";
            answerWrap.appendChild(modelLabel);
            answerWrap.appendChild(bubble);
            messagesEl.appendChild(answerWrap);
            messagesEl.scrollTop = messagesEl.scrollHeight;

            // Печатаем посимвольно
            await typewriterMarkdown(bubble, finalText, { charsPerTick: 8, delayMs: 16 });
          }

          // После печати — тихо перезагружаем из БД
          // (появятся кнопки 👍/👎 и "Копировать ответ")
          await loadMessages(currentConversationId);
          await loadConversations();
          break;
        }

        case "done":
          // done — финальное служебное событие, данные уже показаны в "answer"
          // просто обновляем список бесед если вдруг answer не было
          if (!event.final_answer) break;
          await loadConversations();
          break;
      }
    }
  }
}

// ── Единая функция SSE-стрима ─────────────────────────────────
async function runStream({ text, conversationId, rBlock, rLabel, appendReasoning, onAbort }) {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();

  setSendMode("streaming");

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        text,
        model: currentModel,
      }),
      signal: currentAbortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    await consumeStream(res, { rBlock, rBody, rLabel, appendReasoning });

  } catch (e) {
    if (e.name === "AbortError") {
      if (onAbort) onAbort();
      else {
        appendReasoning("[остановлено пользователем]");
        rLabel.textContent = "Остановлено";
        rBlock.classList.remove("open");
        rBlock.dataset.open = "false";
        rBody.hidden = true;
        await loadMessages(conversationId);
      }
    } else {
      appendReasoning("[error] " + e.message);
      rLabel.textContent = "Ошибка";
      showError(e.message);
    }
  } finally {
    currentAbortController = null;
    setSendMode("idle");
    messageInput.focus();
  }
}

// ── Удалить ветку и отправить заново ─────────────────────────
async function deleteAndResend(text, createdAt) {
  if (!currentConversationId) return;

  // Только удаляем ветку, агента НЕ запускаем здесь
  try {
    await api(`/api/chat/delete-branch/${currentConversationId}`, {
      method: "POST",
      body: JSON.stringify({ after_created_at: createdAt }),
    });
  } catch (err) {
    alert("Ошибка: " + err.message);
    return;
  }

  // Удаляем DOM-элементы начиная с редактируемого сообщения
  removeMessagesAfter(createdAt);

  // Показываем новый вопрос
  messagesEl.appendChild(makeUserBubble(text));
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const { agentWrap, rBlock, rBody, rLabel, appendReasoning } = makeReasoningBlock();
  messagesEl.appendChild(agentWrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  await runStream({
    text,
    conversationId: currentConversationId,
    rBlock, rLabel, appendReasoning,
  });
}

// ── Send ──────────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || _sending) return;

  // Режим редактирования
  const editCreatedAt = messageInput.dataset.editCreatedAt;
  if (editCreatedAt) {
    delete messageInput.dataset.editCreatedAt;
    messageInput.value = "";
    messageInput.style.height = "52px";
    messageInput.style.borderColor = "";
    await deleteAndResend(text, editCreatedAt);
    return;
  }

  // Обычная отправка
  messageInput.value = "";
  messageInput.style.height = "52px";
  messageInput.style.overflowY = "hidden";

  if (!currentConversationId) await createConversation();

  setSendMode("sending");

  messagesEl.appendChild(makeUserBubble(text));
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const { agentWrap, rBlock, rBody, rLabel, appendReasoning } = makeReasoningBlock();
  messagesEl.appendChild(agentWrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  await runStream({
    text,
    conversationId: currentConversationId,
    rBlock, rLabel, appendReasoning,
    onAbort: async () => {
      appendReasoning("[остановлено пользователем]");
      rLabel.textContent = "Остановлено";
      rBlock.classList.remove("open");
      rBlock.dataset.open = "false";
      rBody.hidden = true;
      await loadMessages(currentConversationId);
    },
  });
}

// ── Events ────────────────────────────────────────────────────
newChatBtn.addEventListener("click", createConversation);

sendBtn.addEventListener("click", () => {
  if (_sending) return;
  const text = messageInput.value.trim();
  if (!text) return;
  sendMessage();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
  if (e.key === "Escape" && messageInput.dataset.editCreatedAt) {
    delete messageInput.dataset.editCreatedAt;
    messageInput.value = "";
    messageInput.style.height = "52px";
    messageInput.style.borderColor = "";
  }
});

// Мобильный сайдбар
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebar       = document.querySelector(".sidebar");
if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });
  // Закрыть при клике на беседу
  conversationListEl.addEventListener("click", () => {
    sidebar.classList.remove("open");
  });
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  await loadConversations();
  messagesEl.innerHTML = `<div class="empty-state">Выбери беседу слева или создай новую.</div>`;
})();


// ── Model Selector ────────────────────────────────────────────
(function () {
  "use strict";

  const wrapper    = document.getElementById("msWrapper");
  const trigger    = document.getElementById("msTrigger");
  const panel      = document.getElementById("msPanel");
  const searchEl   = document.getElementById("msSearch");
  const listEl     = document.getElementById("msList");
  const emptyEl    = document.getElementById("msEmpty");
  const nameEl     = document.getElementById("msName");
  const badgeEl    = document.getElementById("msBadge");
  const hintEl     = document.getElementById("msHint");
  const refreshBtn = document.getElementById("msRefresh");

  if (!wrapper || !trigger || !panel) return;

  let allModels = [];
  let isOpen    = false;

  function icon(name) {
    const n = name.toLowerCase();
    if (n.includes("70b") || n.includes("72b")) return "💎";
    if (n.includes("32b") || n.includes("34b")) return "🔥";
    if (n.includes("22b") || n.includes("14b")) return "⚡";
    if (n.includes("7b")  || n.includes("8b"))  return "🚀";
    return "🧠";
  }

  function openPanel() {
    isOpen = true;
    trigger.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    panel.classList.add("open");
    renderList(searchEl.value);
    setTimeout(() => searchEl.focus(), 40);
  }

  function closePanel() {
    isOpen = false;
    trigger.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    panel.classList.remove("open");
    searchEl.value = "";
  }

  function renderList(q) {
    q = (q || "").toLowerCase().trim();
    const filtered = allModels.filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );

    listEl.innerHTML = "";
    emptyEl.classList.toggle("show", filtered.length === 0);

    for (const m of filtered) {
      const li = document.createElement("li");
      li.className = "ms-item" + (m.id === currentModel ? " active" : "");
      li.setAttribute("tabindex", "0");
      li.innerHTML = `
        <div class="ms-item-icon">${icon(m.id)}</div>
        <div class="ms-item-info">
          <div class="ms-item-name">${m.name}</div>
          <div class="ms-item-meta">${m.tag} · ${m.size_gb} ГБ</div>
        </div>
        <div class="ms-item-right">
          <span class="ms-item-badge ${m.processor === "GPU" ? "gpu" : "cpugpu"}">${m.processor}</span>
          <svg class="ms-check" viewBox="0 0 14 14" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="2,7 5.5,11 12,3"/>
          </svg>
        </div>`;
      li.addEventListener("click",   () => pick(m.id));
      li.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(m.id); }
      });
      listEl.appendChild(li);
    }

    const n = filtered.length;
    const w = n === 1 ? "модель"
            : [2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)
              ? "модели" : "моделей";
    hintEl.textContent = `${n} ${w} доступно`;
  }

  function pick(id) {
    const m = allModels.find(x => x.id === id);
    if (!m) return;
    currentModel        = id;
    nameEl.textContent  = m.name;
    badgeEl.textContent = m.processor;
    badgeEl.className   = "ms-badge" + (m.processor === "GPU" ? "" : " cpu");
    renderList(searchEl.value);
    closePanel();
  }

  async function fetchModels() {
    try {
      const data = await api("/api/models");
      allModels = data.models || [];
      if (!allModels.length) { nameEl.textContent = DEFAULT_MODEL; return; }
      if (!allModels.find(m => m.id === currentModel)) currentModel = allModels[0].id;
      const active = allModels.find(m => m.id === currentModel);
      if (active) {
        nameEl.textContent  = active.name;
        badgeEl.textContent = active.processor;
        badgeEl.className   = "ms-badge" + (active.processor === "GPU" ? "" : " cpu");
      }
    } catch (e) {
      nameEl.textContent = DEFAULT_MODEL;
      console.warn("[ModelSelector] ошибка:", e.message);
    }
  }

  // ── События ──────────────────────────────────────────────
  trigger.addEventListener("click", e => {
    e.stopPropagation();
    isOpen ? closePanel() : openPanel();
  });

  document.addEventListener("click", e => {
    if (isOpen && !wrapper.contains(e.target)) closePanel();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && isOpen) { closePanel(); trigger.focus(); }
  });

  searchEl.addEventListener("input", () => renderList(searchEl.value));

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("spinning");
    await fetchModels();
    renderList(searchEl.value);
    refreshBtn.classList.remove("spinning");
  });

  fetchModels();
})();