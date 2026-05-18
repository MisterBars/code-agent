const DEFAULT_MODEL = "qwen2.5-coder:7b";

let currentConversationId  = null;
let currentAbortController = null;   // для стоп-кнопки
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

function setSending(state) {
  _sending = state;
  sendBtn.disabled = state;
  // показываем/скрываем стоп-кнопку
  document.getElementById("stop-btn")?.classList.toggle("hidden", !state);
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
  text = text.replace(/\{'example':\s*'((?:[^'\\]|\\.)*)',\s*'code':\s*'((?:[^'\\]|\\.)*)'\}/g,
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
      // Передаём created_at для кнопок повтора/редактирования
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

// ── Удалить ветку и отправить заново ─────────────────────────
async function deleteAndResend(text, createdAt) {
  if (!currentConversationId) return;

  // 1. Удаляем сообщения после редактируемого
  try {
    await api(`/api/chat/edit/${currentConversationId}`, {
      method: "POST",
      body: JSON.stringify({ text, after_created_at: createdAt }),
    });
  } catch (err) {
    alert("Ошибка: " + err.message);
    return;
  }

  // 2. Перезагружаем — покажет усечённую историю без удалённых сообщений
  await loadMessages(currentConversationId);

  // 3. Показываем новый вопрос и reasoning (как в sendMessage)
  messagesEl.appendChild(makeUserBubble(text));
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const { agentWrap, rBlock, rBody, rLabel, appendReasoning } = makeReasoningBlock();
  messagesEl.appendChild(agentWrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  setSendMode("streaming");

  try {
    currentAbortController = new AbortController();

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: currentConversationId, text }),
      signal: currentAbortController.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    await consumeStream(response, { rBlock, rBody, rLabel, appendReasoning });

  } catch (err) {
    if (err.name === "AbortError") {
      appendReasoning("[остановлено]");
      rLabel.textContent = "Остановлено";
      rBlock.classList.remove("open");
      await loadMessages(currentConversationId);
    } else {
      appendReasoning("[error] " + err.message);
      rLabel.textContent = "Ошибка";
    }
  } finally {
    currentAbortController = null;
    setSendMode("idle");
    messageInput.focus();
  }
}

// ── Пузырь вопроса пользователя ──────────────────────────────
function makeUserBubble(content, createdAt) {
  const wrap = document.createElement("div");
  wrap.className = "message user";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;justify-content:flex-end;gap:6px;margin-top:5px;padding:0 4px;";

  // Копировать
  const copyBtn = makeSmallBtn("Копировать", () => {
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = "✓";
      copyBtn.style.color = "#2aaa65";
      setTimeout(() => { copyBtn.textContent = "Копировать"; copyBtn.style.color = "#3a4555"; }, 2000);
    });
  });

  footer.appendChild(copyBtn);

  // Повторить и Изменить — только если есть timestamp (сохранённые сообщения)
  if (createdAt) {
    // Повторить — удалить ветку и отправить тот же текст
    const retryBtn = makeSmallBtn("↺ Повторить", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "...";
      await deleteAndResend(content, createdAt);
      retryBtn.disabled = false;
      retryBtn.textContent = "↺ Повторить";
    });

    // Изменить — вставить текст в поле, пометить как редактирование
    const editBtn = makeSmallBtn("✏ Изменить", () => {
      messageInput.value = content;
      messageInput.style.height = "52px";
      const h = Math.min(messageInput.scrollHeight, 200);
      messageInput.style.height = h + "px";
      messageInput.dataset.editCreatedAt = createdAt;  // флаг редактирования
      messageInput.focus();
      // Визуальный намёк что это редактирование
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
      const ratingWrap = makeRatingButtons(orcMsg.id, orcMsg.rating ?? null);
      footer.appendChild(ratingWrap);
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

function setSendMode(mode) {
  // mode: "idle" | "sending" | "streaming"
  if (mode === "idle") {
    sendBtn.textContent = "↑";
    sendBtn.title = "";
    sendBtn.style.background = "";
    sendBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.style.borderColor = "";
    sendBtn.onclick = null;
  } else if (mode === "sending") {
    sendBtn.textContent = "…";
    sendBtn.disabled = true;
    messageInput.disabled = true;
  } else if (mode === "streaming") {
    sendBtn.textContent = "■";
    sendBtn.title = "Остановить";
    sendBtn.style.background = "#5a2020";
    sendBtn.disabled = false;
    sendBtn.onclick = (e) => { e.stopPropagation(); stopGeneration(); };
  }
}

// Создаёт и возвращает reasoning-блок для вставки в DOM
function makeReasoningBlock() {
  const agentWrap = document.createElement("div");
  agentWrap.className = "message orchestrator";

  const rBlock = document.createElement("div");
  rBlock.className = "reasoning-block open";

  const rToggle = document.createElement("button");
  rToggle.className = "reasoning-toggle";
  rToggle.innerHTML = `<i class="arrow">▶</i> <span class="reasoning-dot dot-planner"></span> <span class="r-label">Агент думает...</span>`;
  rToggle.addEventListener("click", () => rBlock.classList.toggle("open"));

  const rBody = document.createElement("div");
  rBody.className = "reasoning-body";
  rBody.style.display = "block";

  rBlock.appendChild(rToggle);
  rBlock.appendChild(rBody);
  agentWrap.appendChild(rBlock);

  const rLabel = rToggle.querySelector(".r-label");

  function appendReasoning(line) {
    rBody.textContent += line + "\n";
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  return { agentWrap, rBlock, rBody, rLabel, appendReasoning };
}

// Читает SSE-стрим и обновляет reasoning-блок
async function consumeStream(response, { rBlock, rLabel, appendReasoning }) {
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
          stepsTotal = event.steps_total || 0;
          appendReasoning("[planner] " + (event.message || ""));
          if (stepsTotal > 0) rLabel.textContent = `Выполняю 0 / ${stepsTotal} шагов...`;
          break;
        case "worker_start":
          rLabel.textContent = `Шаг ${event.step} / ${event.steps_total || stepsTotal}...`;
          appendReasoning(`[worker] → ${event.message || ""}`);
          break;
        case "worker_done":
          stepsDone++;
          rLabel.textContent = `Шаг ${event.step} / ${stepsTotal} готов`;
          appendReasoning(`[worker] ✓ ${event.message || ""}`);
          break;
        case "replan":
          appendReasoning(`[replan] ↺ ${event.message || ""}`);
          break;
        case "dedup_start":
          rLabel.textContent = "Финальная проверка...";
          appendReasoning(`[check] ${event.message || ""}`);
          break;
        case "dedup_done":
          appendReasoning(`[check] ✓ ${event.message || ""}`);
          break;
        case "answer":
          rBlock.classList.remove("open");
          rLabel.textContent = `Reasoning — ${stepsDone} шагов`;
          await loadMessages(currentConversationId);
          await loadConversations();
          break;
        case "done":
          if (!event.final_answer) break;
          rBlock.classList.remove("open");
          rLabel.textContent = `Reasoning — готово`;
          await loadMessages(currentConversationId);
          await loadConversations();
          break;
      }
    }
  }
}

// ── Send ──────────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  // Режим редактирования — удалить ветку и переотправить
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

  // Показываем вопрос сразу (без createdAt — кнопки появятся после loadMessages)
  messagesEl.appendChild(makeUserBubble(text));
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Reasoning-блок через общую функцию
  const { agentWrap, rBlock, rBody, rLabel, appendReasoning } = makeReasoningBlock();
  messagesEl.appendChild(agentWrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    currentAbortController = new AbortController();
    setSendMode("streaming");

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: currentConversationId, text }),
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    await consumeStream(response, { rBlock, rBody, rLabel, appendReasoning });

  } catch (err) {
    if (err.name === "AbortError") {
      appendReasoning("[остановлено пользователем]");
      rLabel.textContent = "Остановлено";
      rBlock.classList.remove("open");
      await loadMessages(currentConversationId);
    } else {
      appendReasoning("[error] " + err.message);
      rLabel.textContent = "Ошибка";
      setTimeout(() => { if (!rBody.textContent.trim()) agentWrap.remove(); }, 3000);
    }
  } finally {
    currentAbortController = null;
    setSendMode("idle");
    messageInput.focus();
  }
}

async function submitEdit(messageId, createdAt, newText) {
  // 1. Удаляем ветку
  await api(`/api/chat/delete-branch/${currentConversationId}`, {
    method: "POST",
    body: JSON.stringify({ after_created_at: createdAt }),
  });
  // 2. Удаляем блоки из DOM после этого сообщения
  removeMessagesAfter(createdAt);
  // 3. Запускаем SSE-стрим как обычный новый запрос
  await runStream({
    text: newText,
    conversationId: currentConversationId,
    onDone: () => loadMessages(currentConversationId),
  });
}

async function retryMessage(userText) {
  // Удаляем блоки после этого сообщения — уже делается на бэке через /api/chat/edit
  // Здесь только запускаем стрим
  if (_sending) return;
  await runStream({
    text: userText,
    conversationId: currentConversationId,
    onDone: () => loadMessages(currentConversationId),
  });
}

// ── Единая функция SSE-стрима (используется везде) ────────────────────────
async function runStream({ text, conversationId, model, onDone }) {
  // Отменяем предыдущий запрос если был
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();

  setSending(true);

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        text,
        model: model || DEFAULT_MODEL,
      }),
      signal: currentAbortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(part.slice(6));
          handleStreamEvent(event);
          if (event.type === "done") {
            if (onDone) onDone(event);
            return;
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") showError(e.message);
  } finally {
    setSending(false);
    currentAbortController = null;
  }
}

// ── Events ────────────────────────────────────────────────────
newChatBtn.addEventListener("click", createConversation);
sendBtn.addEventListener("click", () => {
  if (_sending) return;   // ← guard
  const text = messageInput.value.trim();
  if (!text) return;
  sendMessage(text);
});
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
  // Escape — отменить режим редактирования
  if (e.key === "Escape" && messageInput.dataset.editCreatedAt) {
    delete messageInput.dataset.editCreatedAt;
    messageInput.value = "";
    messageInput.style.height = "52px";
    messageInput.style.borderColor = "";
  }
});

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  await loadConversations();
  messagesEl.innerHTML = `<div class="empty-state">Выбери беседу слева или создай новую.</div>`;
})();