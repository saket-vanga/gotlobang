// Live chat: messages go through the relay to the developer as Discord DMs, and their replies come back here.
// The chat (its id, token and messages) is kept on this device so you can leave and come back.
import { RELAY } from "../stores.js";

const $ = id => document.getElementById(id);
const KEY = "lobang.chat";
const params = new URLSearchParams(location.search);
const FROM = params.get("from") === "mac" ? "Mac app"
  : navigator.standalone || matchMedia("(display-mode: standalone)").matches ? "iPhone app" : "website";
if (FROM === "Mac app") $("back").href = "../mac/";

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = c => { try { c ? localStorage.setItem(KEY, JSON.stringify(c)) : localStorage.removeItem(KEY); } catch {} };
let chat = load();

async function api(path, init) {
  const r = await fetch(RELAY + path, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "Couldn't reach support"), { status: r.status });
  return d;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- rendering

const time = iso => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function render() {
  $("startForm").hidden = !!chat;
  $("chatBox").hidden = !chat;
  if (!chat) return;
  const log = $("log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = "";
  for (const m of chat.messages) {
    const b = document.createElement("div");
    b.className = `bubble ${m.from}${m.pending ? " pending" : ""}${m.failed ? " failed" : ""}`;
    const t = document.createElement("div");
    t.textContent = m.text;
    const meta = document.createElement("small");
    meta.textContent = m.failed ? "Not sent — tap to retry" : m.pending ? "Sending…" : `${m.from === "support" ? (m.name || "Support") + " · " : ""}${time(m.at)}`;
    b.append(t, meta);
    if (m.failed) b.addEventListener("click", () => resend(m));
    log.append(b);
  }
  if (!chat.messages.some(m => m.from === "support")) {
    const n = document.createElement("div");
    n.className = "chat-note";
    n.textContent = "Message sent! We'll reply here — usually within a few hours. You can close this page; your chat is saved.";
    log.append(n);
  }
  if (nearBottom || chat.justSent) log.scrollTop = log.scrollHeight;
  chat.justSent = false;
}

function setStatus(text, bad) {
  $("chatStatus").textContent = text;
  $("chatStatus").classList.toggle("bad", !!bad);
}

// ---------------------------------------------------------------- start / send

$("startForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const text = String(f.get("text") ?? "").trim();
  if (!text) return;
  $("startBtn").disabled = true;
  $("startBtn").textContent = "Starting…";
  $("startError").hidden = true;
  try {
    const d = await post("/chat/start", {
      name: f.get("name"), contact: f.get("contact"), text, from: FROM,
      device: navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 180),
    });
    chat = { chat: d.chat, token: d.token, name: d.name, after: d.after, messages: [] };
    save(chat);
    render();
    await poll();
  } catch (err) {
    if (err.status === 503) { $("startForm").hidden = true; $("unavailable").hidden = false; return; }
    $("startError").textContent = err.message;
    $("startError").hidden = false;
  } finally {
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Start chat";
  }
});

async function send(text) {
  const m = { id: `local-${Date.now()}`, from: "you", text, at: new Date().toISOString(), pending: true };
  chat.messages.push(m);
  chat.justSent = true;
  render();
  try {
    const d = await post("/chat/send", { chat: chat.chat, token: chat.token, name: chat.name, text });
    m.id = d.id;
    m.pending = false;
  } catch {
    m.pending = false;
    m.failed = true;
  }
  save(chat);
  render();
}

function resend(m) {
  chat.messages = chat.messages.filter(x => x !== m);
  send(m.text);
}

$("sendForm").addEventListener("submit", e => {
  e.preventDefault();
  const text = $("msg").value.trim();
  if (!text || !chat) return;
  $("msg").value = "";
  grow();
  send(text);
});
// Enter sends, Shift+Enter makes a new line.
$("msg").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("sendForm").requestSubmit(); }
});
const grow = () => { const t = $("msg"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
$("msg").addEventListener("input", grow);

$("endChat").addEventListener("click", () => {
  if (!confirm("End this chat? It'll be cleared from this device.")) return;
  chat = null;
  save(null);
  render();
});

// ---------------------------------------------------------------- polling

let timer, quietSince = Date.now(), polling = false;

/// Fetches everything after the newest message we have. Server copies of your own messages replace the
/// local "sending" ones; replies from support are added.
async function poll() {
  if (!chat || polling) return;
  polling = true;
  try {
    const d = await api(`/chat/poll?chat=${chat.chat}&token=${chat.token}&after=${chat.after ?? 0}`);
    let fresh = false;
    for (const m of d.messages) {
      if (chat.messages.some(x => x.id === m.id)) continue;
      if (m.from === "you") {
        const local = chat.messages.find(x => x.from === "you" && String(x.id).startsWith("local-") && x.text === m.text);
        if (local) { Object.assign(local, m, { pending: false }); continue; }
      } else fresh = true;
      chat.messages.push(m);
    }
    if (d.messages.length) chat.after = d.messages[d.messages.length - 1].id;
    // Discord order by id; anything still only local (sending or failed) stays at the end.
    const real = m => /^\d+$/.test(m.id);
    chat.messages.sort((a, b) => real(a) && real(b) ? (BigInt(a.id) < BigInt(b.id) ? -1 : 1) : real(a) ? -1 : real(b) ? 1 : 0);
    if (fresh) { quietSince = Date.now(); chat.justSent = true; ping(); }
    save(chat);
    render();
    setStatus("Connected · replies appear here");
  } catch (err) {
    if (err.status === 403) { chat = null; save(null); render(); return; }
    setStatus("Reconnecting…", true);
  } finally {
    polling = false;
  }
}

/// Every 4 s while the page is open and recently active, slowing to 15 s after 10 quiet minutes;
/// paused while the page is hidden.
function schedule() {
  clearTimeout(timer);
  if (document.hidden || !chat) return;
  const wait = Date.now() - quietSince > 10 * 60e3 ? 15000 : 4000;
  timer = setTimeout(async () => { await poll(); schedule(); }, wait);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); schedule(); } else clearTimeout(timer); });

/// A short chime and title badge when support replies.
function ping() {
  if (document.hidden) document.title = "💬 New reply · got lobang?";
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.08, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.25);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.25);
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Help & support · got lobang?"; });

if (!RELAY) { $("startForm").hidden = true; $("unavailable").hidden = false; }
else { render(); if (chat) { poll(); schedule(); } }
// Keep polling going after a chat starts.
$("startForm").addEventListener("submit", () => setTimeout(schedule, 500));
if (params.has("chat")) location.hash = "#chat";
