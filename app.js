import { html, render, useState, useEffect, useRef } from "./vendor/preact-htm.js";
import { SITES, SITE_IDS, searchSite, searchText, matches, rank, title, unitPrice, cartLink, waangooCartLink } from "./stores.js";

// ---------------------------------------------------------------- storage & state

const LS = {
  get(k, d) { try { const v = localStorage.getItem("saket." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("saket." + k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const entry = (name, quantity = 1) => ({ id: uid(), name, quantity, done: false });
const RESULT_TTL = 6 * 3600e3;

const S = {
  lists: LS.get("lists", null) ?? [
    { id: uid(), name: "This Week", saved: false, items: ["milk", "eggs", "bread", "bananas"].map(n => entry(n)) },
    { id: uid(), name: "Weekly Staples", saved: true,
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

// ---------------------------------------------------------------- icons

const P = {
  back: "M15 4.5 7.5 12l7.5 7.5",
  more: null,
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  check: "m5 12.5 4.5 4.5L19 7",
  chevron: "m9 5 7 7-7 7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  gear: null,
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  arrow: "M7 17 17 7M8 7h9v9",
  cart: "M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2",
  share: "M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1",
  addSquare: "M12 8v8M8 12h8M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
  x: "M6 6l12 12M18 6 6 18",
  copy: "M9 9h10v12H9zM5 15V3h10",
  bag: "M6 8h12l-1 13H7L6 8zM9 8V6a3 3 0 0 1 6 0v2",
};
function Icon({ name, size = 20, stroke = 2.2 }) {
  if (name === "more") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
  if (name === "seal") return html`<svg width=${size} height=${size} viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 1.8l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22.2l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/>
    <path d="m8 12.3 2.8 2.7L16 9.6" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (name === "gear") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>`;
  if (name === "cart") return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round">
    <path d=${P.cart}/><circle cx="10" cy="20" r="1.4" fill="currentColor"/><circle cx="17" cy="20" r="1.4" fill="currentColor"/></svg>`;
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke}
    stroke-linecap="round" stroke-linejoin="round"><path d=${P[name]}/></svg>`;
}

// ---------------------------------------------------------------- shared bits

const Dot = ({ site }) => html`<span class="dot" style=${{ background: SITES[site].color }}></span>`;
const StoreTag = ({ site }) => html`<span class="store-tag" style=${{ "--c": SITES[site].color }}>${SITES[site].name}</span>`;

function Thumb({ offer, size = 56 }) {
  const [bad, setBad] = useState(false);
  const s = SITES[offer.site];
  return offer.image && !bad
    ? html`<img class="thumb" src=${offer.image} loading="lazy" style=${{ width: size, height: size }} onError=${() => setBad(true)} alt="" />`
    : html`<div class="thumb ph" style=${{ width: size, height: size, "--c": s.color }}><${Icon} name="bag" size=${size * 0.42} /></div>`;
}

function Stepper({ value, onChange, min = 1 }) {
  return html`<div class="stepper" onClick=${e => e.stopPropagation()}>
    <button aria-label="Less" disabled=${value <= min} onClick=${() => onChange(Math.max(min, value - 1))}><${Icon} name="minus" size=${15} stroke=${2.6} /></button>
    <span>${value}</span>
    <button aria-label="More" disabled=${value >= 99} onClick=${() => onChange(Math.min(99, value + 1))}><${Icon} name="plus" size=${15} stroke=${2.6} /></button>
  </div>`;
}

function NavBar({ backLabel, onBack, title: t, right }) {
  return html`<header class="nav">
    <div class="nav-side">${onBack && html`<button class="nav-back" onClick=${onBack}><${Icon} name="back" size=${22} stroke=${2.6} />${backLabel}</button>`}</div>
    <div class="nav-title">${t}</div>
    <div class="nav-side right">${right}</div>
  </header>`;
}

function Toggle({ on, onChange }) {
  return html`<button role="switch" aria-checked=${on} class=${"toggle" + (on ? " on" : "")} onClick=${() => onChange(!on)}><i></i></button>`;
}

// ---------------------------------------------------------------- home

function Home() {
  const lists = S.lists.filter(l => !l.saved), saved = S.lists.filter(l => l.saved);
  useEffect(() => { check(S.lists.flatMap(toBuy)); }, []);
  const card = l => {
    const items = toBuy(l);
    const total = items.reduce((t, i) => t + (cheapest(i.key)?.price ?? 0) * i.quantity, 0);
    const loading = items.some(i => isLoading(i.key));
    return html`<button class="list-card" key=${l.id} onClick=${() => go({ screen: "list", id: l.id })}>
      <div class=${"list-icon" + (l.saved ? " saved" : "")}><${Icon} name=${l.saved ? "seal" : "cart"} size=${l.saved ? 24 : 21} /></div>
      <div class="list-text">
        <div class="list-name">${l.name || "Untitled list"}</div>
        <div class="list-sub">${items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "Empty"}
          ${items.length > 0 && (loading ? html` · <span class="shimmer">checking prices</span>` : total > 0 && html` · from <b>${money(total)}</b>`)}</div>
        ${items.length > 0 && html`<div class="list-peek">${items.slice(0, 4).map(i => i.query).join(", ")}${items.length > 4 ? "…" : ""}</div>`}
      </div>
      <span class="chev"><${Icon} name="chevron" size=${18} /></span>
    </button>`;
  };
  return html`<div class="screen home">
    <header class="home-head">
      <div class="brand"><div class="brand-badge"><${Icon} name="cart" size=${22} /></div>
        <div><div class="brand-name">SAKET</div><div class="brand-sub">Five stores. One list. Always the cheapest.</div></div></div>
      <button class="round-btn" aria-label="Stores" onClick=${() => update(s => { s.sheet = { kind: "settings" }; })}><${Icon} name="gear" /></button>
    </header>
    <main class="scroll pad-bottom">
      <h2 class="section">Shopping lists</h2>
      ${lists.length ? html`<div class="cards">${lists.map(card)}</div>` : html`<div class="empty-mini">No lists yet — start one below.</div>`}
      <h2 class="section"><span class="seal-ic"><${Icon} name="seal" size=${18} /></span> Saved lists</h2>
      ${saved.length ? html`<div class="cards">${saved.map(card)}</div>`
        : html`<div class="empty-mini">Tap <b>Save</b> on a list to keep it here for next time.</div>`}
    </main>
    <div class="bottom-bar">
      <button class="primary wide" onClick=${() => { const l = newList(false); go({ screen: "list", id: l.id, focus: true }); }}>
        <${Icon} name="plus" size=${20} stroke=${2.8} /> New List</button>
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
      <button class="tick" aria-label=${item.done ? "Untick" : "Tick off"} onClick=${() => set({ done: !item.done })}>
        ${item.done && html`<${Icon} name="check" size=${15} stroke=${3.2} />`}</button>
      <div class="item-main">
        <input class="item-name" value=${item.name} enterkeyhint="done" autocomplete="off" autocorrect="off"
          onInput=${e => set({ name: e.target.value })}
          onBlur=${e => { if (!e.target.value.trim()) remove(); else check(toBuy(list)); }}
          onKeyDown=${e => e.key === "Enter" && e.target.blur()} />
        <div class="item-hint">
          ${item.done ? "Already have it"
            : loading && !best ? html`<span class="shimmer">Checking 5 stores…</span>`
            : best ? html`<${Dot} site=${best.site} /> from <b>${money(best.price)}</b> at ${SITES[best.site].name}`
            : key && sites().every(s => result(key, s)?.status && result(key, s).status !== "loading")
              ? html`<span class="warn">No exact match — you can pick one in Buy</span>` : ""}
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

  const items = toBuy(list);
  const open = list.items.filter(i => !i.done), done = list.items.filter(i => i.done);
  const loading = items.some(i => isLoading(i.key));
  const picks = items.map(i => [i, cheapest(i.key)]).filter(([, o]) => o);
  const total = picks.reduce((t, [i, o]) => t + o.price * i.quantity, 0);
  const stores = new Set(picks.map(([, o]) => o.site)).size;

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
        <button class=${"save-chip" + (list.saved ? " on" : "")} onClick=${() => {
          update(() => { list.saved = !list.saved; }); toast(list.saved ? "Saved — find it under Saved lists" : "Moved back to Shopping lists"); }}>
          ${list.saved ? html`<${Icon} name="seal" size=${17} /> Saved` : html`<${Icon} name="check" size=${15} stroke=${3} /> Save list`}
        </button>
        <span class="chip">${items.length} to buy</span>
        ${done.length > 0 && html`<span class="chip">${done.length} ticked off</span>`}
        ${items.length > 0 && (loading ? html`<span class="chip live"><i class="spin"></i>Checking prices</span>`
          : html`<span class="chip good"><${Icon} name="check" size=${12} stroke=${3.4} /> Prices ready</span>`)}
      </div>
      <div class="add-bar">
        <span class="add-ic"><${Icon} name="plus" size=${18} stroke=${2.8} /></span>
        <input ref=${addRef} placeholder="Add an item — try “2x eggs”" value=${draft} enterkeyhint="done" autocomplete="off"
          onInput=${e => setDraft(e.target.value)}
          onKeyDown=${e => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
          onPaste=${e => { const t = e.clipboardData?.getData("text") ?? ""; if (t.includes("\n")) { e.preventDefault(); add(t); } }} />
        ${draft.trim() && html`<button class="add-go" onClick=${() => add(draft)}>Add</button>`}
      </div>
      ${list.items.length === 0 ? html`<div class="empty">
          <div class="empty-art"><${Icon} name="cart" size=${40} /></div>
          <h3>What do you need?</h3>
          <p>Add items above. SAKET checks Sheng Siong, FairPrice, Waangoo, Selvi and KiasuMart and finds the cheapest.</p>
          <p class="muted">Tip: paste a whole list — one item per line.</p></div>`
        : html`<div class="items">${open.map(i => html`<${ItemRow} key=${i.id} list=${list} item=${i} />`)}</div>
          ${done.length > 0 && html`<h2 class="section small">Ticked off</h2>
            <div class="items">${done.map(i => html`<${ItemRow} key=${i.id} list=${list} item=${i} />`)}</div>`}
          <p class="hint-foot">Tick items you already have · swipe left to delete</p>`}
    </main>
    <div class="bottom-bar summary">
      <div class="est">
        <div class="est-label">Estimated total</div>
        <div class="est-value">${total > 0 ? money(total) : "—"}</div>
        <div class="est-sub">${stores ? `across ${stores} store${stores === 1 ? "" : "s"}` : loading ? "checking…" : ""}</div>
      </div>
      <button class="primary" disabled=${!items.length} onClick=${() => startBuy(list)}>
        <${Icon} name="cart" size=${19} /> Buy ${items.length || ""} item${items.length === 1 ? "" : "s"}</button>
    </div>
  </div>`;
}

function startBuy(list) {
  const items = toBuy(list);
  update(s => { s.buy = { listId: list.id, qty: Object.fromEntries(items.map(i => [i.key, i.quantity])), skip: {}, pick: {} }; });
  check(items);
  go({ screen: "buy" });
}

// ---------------------------------------------------------------- buy (choose products)

function OptionCard({ o, selected, best, onPick }) {
  const u = unitPrice(o);
  return html`<button class=${"opt" + (selected ? " sel" : "")} onClick=${onPick}>
    ${best && html`<span class="best-tag">CHEAPEST</span>`}
    ${selected && html`<span class="sel-tick"><${Icon} name="check" size=${13} stroke=${3.4} /></span>`}
    <${Thumb} offer=${o} size=${64} />
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
        <div class="buy-sub">${loading && !opts.length ? html`<span class="shimmer">Searching stores…</span>`
          : opts.length ? `${opts.length} option${opts.length === 1 ? "" : "s"}${loading ? " · still checking" : ""}`
          : others.length ? html`<span class="warn">No exact match — closest results</span>` : "Nothing found"}
          ${failed.length > 0 && html` · <span class="warn">${failed.map(s => SITES[s].name).join(", ")} didn't answer</span>`}</div>
      </div>
      <button class=${"skip" + (skip ? " on" : "")} onClick=${() => update(s => { s.buy.skip[item.key] = !skip; })}>${skip ? "Skipped" : "Skip"}</button>
      ${!skip && html`<${Stepper} value=${b.qty[item.key]} onChange=${q => update(s => { s.buy.qty[item.key] = q; })} />`}
    </div>
    ${!skip && html`<div class="strip">
      ${shown.map(o => html`<${OptionCard} key=${ref(o)} o=${o} selected=${ref(o) === chosen} best=${ref(o) === best}
        onPick=${() => update(s => { s.buy.pick[item.key] = ref(o); })} />`)}
      ${loading && !shown.length && [0, 1, 2].map(i => html`<div class="opt skeleton" key=${"sk" + i}></div>`)}
      ${opts.length > 0 && others.length > 0 && !more && html`<button class="opt more-card" onClick=${() => setMore(true)}>
        <b>+${others.length}</b><span>more results</span></button>`}
      ${!loading && !shown.length && html`<div class="none-card">No products found. Try a simpler name on the list, like “basmati rice”.</div>`}
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
  const missing = lines.length - ready.length;
  const n = Object.keys(bySite).length;

  const go2 = () => {
    update(s => {
      for (const l of ready) s.choices[l.key] = ref(l.offer);
      s.orders = { listId: list.id, bySite, opened: {} };
    });
    go({ screen: "stores" });
  };

  return html`<div class="screen">
    <${NavBar} backLabel="List" onBack=${back} title="Choose products" />
    <main class="scroll pad-bottom-xl">
      <p class="lead">The cheapest is picked for you. Tap another card to switch size, flavour or store.</p>
      ${items.map(i => html`<${BuyItem} key=${i.key} item=${i} />`)}
    </main>
    <div class="bottom-bar summary tall">
      <div class="site-totals">${Object.entries(bySite).map(([s, ls]) => html`<span class="site-total" key=${s}>
        <${Dot} site=${s} />${SITES[s].name} <b>${money(ls.reduce((t, l) => t + l.offer.price * l.quantity, 0))}</b></span>`)}
        ${missing > 0 && html`<span class="site-total warn">${missing} not chosen</span>`}</div>
      <div class="summary-row">
        <div class="est"><div class="est-label">Total</div><div class="est-value">${money(total)}</div></div>
        <button class="primary" disabled=${!n} onClick=${go2}>Continue to ${n} store${n === 1 ? "" : "s"} <${Icon} name="chevron" size=${17} stroke=${2.8} /></button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- stores (checkout)

function StoresScreen() {
  const o = S.orders;
  if (!o) return html`<div class="screen"><${NavBar} backLabel="Choose" onBack=${back} /></div>`;
  const entries = Object.entries(o.bySite);
  const total = entries.reduce((t, [, ls]) => t + ls.reduce((a, l) => a + l.offer.price * l.quantity, 0), 0);
  const count = entries.reduce((t, [, ls]) => t + ls.length, 0);
  const openedCount = Object.values(o.opened).filter(Boolean).length;
  const mark = id => update(s => { s.orders.opened[id] = true; });
  const finish = () => {
    const list = listById(o.listId);
    update(s => {
      if (list && !list.saved) for (const it of list.items) if (o.opened[keyOf(it.name)]) it.done = true;
    });
    home();
    toast("Nice! Bought items are ticked off.");
  };

  return html`<div class="screen">
    <${NavBar} backLabel="Choose" onBack=${back} title="Your carts" />
    <main class="scroll pad-bottom-lg">
      <div class="hero">
        <div class="hero-total">${money(total)}</div>
        <div class="hero-sub">${count} item${count === 1 ? "" : "s"} across ${entries.length} store${entries.length === 1 ? "" : "s"}</div>
        <div class="progress"><i style=${{ width: `${count ? (openedCount / count) * 100 : 0}%` }}></i></div>
        <div class="hero-note">${openedCount === count ? "All done — finish below." : "Tap Add on each item. It opens the store with that product ready to add to your cart."}</div>
      </div>
      ${entries.map(([site, ls]) => {
        const s = SITES[site];
        const sub = ls.reduce((t, l) => t + l.offer.price * l.quantity, 0);
        const doneHere = ls.filter(l => o.opened[l.key]).length;
        return html`<section class="store-card" key=${site} style=${{ "--c": s.color }}>
          <div class="store-head">
            <div><div class="store-name">${s.name}</div><div class="store-sub">${doneHere} of ${ls.length} added</div></div>
            <div class="store-total">${money(sub)}</div>
          </div>
          ${ls.map(l => {
            const link = cartLink(l.offer, l.quantity) ?? l.offer.url;
            const did = o.opened[l.key];
            return html`<div class="cart-row" key=${l.key}>
              <${Thumb} offer=${l.offer} size=${48} />
              <div class="cart-text"><div class="cart-name">${title(l.offer)}</div>
                <div class="cart-sub">${l.quantity} × ${money(l.offer.price)} · for “${l.item}”</div></div>
              <a class=${"cart-btn" + (did ? " did" : "")} href=${link} target="_blank" rel="noopener" onClick=${() => mark(l.key)}>
                ${did ? html`<${Icon} name="check" size=${15} stroke=${3.2} />` : cartLink(l.offer, l.quantity) ? "Add" : "Open"}</a>
            </div>`;
          })}
          <div class="store-actions">
            ${site === "waangoo" && ls.every(l => l.offer.variant) && html`<a class="store-btn fill" href=${waangooCartLink(ls)} target="_blank" rel="noopener"
              onClick=${() => update(st => { for (const l of ls) st.orders.opened[l.key] = true; })}><${Icon} name="cart" size=${17} /> Add all to cart</a>`}
            <a class="store-btn" href=${s.cart} target="_blank" rel="noopener">Open cart <${Icon} name="arrow" size=${15} /></a>
          </div>
        </section>`;
      })}
      <p class="hint-foot">${["fairPrice", "shengSiong"].some(x => o.bySite[x]) ? "FairPrice and Sheng Siong open the product page — tap Add to Cart there. " : ""}You may need to sign in to each store the first time.</p>
    </main>
    <div class="bottom-bar"><button class="primary wide" onClick=${finish}><${Icon} name="check" size=${19} stroke=${3} /> Done shopping</button></div>
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
    <h3 class="sheet-title">Stores</h3>
    <div class="group">
      ${SITE_IDS.map(id => html`<div class="group-row" key=${id}><${Dot} site=${id} /><span class="grow">${SITES[id].name}</span>
        <${Toggle} on=${S.enabled.includes(id)} onChange=${on => {
          update(s => { s.enabled = on ? SITE_IDS.filter(x => x === id || s.enabled.includes(x)) : s.enabled.filter(x => x !== id); });
          if (on) check(S.lists.flatMap(toBuy));
        }} /></div>`)}
    </div>
    <div class="group">
      <div class="group-row"><span class="grow">Compare by unit price<small>Per 100g / 100ml / piece, so bigger packs win when they're better value</small></span>
        <${Toggle} on=${S.byUnit} onChange=${v => update(s => { s.byUnit = v; })} /></div>
      <button class="group-row link" onClick=${() => { update(s => { s.results = {}; }); LS.set("results", {}); check(S.lists.flatMap(toBuy)); close(); toast("Refreshing all prices"); }}>
        <${Icon} name="refresh" size=${18} /><span class="grow">Refresh all prices</span></button>
    </div>
    <button class="primary wide" onClick=${close}>Done</button>
  <//>`;
}

function ListMenu({ id }) {
  const list = listById(id);
  const close = () => update(s => { s.sheet = null; });
  if (!list) return null;
  const act = (label, icon, fn, danger) => html`<button class=${"menu-row" + (danger ? " danger" : "")} onClick=${fn}>
    <${Icon} name=${icon} size=${19} /><span>${label}</span></button>`;
  return html`<${Sheet} onClose=${close}>
    <h3 class="sheet-title">${list.name || "Untitled list"}</h3>
    <div class="group">
      ${list.saved && act("Start shopping from this", "cart", () => {
        const l = newList(false, list.name, list.items);
        update(s => { s.stack = [{ screen: "home" }, { screen: "list", id: l.id }]; s.sheet = null; });
      })}
      ${act(list.saved ? "Move back to Shopping lists" : "Save list", "seal", () => { update(() => { list.saved = !list.saved; }); close(); })}
      ${act("Duplicate", "copy", () => { const l = newList(list.saved, `${list.name || "List"} copy`, list.items); update(s => { s.stack.pop(); s.stack.push({ screen: "list", id: l.id }); s.sheet = null; }); })}
      ${act("Refresh prices", "refresh", () => { check(toBuy(list), true); close(); })}
      ${act("Stores…", "gear", () => update(s => { s.sheet = { kind: "settings" }; }))}
    </div>
    <div class="group">${act("Delete list", "trash", () => update(s => { s.sheet = { kind: "confirmDelete", id }; }), true)}</div>
  <//>`;
}

function ConfirmDelete({ id }) {
  const list = listById(id);
  return html`<${Sheet} onClose=${() => update(s => { s.sheet = null; })}>
    <h3 class="sheet-title">Delete “${list?.name || "Untitled list"}”?</h3>
    <p class="sheet-text">This can't be undone.</p>
    <button class="danger-btn wide" onClick=${() => { update(s => { s.lists = s.lists.filter(l => l.id !== id); }); home(); }}>Delete list</button>
    <button class="ghost wide" onClick=${() => update(s => { s.sheet = null; })}>Cancel</button>
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

const ShareGlyph = () => html`<span class="glyph"><${Icon} name="share" size=${17} stroke=${2} /></span>`;
const AddGlyph = () => html`<span class="glyph"><${Icon} name="addSquare" size=${17} stroke=${2} /></span>`;
const MoreGlyph = () => html`<span class="glyph"><${Icon} name="more" size=${17} /></span>`;

function Install({ onSkip }) {
  const url = location.href.split("#")[0].replace(/[?&]browser\b/, "");
  let steps, arrow = null;
  if (!IS_IOS) {
    return html`<div class="install">
      <div class="install-hero"><img class="app-icon" src="icons/apple-touch-icon.png" alt="" /><h1>SAKET</h1>
        <p>Five stores. One list. Always the cheapest.</p></div>
      <div class="install-card">
        <h2>Made for iPhone</h2>
        <p class="muted">Scan with your iPhone camera, then add SAKET to your Home Screen.</p>
        <${QR} text=${url} />
        <div class="url">${url.replace(/^https?:\/\//, "")}</div>
        <button class="ghost wide" onClick=${onSkip}>Continue in this browser</button>
      </div></div>`;
  }
  if (IN_APP) {
    steps = [[html`Tap ${MoreGlyph()} or the menu in this app`, "Look for the menu at the top or bottom of the screen."],
      [html`Choose <b>Open in Safari</b>`, "The install option only shows up in Safari."],
      [html`Follow the steps there`, "It takes about ten seconds."]];
  } else if (BROWSER !== "Safari") {
    steps = [[html`Tap ${ShareGlyph()} <b>Share</b>`, `It's in ${BROWSER}'s address bar, at the top right.`],
      [html`Tap ${AddGlyph()} <b>Add to Home Screen</b>`, "Scroll down the list if you don't see it."],
      [html`Tap <b>Add</b>`, "Then open SAKET from your Home Screen."]];
    arrow = "top";
  } else {
    steps = [[html`Tap ${ShareGlyph()} <b>Share</b>`, IS_IPAD ? "It's at the top right, next to the address bar."
        : html`It's in Safari's toolbar. Don't see it? Tap ${MoreGlyph()} first.`],
      [html`Tap ${AddGlyph()} <b>Add to Home Screen</b>`, "Scroll down — or tap View More if it's hidden."],
      [html`Keep <b>Open as Web App</b> on and tap <b>Add</b>`, "Then open SAKET from your Home Screen."]];
    arrow = IS_IPAD ? "top" : "bottom";
  }
  return html`<div class="install">
    <div class="install-hero">
      <img class="app-icon" src="icons/apple-touch-icon.png" alt="" />
      <h1>SAKET</h1>
      <p>Five stores. One list. Always the cheapest.</p>
      <div class="store-dots">${SITE_IDS.map(id => html`<span key=${id} style=${{ "--c": SITES[id].color }}>${SITES[id].name}</span>`)}</div>
    </div>
    <div class="install-card">
      <h2>Install the app</h2>
      <p class="muted">SAKET lives on your Home Screen like any other app — full screen, no App Store needed.</p>
      <ol class="steps">${steps.map(([t, d], i) => html`<li key=${i}><span class="num">${i + 1}</span><div><div class="step-t">${t}</div><div class="step-d">${d}</div></div></li>`)}</ol>
      <button class="link-btn" onClick=${onSkip}>Use it in the browser instead</button>
    </div>
    ${arrow && html`<div class=${"pointer " + arrow}><${Icon} name="back" size=${30} stroke=${3} /></div>`}
  </div>`;
}

// ---------------------------------------------------------------- root

function App() {
  const [, force] = useState(0);
  const [skip, setSkip] = useState(() => STANDALONE || /[?&]browser\b/.test(location.search) || sessionStorage.getItem("saket.browser") === "1");
  useEffect(() => { const l = () => force(x => x + 1); listeners.add(l); return () => listeners.delete(l); }, []);
  useEffect(() => {
    // Sheng Siong's socket is dropped while the app is in the background; prices that failed are retried on return.
    const vis = () => { if (document.visibilityState === "visible") check(S.lists.flatMap(toBuy)); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);
  if (!skip) return html`<${Install} onSkip=${() => { sessionStorage.setItem("saket.browser", "1"); setSkip(true); }} />`;

  const top = S.stack[S.stack.length - 1];
  const screen = top.screen === "list" ? html`<${ListScreen} key=${"l" + top.id} id=${top.id} focus=${top.focus} />`
    : top.screen === "buy" ? html`<${BuyScreen} key="buy" />`
    : top.screen === "stores" ? html`<${StoresScreen} key="stores" />`
    : html`<${Home} key="home" />`;
  const sh = S.sheet;
  return html`<div class=${"app" + (STANDALONE ? " standalone" : "")}>
    ${screen}
    ${sh?.kind === "settings" && html`<${SettingsSheet} />`}
    ${sh?.kind === "listMenu" && html`<${ListMenu} id=${sh.id} />`}
    ${sh?.kind === "confirmDelete" && html`<${ConfirmDelete} id=${sh.id} />`}
    ${S.toast && html`<div class="toast">${S.toast}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById("root"));

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
