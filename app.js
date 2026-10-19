import { html, render, useState, useEffect, useRef } from "./vendor/preact-htm.js";
import { SITES, SITE_IDS, searchSite, searchText, matches, rank, title, measure, unitPrice, cartLink, waangooCartLink } from "./stores.js";

// ---------------------------------------------------------------- storage & state

const LS = {
  // Data from before the rename (saved under "saket.") is picked up once.
  get(k, d) {
    try { const v = localStorage.getItem("lobang." + k) ?? localStorage.getItem("saket." + k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem("lobang." + k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const entry = (name, quantity = 1) => ({ id: uid(), name, quantity, done: false });
const RESULT_TTL = 6 * 3600e3;

const S = {
  lists: LS.get("lists", null) ?? [
    { id: uid(), name: "This week", saved: false, items: ["milk", "eggs", "bread", "bananas"].map(n => entry(n)) },
    { id: uid(), name: "Weekly staples", saved: true,
      items: ["milk", "eggs", "bread", "basmati rice", "onions", "tomatoes"].map(n => entry(n)) },
  ],
  choices: LS.get("choices", {}),   // item key → "site|offer id" picked last time
  enabled: LS.get("enabled", SITE_IDS),
  byUnit: LS.get("byUnit", true),
  // item key → site → { status: "loading" | "failed" | "done", offers, error, at }
  results: Object.fromEntries(Object.entries(LS.get("results", {})).map(([k, v]) => [k,
    Object.fromEntries(Object.entries(v).filter(([, r]) => Date.now() - r.at < RESULT_TTL))])),
  stack: [{ screen: "home" }],
  buy: null,      // { listId, qty: {key: n}, skip: {key: bool}, pick: {key: "site|id"} }
  orders: null,   // { listId, bySite: {site: [{item, quantity, offer}]}, opened: {} }
  sheet: null,    // modal sheet: { kind, ... }
  toast: null,
};

const listeners = new Set();
let queued = false;
function emit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; listeners.forEach(l => l()); });
}
function update(fn) {
  fn?.(S);
  LS.set("lists", S.lists); LS.set("choices", S.choices); LS.set("enabled", S.enabled); LS.set("byUnit", S.byUnit);
  emit();
}
let saveResultsTimer;
function saveResults() {
  clearTimeout(saveResultsTimer);
  saveResultsTimer = setTimeout(() => {
    const out = {};
    for (const [k, v] of Object.entries(S.results)) for (const [s, r] of Object.entries(v))
      if (r.status === "done") (out[k] ??= {})[s] = { status: "done", offers: r.offers.slice(0, 12), at: r.at };
    LS.set("results", out);
  }, 800);
}

const go = route => update(s => { s.stack.push(route); s.sheet = null; });
const back = () => update(s => { if (s.stack.length > 1) s.stack.pop(); s.sheet = null; });
const home = () => update(s => { s.stack = [{ screen: "home" }]; s.sheet = null; });
let toastTimer;
function toast(msg) {
  update(s => { s.toast = msg; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => update(s => { s.toast = null; }), 2200);
}

// ---------------------------------------------------------------- lists

const keyOf = name => name.trim().toLowerCase();
const listById = id => S.lists.find(l => l.id === id);

/// What still needs buying, merged by name.
function toBuy(list) {
  const out = [];
  for (const e of list.items) {
    const name = e.name.trim();
    if (e.done || !name) continue;
    const have = out.find(i => i.key === keyOf(name));
    if (have) have.quantity += e.quantity; else out.push({ key: keyOf(name), query: name, quantity: Math.max(1, e.quantity) });
  }
  return out;
}

/// One item per line. "2x eggs", "2 x eggs" or "eggs x2" set a quantity; list bullets are ignored.
function parseItems(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let s = raw.trim().replace(/^([-*•]|\[[ x]\])\s+/i, "").trim();
    if (!s) continue;
    let q = 1, m;
    if ((m = s.match(/^(\d{1,2})\s*[x×]\s*(.+)$/i))) { q = +m[1]; s = m[2]; }
    else if ((m = s.match(/^(.+?)\s+[x×]\s*(\d{1,2})$/i))) { q = +m[2]; s = m[1]; }
    const have = out.find(i => keyOf(i.name) === keyOf(s));
    if (have) have.quantity += q; else out.push({ name: s, quantity: Math.max(1, q) });
  }
  return out;
}

function newList(saved, name, items = []) {
  const l = { id: uid(), name: name ?? "", saved, items: items.map(i => entry(i.name, i.quantity)) };
  update(s => { saved ? s.lists.push(l) : s.lists.unshift(l); });
  return l;
}

// ---------------------------------------------------------------- prices

const sites = () => SITE_IDS.filter(s => S.enabled.includes(s));
const result = (key, site) => S.results[key]?.[site];
const offersAt = (key, site) => result(key, site)?.status === "done" ? result(key, site).offers : [];
const isLoading = key => sites().some(s => result(key, s)?.status === "loading");
const failedSites = key => sites().filter(s => result(key, s)?.status === "failed");
const ref = o => `${o.site}|${o.id}`;

/// Each site is searched one item at a time so no store gets hammered; sites run in parallel.
function check(items, refresh = false) {
  for (const site of sites()) {
    const todo = items.filter(i => {
      const r = result(i.key, site);
      return !r || r.status === "failed" || (refresh && r.status === "done");
    });
    if (!todo.length) continue;
    for (const i of todo) (S.results[i.key] ??= {})[site] = { status: "loading" };
    emit();
    (async () => {
      for (const i of todo) {
        let r;
        try { r = { status: "done", offers: await searchSite(site, searchText(i.query)), at: Date.now() }; }
        catch (e) { r = { status: "failed", error: e.message || String(e) }; }
        (S.results[i.key] ??= {})[site] = r;
        emit();
        saveResults();
      }
    })();
  }
}

function options(key) { return rank(sites().flatMap(s => matches(key, offersAt(key, s))), S.byUnit); }
function otherOptions(key) {
  const matched = new Set(options(key).map(ref));
  return sites().flatMap(s => offersAt(key, s)).filter(o => !matched.has(ref(o))).sort((a, b) => a.price - b.price);
}
const cheapest = key => options(key)[0];
function defaultChoice(key) {
  const c = S.choices[key];
  return (c && [...options(key), ...otherOptions(key)].find(o => ref(o) === c)) || cheapest(key);
}

const money = n => "$" + n.toFixed(2);

/// The best match at each store, for the lobang meter.
const bestPerStore = key => sites().map(s => rank(matches(key, offersAt(key, s)), S.byUnit)[0]).filter(Boolean);

/// Roughly how much picking `o` saves versus the middle price at the other shops, compared per
/// 100g / 100ml / piece. Shops without a similar-sized pack are left out, and each comparison is
/// capped at 2× so an odd match can't inflate the number.
function saving(key, o, qty) {
  const m = o && measure(o);
  if (!m) return 0;
  const u = unitPrice(o);
  // Only similar pack sizes count: a 1kg jar isn't "saving" against a 132g tub.
  const eq = bestPerStore(key).filter(b => b.site !== o.site && measure(b)?.unit === m.unit)
    .filter(b => { const r = measure(b).amount / m.amount; return r >= .5 && r <= 2; })
    .map(b => Math.min(2, unitPrice(b).value / u.value) * o.price).sort((a, b) => a - b);
  if (!eq.length) return 0;
  return Math.max(0, (eq[Math.floor((eq.length - 1) / 2)] - o.price) * qty);
}

// ---------------------------------------------------------------- icons

const P = {
  back: "M15 4.5 7.5 12l7.5 7.5",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  check: "m5 12.5 4.5 4.5L19 7",
  chevron: "m9 5 7 7-7 7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  arrow: "M7 17 17 7M8 7h9v9",
  share: "M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1",
  addSquare: "M12 8v8M8 12h8M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
  copy: "M9 9h10v12H9zM5 15V3h10",
  bag: "M6 8h12l-1 13H7L6 8zM9 8V6a3 3 0 0 1 6 0v2",
  down: "M12 4v15M5 12l7 7 7-7",
  up: "M12 20V5M5 12l7-7 7 7",
};
function Icon({ name, size = 20, stroke = 2.4 }) {
  if (name === "more") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>`;
  if (name === "sliders") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke} stroke-linecap="round">
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>`;
  if (name === "cart") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4" fill="currentColor"/><circle cx="17" cy="20" r="1.4" fill="currentColor"/></svg>`;
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke}
    stroke-linecap="round" stroke-linejoin="round"><path d=${P[name]}/></svg>`;
}

// ---------------------------------------------------------------- shared bits

const Wordmark = ({ size = "md" }) => html`<span class=${"wordmark " + size}>got lobang<i>?</i></span>`;
const Dot = ({ site }) => html`<span class="dot" style=${{ background: SITES[site].color }}></span>`;
const StoreTag = ({ site }) => html`<span class="store-tag" style=${{ "--c": SITES[site].color }}>${SITES[site].name}</span>`;
const Sticker = ({ children, tone = "yellow", tilt = -4 }) =>
  html`<span class=${"sticker " + tone} style=${{ "--tilt": `${tilt}deg` }}>${children}</span>`;

/// Singlish loading lines, rotated so the wait feels shorter.
const KAYPOH = ["Kaypoh-ing 5 shops…", "Asking the uncles…", "Comparing like auntie at pasar…", "Checking where got cheaper…"];
function Kaypoh() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI(x => x + 1), 1600); return () => clearInterval(t); }, []);
  return html`<span class="shimmer">${KAYPOH[i % KAYPOH.length]}</span>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Supper run ah?" : h < 12 ? "Morning! What you need today?" : h < 18 ? "Afternoon! Need to buy what?" : "Evening! Stock up a bit?";
}

function Thumb({ offer, size = 56 }) {
  const [bad, setBad] = useState(false);
  const s = SITES[offer.site];
  return offer.image && !bad
    ? html`<img class="thumb" src=${offer.image} loading="lazy" style=${{ width: size, height: size }} onError=${() => setBad(true)} alt="" />`
    : html`<div class="thumb ph" style=${{ width: size, height: size, "--c": s.color }}><${Icon} name="bag" size=${size * 0.42} /></div>`;
}

function Stepper({ value, onChange, min = 1 }) {
  return html`<div class="stepper" onClick=${e => e.stopPropagation()}>
    <button aria-label="Less" disabled=${value <= min} onClick=${() => onChange(Math.max(min, value - 1))}><${Icon} name="minus" size=${15} stroke=${3} /></button>
    <span>${value}</span>
    <button aria-label="More" disabled=${value >= 99} onClick=${() => onChange(Math.min(99, value + 1))}><${Icon} name="plus" size=${15} stroke=${3} /></button>
  </div>`;
}

function NavBar({ backLabel, onBack, title: t, right }) {
  return html`<header class="nav">
    <div class="nav-side">${onBack && html`<button class="nav-back" onClick=${onBack}><${Icon} name="back" size=${20} stroke=${3} />${backLabel}</button>`}</div>
    <div class="nav-title">${t}</div>
    <div class="nav-side right">${right}</div>
  </header>`;
}

function Toggle({ on, onChange }) {
  return html`<button role="switch" aria-checked=${on} class=${"toggle" + (on ? " on" : "")} onClick=${() => onChange(!on)}><i></i></button>`;
}

/// Totals for a list: best price per item, the shops involved and the lobang (savings).
function listStats(list) {
  const items = toBuy(list);
  let total = 0, saved = 0;
  const shops = new Set();
  for (const i of items) {
    const o = cheapest(i.key);
    if (!o) continue;
    total += o.price * i.quantity;
    saved += saving(i.key, o, i.quantity);
    shops.add(o.site);
  }
  return { items, total, saved, shops: shops.size, loading: items.some(i => isLoading(i.key)) };
}

// ---------------------------------------------------------------- home

function Home() {
  const lists = S.lists.filter(l => !l.saved), choped = S.lists.filter(l => l.saved);
  useEffect(() => { check(S.lists.flatMap(toBuy)); }, []);
  const stats = Object.fromEntries(S.lists.map(l => [l.id, listStats(l)]));
  const found = lists.reduce((t, l) => t + stats[l.id].saved, 0);

  const card = (l, i) => {
    const st = stats[l.id];
    return html`<button class="list-card" key=${l.id} onClick=${() => go({ screen: "list", id: l.id })}>
      <div class=${"list-icon" + (l.saved ? " choped" : "")}>${l.saved ? "🧻" : html`<${Icon} name="cart" size=${22} />`}</div>
      <div class="list-text">
        <div class="list-name">${l.name || "Untitled list"}</div>
        <div class="list-sub">${st.items.length ? `${st.items.length} item${st.items.length === 1 ? "" : "s"}` : "Empty"}
          ${st.items.length > 0 && (st.loading && !st.total ? html` · <span class="shimmer">checking</span>` : st.total > 0 && html` · <b>${money(st.total)}</b>`)}</div>
        ${st.items.length > 0 && html`<div class="list-peek">${st.items.slice(0, 4).map(i => i.query).join(" · ")}${st.items.length > 4 ? " …" : ""}</div>`}
      </div>
      ${st.saved >= 0.5 && html`<${Sticker} tone="red" tilt=${i % 2 ? 5 : -5}>save ${money(st.saved)}<//>`}
    </button>`;
  };

  return html`<div class="screen home">
    <header class="home-head">
      <div>
        <${Wordmark} size="lg" />
        <div class="greet">${greeting()}</div>
      </div>
      <button class="round-btn" aria-label="Shops" onClick=${() => update(s => { s.sheet = { kind: "settings" }; })}><${Icon} name="sliders" /></button>
    </header>
    <main class="scroll pad-bottom">
      ${found >= 0.5 && html`<div class="meter">
        <div class="meter-label">Lobang found on your lists</div>
        <div class="meter-value">${money(found)}</div>
        <div class="meter-sub">cheaper than the usual price at the other shops</div>
        <span class="meter-stamp">SHIOK!</span>
      </div>`}
      <h2 class="section"><span>Your lists</span></h2>
      ${lists.length ? html`<div class="cards">${lists.map(card)}</div>` : html`<div class="empty-mini">No list yet. Tap <b>New list</b> lah.</div>`}
      <h2 class="section"><span>Choped lists</span> <em>🧻</em></h2>
      ${choped.length ? html`<div class="cards">${choped.map(card)}</div>`
        : html`<div class="empty-mini">Lists you buy every week? <b>Chope</b> them — they'll wait here for you.</div>`}
    </main>
    <div class="bottom-bar">
      <button class="btn primary wide" onClick=${() => { const l = newList(false); go({ screen: "list", id: l.id, focus: true }); }}>
        <${Icon} name="plus" size=${20} stroke=${3.2} /> New list</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- list

function ItemRow({ list, item }) {
  const [dx, setDx] = useState(0);
  const touch = useRef(null);
  const set = patch => update(() => Object.assign(item, patch));
  const key = keyOf(item.name);
  const best = item.done || !key ? null : cheapest(key);
  const loading = !item.done && key && isLoading(key);
  const remove = () => update(() => { list.items = list.items.filter(i => i !== item); });
  const settled = key && sites().every(s => result(key, s)?.status && result(key, s).status !== "loading");

  const onStart = e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: dx, dir: null }; };
  const onMove = e => {
    const t = touch.current; if (!t) return;
    const mx = e.touches[0].clientX - t.x, my = e.touches[0].clientY - t.y;
    if (!t.dir) t.dir = Math.abs(mx) > Math.abs(my) + 4 ? "x" : Math.abs(my) > 6 ? "y" : null;
    if (t.dir === "x") setDx(Math.max(-96, Math.min(0, t.base + mx)));
  };
  const onEnd = () => { if (touch.current?.dir === "x") setDx(dx < -48 ? -88 : 0); touch.current = null; };

  return html`<div class="row-wrap">
    <button class="row-delete" onClick=${remove} aria-label="Delete"><${Icon} name="trash" size=${20} /></button>
    <div class=${"item" + (item.done ? " done" : "")} style=${{ transform: `translateX(${dx}px)` }}
      onTouchStart=${onStart} onTouchMove=${onMove} onTouchEnd=${onEnd}>
      <button class="tick" aria-label=${item.done ? "Untick" : "Got already"} onClick=${() => set({ done: !item.done })}>
        ${item.done && html`<${Icon} name="check" size=${15} stroke=${3.6} />`}</button>
      <div class="item-main">
        <input class="item-name" value=${item.name} enterkeyhint="done" autocomplete="off" autocorrect="off"
          onInput=${e => set({ name: e.target.value })}
          onBlur=${e => { if (!e.target.value.trim()) remove(); else check(toBuy(list)); }}
          onKeyDown=${e => e.key === "Enter" && e.target.blur()} />
        <div class="item-hint">
          ${item.done ? "Got already — not buying"
            : loading && !best ? html`<${Kaypoh} />`
            : best ? html`<${Dot} site=${best.site} /><b>${money(best.price)}</b> at ${SITES[best.site].name}`
            : settled ? html`<span class="warn">No lobang leh — pick one when buying</span>` : ""}
        </div>
      </div>
      ${!item.done && html`<${Stepper} value=${item.quantity} onChange=${q => set({ quantity: q })} />`}
    </div>
  </div>`;
}

function ListScreen({ id, focus }) {
  const list = listById(id);
  const [draft, setDraft] = useState("");
  const titleRef = useRef(), addRef = useRef();
  useEffect(() => { if (list) check(toBuy(list)); }, [id]);
  useEffect(() => { if (focus) setTimeout(() => titleRef.current?.focus(), 350); }, []);
  if (!list) return html`<div class="screen"><${NavBar} backLabel="Lists" onBack=${back} /></div>`;

  const st = listStats(list);
  const open = list.items.filter(i => !i.done), done = list.items.filter(i => i.done);

  const add = text => {
    const parsed = parseItems(text);
    if (!parsed.length) return;
    update(() => {
      for (const p of parsed) {
        const have = list.items.find(i => !i.done && keyOf(i.name) === keyOf(p.name));
        if (have) have.quantity = Math.min(99, have.quantity + p.quantity); else list.items.push(entry(p.name, p.quantity));
      }
    });
    setDraft("");
    check(toBuy(list));
  };

  return html`<div class="screen">
    <${NavBar} backLabel="Lists" onBack=${back} right=${html`
      <button class="round-btn" aria-label="More" onClick=${() => update(s => { s.sheet = { kind: "listMenu", id }; })}><${Icon} name="more" /></button>`} />
    <main class="scroll pad-bottom-lg">
      <input ref=${titleRef} class="big-title" placeholder="Name this list" value=${list.name}
        onInput=${e => update(() => { list.name = e.target.value; })} onKeyDown=${e => e.key === "Enter" && addRef.current?.focus()} />
      <div class="chips">
        <button class=${"chope" + (list.saved ? " on" : "")} onClick=${() => {
          update(() => { list.saved = !list.saved; }); toast(list.saved ? "🧻 Choped! It's under Choped lists" : "Unchoped liao"); }}>
          <span class="tissue">🧻</span>${list.saved ? "Choped!" : "Chope this list"}
        </button>
        <span class="chip">${st.items.length} to buy</span>
        ${done.length > 0 && html`<span class="chip">${done.length} got already</span>`}
        ${st.items.length > 0 && (st.loading ? html`<span class="chip"><i class="spin"></i>checking</span>`
          : html`<span class="chip good"><${Icon} name="check" size=${12} stroke=${3.6} /> prices in</span>`)}
      </div>
      <div class="add-bar">
        <input ref=${addRef} placeholder="Add something — try “2x eggs”" value=${draft} enterkeyhint="done" autocomplete="off"
          onInput=${e => setDraft(e.target.value)}
          onKeyDown=${e => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
          onPaste=${e => { const t = e.clipboardData?.getData("text") ?? ""; if (t.includes("\n")) { e.preventDefault(); add(t); } }} />
        <button class="add-go" aria-label="Add" disabled=${!draft.trim()} onClick=${() => add(draft)}><${Icon} name="plus" size=${22} stroke=${3.4} /></button>
      </div>
      ${list.items.length === 0 ? html`<div class="empty">
          <div class="empty-bubble">Eh, list empty leh.<br />Need what?</div>
          <p>Add items above. We kaypoh Sheng Siong, FairPrice, Waangoo, Selvi and KiasuMart, then tell you where got cheaper.</p>
          <p class="muted">Tip: paste a whole list — one item per line.</p></div>`
        : html`<div class="items">${open.map(i => html`<${ItemRow} key=${i.id} list=${list} item=${i} />`)}</div>
          ${done.length > 0 && html`<h2 class="section small"><span>Got already</span></h2>
            <div class="items">${done.map(i => html`<${ItemRow} key=${i.id} list=${list} item=${i} />`)}</div>`}
          <p class="hint-foot">Tick what you already have · swipe left to delete</p>`}
    </main>
    <div class="bottom-bar summary">
      <div class="est">
        ${st.saved >= 0.5 ? html`<${Sticker} tone="red" tilt=${-3}>lobang: save ${money(st.saved)}<//>`
          : html`<div class="est-label">Best total</div>`}
        <div class="est-value">${st.total > 0 ? money(st.total) : "—"}</div>
        <div class="est-sub">${st.shops ? `across ${st.shops} shop${st.shops === 1 ? "" : "s"}` : st.loading ? "checking…" : ""}</div>
      </div>
      <button class="btn primary" disabled=${!st.items.length} onClick=${() => startBuy(list)}>
        Buy ${st.items.length || ""} <${Icon} name="chevron" size=${18} stroke=${3.2} /></button>
    </div>
  </div>`;
}

function startBuy(list) {
  const items = toBuy(list);
  update(s => { s.buy = { listId: list.id, qty: Object.fromEntries(items.map(i => [i.key, i.quantity])), skip: {}, pick: {} }; });
  check(items);
  go({ screen: "buy" });
}

// ---------------------------------------------------------------- buy (pick products)

function OptionCard({ o, selected, best, onPick }) {
  const u = unitPrice(o);
  return html`<button class=${"opt" + (selected ? " sel" : "")} onClick=${onPick}>
    ${best && html`<span class="best-tag">LOBANG!</span>`}
    ${selected && html`<span class="sel-tick"><${Icon} name="check" size=${13} stroke=${3.8} /></span>`}
    <${Thumb} offer=${o} size=${68} />
    <div class="opt-name">${title(o)}</div>
    <div class="opt-foot">
      <div class="opt-price">${money(o.price)}</div>
      ${u && html`<div class="opt-unit">${money(u.value)}/${u.label}</div>`}
      <${StoreTag} site=${o.site} />
    </div>
  </button>`;
}

function BuyItem({ item }) {
  const b = S.buy;
  const opts = options(item.key), others = otherOptions(item.key);
  const [more, setMore] = useState(false);
  const loading = isLoading(item.key);
  const chosen = b.pick[item.key] ?? (defaultChoice(item.key) && ref(defaultChoice(item.key)));
  const skip = !!b.skip[item.key];
  const best = opts[0] && ref(opts[0]);
  // Your pick is shown first; the rest stay best-value order.
  const all = opts.length ? [...opts, ...(more ? others : [])] : others;
  const shown = [...all.filter(o => ref(o) === chosen), ...all.filter(o => ref(o) !== chosen)];
  const failed = failedSites(item.key);
  return html`<section class=${"buy-item" + (skip ? " skipped" : "")}>
    <div class="buy-head">
      <div class="buy-title">
        <div class="buy-name">${item.query}</div>
        <div class="buy-sub">${loading && !opts.length ? html`<${Kaypoh} />`
          : opts.length ? `${opts.length} option${opts.length === 1 ? "" : "s"}${loading ? " · still checking" : ""}`
          : others.length ? html`<span class="warn">No exact lobang — closest ones</span>` : "Cannot find leh"}
          ${failed.length > 0 && html` · <span class="warn">${failed.map(s => SITES[s].name).join(", ")} never answer</span>`}</div>
      </div>
      <button class=${"skip" + (skip ? " on" : "")} onClick=${() => update(s => { s.buy.skip[item.key] = !skip; })}>${skip ? "Skipped" : "Skip"}</button>
      ${!skip && html`<${Stepper} value=${b.qty[item.key]} onChange=${q => update(s => { s.buy.qty[item.key] = q; })} />`}
    </div>
    ${!skip && html`<div class="strip">
      ${shown.map(o => html`<${OptionCard} key=${ref(o)} o=${o} selected=${ref(o) === chosen} best=${ref(o) === best}
        onPick=${() => update(s => { s.buy.pick[item.key] = ref(o); })} />`)}
      ${loading && !shown.length && [0, 1, 2].map(i => html`<div class="opt skeleton" key=${"sk" + i}></div>`)}
      ${opts.length > 0 && others.length > 0 && !more && html`<button class="opt more-card" onClick=${() => setMore(true)}>
        <b>+${others.length}</b><span>see more</span></button>`}
      ${!loading && !shown.length && html`<div class="none-card">Nothing leh. Try a simpler name on the list, like “basmati rice”.</div>`}
    </div>`}
  </section>`;
}

function chosenOffer(key) {
  const c = S.buy.pick[key];
  return (c && [...options(key), ...otherOptions(key)].find(o => ref(o) === c)) || defaultChoice(key);
}

function BuyScreen() {
  const b = S.buy, list = b && listById(b.listId);
  if (!list) return html`<div class="screen"><${NavBar} backLabel="List" onBack=${back} /></div>`;
  const items = toBuy(list);
  const lines = items.filter(i => !b.skip[i.key]).map(i => ({ item: i.query, key: i.key, quantity: b.qty[i.key] ?? i.quantity, offer: chosenOffer(i.key) }));
  const ready = lines.filter(l => l.offer);
  const bySite = {};
  for (const l of ready) (bySite[l.offer.site] ??= []).push(l);
  const total = ready.reduce((t, l) => t + l.offer.price * l.quantity, 0);
  const saved = ready.reduce((t, l) => t + saving(l.key, l.offer, l.quantity), 0);
  const missing = lines.length - ready.length;
  const n = Object.keys(bySite).length;

  const next = () => {
    update(s => {
      for (const l of ready) s.choices[l.key] = ref(l.offer);
      s.orders = { listId: list.id, bySite, saved, opened: {} };
    });
    go({ screen: "stores" });
  };

  return html`<div class="screen">
    <${NavBar} backLabel="List" onBack=${back} title="Pick your lobang" />
    <main class="scroll pad-bottom-xl">
      <p class="lead">Cheapest one already picked for you. Want other size, flavour or shop? Just tap.</p>
      ${items.map(i => html`<${BuyItem} key=${i.key} item=${i} />`)}
    </main>
    <div class="bottom-bar summary tall">
      <div class="site-totals">${Object.entries(bySite).map(([s, ls]) => html`<span class="site-total" key=${s}>
        <${Dot} site=${s} />${SITES[s].name} <b>${money(ls.reduce((t, l) => t + l.offer.price * l.quantity, 0))}</b></span>`)}
        ${missing > 0 && html`<span class="site-total warn">${missing} not picked</span>`}</div>
      <div class="summary-row">
        <div class="est">
          ${saved >= 0.5 ? html`<${Sticker} tone="red" tilt=${-3}>save ${money(saved)}<//>` : html`<div class="est-label">Total</div>`}
          <div class="est-value">${money(total)}</div>
        </div>
        <button class="btn primary" disabled=${!n} onClick=${next}>Go ${n} shop${n === 1 ? "" : "s"} <${Icon} name="chevron" size=${18} stroke=${3.2} /></button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- receipts (checkout)

const pad = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;

function StoresScreen() {
  const o = S.orders;
  if (!o) return html`<div class="screen"><${NavBar} backLabel="Pick" onBack=${back} /></div>`;
  const entries = Object.entries(o.bySite);
  const total = entries.reduce((t, [, ls]) => t + ls.reduce((a, l) => a + l.offer.price * l.quantity, 0), 0);
  const count = entries.reduce((t, [, ls]) => t + ls.length, 0);
  const openedCount = Object.values(o.opened).filter(Boolean).length;
  const allDone = count > 0 && openedCount >= count;
  const mark = id => update(s => { s.orders.opened[id] = true; });
  const finish = () => {
    const list = listById(o.listId);
    update(() => { if (list && !list.saved) for (const it of list.items) if (o.opened[keyOf(it.name)]) it.done = true; });
    home();
    toast("Shiok! Bought items ticked off.");
  };

  return html`<div class="screen">
    <${NavBar} backLabel="Pick" onBack=${back} title="Your receipts" />
    <main class="scroll pad-bottom-lg">
      <div class="hero">
        <div class="hero-label">${o.saved >= 0.5 ? "Lobang get" : "All in"}</div>
        <div class="hero-total">${o.saved >= 0.5 ? money(o.saved) : money(total)}</div>
        <div class="hero-sub">${o.saved >= 0.5 ? `saved · ${money(total)} total` : ""} across ${entries.length} shop${entries.length === 1 ? "" : "s"}</div>
        <div class="progress"><i style=${{ width: `${count ? (openedCount / count) * 100 : 0}%` }}></i></div>
        <div class="hero-note">${allDone ? "All in the cart liao. Settle!" : `${openedCount} of ${count} in cart · tap Add on each item`}</div>
        ${allDone && html`<span class="stamp">SETTLED</span>`}
      </div>
      ${entries.map(([site, ls]) => {
        const s = SITES[site];
        const sub = ls.reduce((t, l) => t + l.offer.price * l.quantity, 0);
        const doneHere = ls.filter(l => o.opened[l.key]).length;
        return html`<section class="receipt" key=${site} style=${{ "--c": s.color }}>
          <div class="r-head">
            <div class="r-store">${s.name}</div>
            <div class="r-meta">${ls.length} item${ls.length === 1 ? "" : "s"} · ${doneHere} in cart</div>
          </div>
          <div class="r-rule"></div>
          ${ls.map(l => {
            const cl = cartLink(l.offer, l.quantity);
            const did = o.opened[l.key];
            return html`<div class="r-line" key=${l.key}>
              <${Thumb} offer=${l.offer} size=${44} />
              <div class="r-text">
                <div class="r-name">${pad(title(l.offer), 60)}</div>
                <div class="r-sub">${l.quantity} × ${money(l.offer.price)}<span class="r-amt">${money(l.offer.price * l.quantity)}</span></div>
              </div>
              <a class=${"r-btn" + (did ? " did" : "")} href=${cl ?? l.offer.url} target="_blank" rel="noopener" onClick=${() => mark(l.key)}>
                ${did ? html`<${Icon} name="check" size=${16} stroke=${3.6} />` : cl ? "Add" : "Open"}</a>
            </div>`;
          })}
          <div class="r-rule"></div>
          <div class="r-total"><span>TOTAL</span><span>${money(sub)}</span></div>
          <div class="r-actions">
            ${site === "waangoo" && ls.every(l => l.offer.variant) && html`<a class="btn small fill" href=${waangooCartLink(ls)} target="_blank" rel="noopener"
              onClick=${() => update(st => { for (const l of ls) st.orders.opened[l.key] = true; })}><${Icon} name="cart" size=${17} /> Add all</a>`}
            <a class="btn small" href=${s.cart} target="_blank" rel="noopener">Open cart <${Icon} name="arrow" size=${15} stroke=${2.8} /></a>
          </div>
        </section>`;
      })}
      <p class="hint-foot">${["fairPrice", "shengSiong"].some(x => o.bySite[x]) ? "FairPrice and Sheng Siong open the product page — tap Add to Cart there. " : ""}First time, you may need to log in to each shop.</p>
    </main>
    <div class="bottom-bar"><button class="btn primary wide" onClick=${finish}><${Icon} name="check" size=${19} stroke=${3.4} /> Settle liao</button></div>
  </div>`;
}

// ---------------------------------------------------------------- sheets

function Sheet({ children, onClose }) {
  return html`<div class="sheet-bg" onClick=${onClose}><div class="sheet" onClick=${e => e.stopPropagation()}>
    <div class="grabber"></div>${children}</div></div>`;
}

function SettingsSheet() {
  const close = () => update(s => { s.sheet = null; });
  return html`<${Sheet} onClose=${close}>
    <h3 class="sheet-title">Which shops to kaypoh?</h3>
    <div class="group">
      ${SITE_IDS.map(id => html`<div class="group-row" key=${id}><${Dot} site=${id} /><span class="grow">${SITES[id].name}</span>
        <${Toggle} on=${S.enabled.includes(id)} onChange=${on => {
          update(s => { s.enabled = on ? SITE_IDS.filter(x => x === id || s.enabled.includes(x)) : s.enabled.filter(x => x !== id); });
          if (on) check(S.lists.flatMap(toBuy));
        }} /></div>`)}
    </div>
    <div class="group">
      <div class="group-row"><span class="grow">Compare by unit price<small>Per 100g / 100ml / piece — so the bigger pack wins when it's really cheaper</small></span>
        <${Toggle} on=${S.byUnit} onChange=${v => update(s => { s.byUnit = v; })} /></div>
      <button class="group-row link" onClick=${() => { update(s => { s.results = {}; }); LS.set("results", {}); check(S.lists.flatMap(toBuy)); close(); toast("Checking all prices again"); }}>
        <${Icon} name="refresh" size=${18} /><span class="grow">Check all prices again</span></button>
    </div>
    <button class="btn primary wide" onClick=${close}>Can</button>
  <//>`;
}

function ListMenu({ id }) {
  const list = listById(id);
  const close = () => update(s => { s.sheet = null; });
  if (!list) return null;
  const act = (label, icon, fn, danger) => html`<button class=${"menu-row" + (danger ? " danger" : "")} onClick=${fn}>
    ${icon.length <= 2 ? html`<span class="menu-emoji">${icon}</span>` : html`<${Icon} name=${icon} size=${19} />`}<span>${label}</span></button>`;
  return html`<${Sheet} onClose=${close}>
    <h3 class="sheet-title">${list.name || "Untitled list"}</h3>
    <div class="group">
      ${list.saved && act("Start shopping from this", "cart", () => {
        const l = newList(false, list.name, list.items);
        update(s => { s.stack = [{ screen: "home" }, { screen: "list", id: l.id }]; s.sheet = null; });
      })}
      ${act(list.saved ? "Unchope" : "Chope this list", "🧻", () => { update(() => { list.saved = !list.saved; }); close(); })}
      ${act("Duplicate", "copy", () => { const l = newList(list.saved, `${list.name || "List"} copy`, list.items); update(s => { s.stack.pop(); s.stack.push({ screen: "list", id: l.id }); s.sheet = null; }); })}
      ${act("Check prices again", "refresh", () => { check(toBuy(list), true); close(); })}
      ${act("Shops…", "sliders", () => update(s => { s.sheet = { kind: "settings" }; }))}
    </div>
    <div class="group">${act("Delete list", "trash", () => update(s => { s.sheet = { kind: "confirmDelete", id }; }), true)}</div>
  <//>`;
}

function ConfirmDelete({ id }) {
  const list = listById(id);
  return html`<${Sheet} onClose=${() => update(s => { s.sheet = null; })}>
    <h3 class="sheet-title">Delete “${list?.name || "Untitled list"}”?</h3>
    <p class="sheet-text">Gone for good, cannot undo ah.</p>
    <button class="btn danger wide" onClick=${() => { update(s => { s.lists = s.lists.filter(l => l.id !== id); }); home(); }}>Delete</button>
    <button class="btn wide" style=${{ marginTop: "12px" }} onClick=${() => update(s => { s.sheet = null; })}>Don't</button>
  <//>`;
}

// ---------------------------------------------------------------- install screen

const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_IPAD = /iPad/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IN_APP = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|GSA\/|Messenger/.test(UA);
const BROWSER = /CriOS/.test(UA) ? "Chrome" : /FxiOS/.test(UA) ? "Firefox" : /EdgiOS/.test(UA) ? "Edge" : "Safari";
const STANDALONE = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

function QR({ text }) {
  const ref = useRef();
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "vendor/qrcode.js";
    s.onload = () => {
      const q = window.qrcode(0, "M"); q.addData(text); q.make();
      if (ref.current) ref.current.innerHTML = q.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
    };
    document.head.append(s);
  }, []);
  return html`<div class="qr" ref=${ref}></div>`;
}

const ShareGlyph = () => html`<span class="glyph"><${Icon} name="share" size=${17} stroke=${2.2} /></span>`;
const AddGlyph = () => html`<span class="glyph"><${Icon} name="addSquare" size=${17} stroke=${2.2} /></span>`;
const MoreGlyph = () => html`<span class="glyph"><${Icon} name="more" size=${17} /></span>`;

function InstallHero() {
  return html`<div class="install-hero">
    <img class="app-icon" src="icons/apple-touch-icon.png" alt="" />
    <${Wordmark} size="xl" />
    <p>The cheapest groceries in Singapore.<br />Five shops, one list — we kaypoh for you.</p>
    <div class="store-dots">${SITE_IDS.map((id, i) => html`<span key=${id} style=${{ "--c": SITES[id].color, "--tilt": `${[-4, 3, -2, 4, -3][i]}deg` }}>${SITES[id].name}</span>`)}</div>
  </div>`;
}

function Install({ onSkip }) {
  const url = location.href.split("#")[0].replace(/[?&]browser\b/, "");
  if (!IS_IOS) {
    return html`<div class="install">
      <${InstallHero} />
      <div class="install-card">
        <h2>Made for iPhone</h2>
        <p class="muted">Scan with your iPhone camera, then add it to your Home Screen.</p>
        <${QR} text=${url} />
        <div class="url">${url.replace(/^https?:\/\//, "")}</div>
        <button class="btn wide" onClick=${onSkip}>Just use it here</button>
      </div></div>`;
  }
  let steps, arrow = null;
  if (IN_APP) {
    steps = [[html`Tap ${MoreGlyph()} or the menu`, "It's at the top or bottom of this app."],
      [html`Choose <b>Open in Safari</b>`, "Installing only works from Safari."],
      [html`Follow the steps there`, "Ten seconds only."]];
  } else if (BROWSER !== "Safari") {
    steps = [[html`Tap ${ShareGlyph()} <b>Share</b>`, `In ${BROWSER}'s address bar, top right.`],
      [html`Tap ${AddGlyph()} <b>Add to Home Screen</b>`, "Scroll down a bit if you don't see it."],
      [html`Tap <b>Add</b>`, "Then open got lobang? from your Home Screen. Done!"]];
    arrow = "top";
  } else {
    steps = [[html`Tap ${ShareGlyph()} <b>Share</b>`, IS_IPAD ? "Top right, beside the address bar."
        : html`In Safari's toolbar. Don't see it? Tap ${MoreGlyph()} first.`],
      [html`Tap ${AddGlyph()} <b>Add to Home Screen</b>`, "Scroll down — or tap View More if it's hiding."],
      [html`Keep <b>Open as Web App</b> on, tap <b>Add</b>`, "Then open got lobang? from your Home Screen. Done!"]];
    arrow = IS_IPAD ? "top" : "bottom";
  }
  return html`<div class="install">
    <${InstallHero} />
    <div class="install-card">
      <h2>Put it on your Home Screen lah</h2>
      <p class="muted">Works like a real app — full screen, no App Store, free.</p>
      <ol class="steps">${steps.map(([t, d], i) => html`<li key=${i}><span class="num">${i + 1}</span><div><div class="step-t">${t}</div><div class="step-d">${d}</div></div></li>`)}</ol>
      <button class="link-btn" onClick=${onSkip}>Nah, just use it in the browser</button>
    </div>
    ${arrow && html`<div class=${"pointer " + arrow}><span>${arrow === "top" ? "Share here" : "Share is down here"}</span>
      <${Icon} name=${arrow === "top" ? "up" : "down"} size=${22} stroke=${3.2} /></div>`}
  </div>`;
}

// ---------------------------------------------------------------- root

function App() {
  const [, force] = useState(0);
  const [skip, setSkip] = useState(() => STANDALONE || /[?&]browser\b/.test(location.search) || sessionStorage.getItem("lobang.browser") === "1");
  useEffect(() => { const l = () => force(x => x + 1); listeners.add(l); return () => listeners.delete(l); }, []);
  useEffect(() => {
    // Sheng Siong's socket is dropped while the app is in the background; prices that failed are retried on return.
    const vis = () => { if (document.visibilityState === "visible") check(S.lists.flatMap(toBuy)); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);
  if (!skip) return html`<${Install} onSkip=${() => { sessionStorage.setItem("lobang.browser", "1"); setSkip(true); }} />`;

  const top = S.stack[S.stack.length - 1];
  const screen = top.screen === "list" ? html`<${ListScreen} key=${"l" + top.id} id=${top.id} focus=${top.focus} />`
    : top.screen === "buy" ? html`<${BuyScreen} key="buy" />`
    : top.screen === "stores" ? html`<${StoresScreen} key="stores" />`
    : html`<${Home} key="home" />`;
  const sh = S.sheet;
  return html`<div class="app">
    ${screen}
    ${sh?.kind === "settings" && html`<${SettingsSheet} />`}
    ${sh?.kind === "listMenu" && html`<${ListMenu} id=${sh.id} />`}
    ${sh?.kind === "confirmDelete" && html`<${ConfirmDelete} id=${sh.id} />`}
    ${S.toast && html`<div class="toast">${S.toast}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById("root"));

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
