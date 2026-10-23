// The shops and how each one is searched. Almost everything runs in the phone's browser:
// FairPrice, Selvi, KiasuMart and Cold Storage's API allow cross-site requests, Waangoo is searched through
// Shopify's public Storefront API, and Sheng Siong through the same Meteor websocket its own site uses.
// RedMart (Lazada) allows no cross-site requests, so it goes through a tiny relay (relay/worker.js) and is
// only offered once RELAY is set.
export const RELAY = "https://gotlobang-relay.gotlobang.workers.dev";

export const SITES = {
  shengSiong: { name: "Sheng Siong", color: "#e5484d", cart: "https://shengsiong.com.sg/cart",
    search: q => `https://shengsiong.com.sg/search/${encodeURIComponent(q)}` },
  fairPrice: { name: "FairPrice", color: "#3e63dd", cart: "https://www.fairprice.com.sg/cart",
    search: q => `https://www.fairprice.com.sg/search?query=${encodeURIComponent(q)}` },
  coldStorage: { name: "Cold Storage", color: "#008c45", cart: "https://coldstorage.com.sg/cart",
    search: q => `https://coldstorage.com.sg/search?q=${encodeURIComponent(q)}` },
  redMart: { name: "RedMart", color: "#db1266", cart: "https://cart.lazada.sg/cart",
    search: q => `https://redmart.lazada.sg/catalog/?q=${encodeURIComponent(q)}&m=redmart` },
  waangoo: { name: "Waangoo", color: "#f76b15", cart: "https://www.waangoo.com/cart",
    search: q => `https://www.waangoo.com/search?q=${encodeURIComponent(q)}&type=product` },
  selvi: { name: "Selvi", color: "#8e4ec6", cart: "https://selvionline.com/cart/",
    search: q => `https://selvionline.com/?s=${encodeURIComponent(q)}&post_type=product` },
  kiasumart: { name: "KiasuMart", color: "#12a594", cart: "https://kiasumart.com/cart/",
    search: q => `https://kiasumart.com/?s=${encodeURIComponent(q)}&post_type=product` },
};
export const SITE_IDS = Object.keys(SITES).filter(id => id !== "redMart" || RELAY);

async function json(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`The site answered with HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw e.name === "AbortError" ? new Error("The site took too long to answer") : e;
  } finally {
    clearTimeout(t);
  }
}

const decode = s => {
  if (!s || !s.includes("&")) return s;
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
};

async function fairPrice(q) {
  const e = encodeURIComponent(q);
  const d = await json(`https://website-api.omni.fairprice.com.sg/api/product/v2?pageType=search&storeId=165&q=${e}&url=${e}`);
  return (d?.data?.product ?? []).filter(p => p.has_stock !== false && Number(p.final_price) > 0).map(p => ({
    id: String(p.id ?? p.slug), site: "fairPrice", name: p.name, size: p.metaData?.DisplayUnit ?? null,
    price: Number(p.final_price), url: `https://www.fairprice.com.sg/product/${p.slug}`, image: p.images?.[0] ?? null,
  }));
}

// Cold Storage's own catalogue API (the same search its site runs server-side).
async function coldStorage(q) {
  const d = await json("https://csp.coldstorage.com.sg/api/catalog/product/typesensesearch", {
    method: "POST", body: new URLSearchParams({ keywords: q, page: "1", limit: "24" }),
  });
  return (d?.products ?? []).flatMap(p => {
    const promo = Number(p.promo_price), regular = Number(p.price);
    const price = promo > 0 ? promo : regular;
    if (p.inventory_status !== "In Stock" || !(price > 0)) return [];
    return [{ id: String(p.product_id), site: "coldStorage", name: decode(p.name), size: p.size || null, price,
      url: `https://coldstorage.com.sg/product/${p.slug}`, image: p.image ?? null }];
  });
}

// RedMart = Lazada's catalogue search filtered to RedMart, fetched through the relay.
async function redMart(q) {
  if (!RELAY) throw new Error("RedMart needs the relay");
  const d = await json(`${RELAY}/redmart?q=${encodeURIComponent(q)}`);
  return (d?.mods?.listItems ?? []).flatMap(p => {
    const price = Number(p.price);
    if (!p.inStock || p.sellerName !== "RedMart" || !(price > 0)) return [];
    let url = String(p.productUrl ?? p.itemUrl ?? "");
    if (url.startsWith("//")) url = "https:" + url;
    url = url.split("?")[0];
    return [{ id: String(p.itemId), site: "redMart", name: decode(p.name), size: p.packageInfo || null, price, url, image: p.image ?? null }];
  });
}

async function woo(site, api, base, q) {
  const d = await json(`${api}?per_page=20&search=${encodeURIComponent(q)}`);
  return (Array.isArray(d) ? d : []).flatMap(p => {
    if (p.is_in_stock === false || p.is_purchasable === false) return [];
    const price = Number(p.prices?.price) / 10 ** Number(p.prices?.currency_minor_unit ?? 2);
    if (!(price > 0)) return [];
    const simple = (p.type ?? "simple") === "simple";
    return [{
      id: String(p.id), site, name: decode(p.name), size: null, price, url: p.permalink,
      image: p.images?.[0]?.thumbnail ?? null,
      // Simple products can be dropped straight into the cart with a link.
      cartUrl: simple ? `${base}/?add-to-cart=${p.id}&quantity=` : null,
    }];
  });
}

async function waangoo(q) {
  const query = `query($q: String!) { search(first: 15, query: $q, types: PRODUCT, productFilters: [{available: true}]) {
    nodes { ... on Product { title handle featuredImage { url(transform: {maxWidth: 300}) }
      variants(first: 8) { nodes { id title availableForSale price { amount } } } } } } }`;
  const d = await json("https://waangoo.com/api/2025-07/graphql.json", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { q } }),
  });
  if (d.errors?.length) throw new Error(d.errors[0].message);
  return (d.data?.search?.nodes ?? []).flatMap(p => p.variants.nodes
    .filter(v => v.availableForSale && Number(v.price.amount) > 0)
    .map(v => {
      const vid = v.id.split("/").pop();
      return {
        id: vid, site: "waangoo", name: v.title === "Default Title" ? p.title : `${p.title} – ${v.title}`, size: null,
        price: Number(v.price.amount), url: `https://www.waangoo.com/products/${p.handle}?variant=${vid}`,
        image: p.featuredImage?.url ?? null, variant: vid,
      };
    }));
}

// Sheng Siong: one shared DDP (Meteor) websocket, reopened whenever iOS drops it.
const ddp = { ready: null, pending: new Map(), n: 0 };

function ddpConnect() {
  if (ddp.ready) return ddp.ready;
  ddp.ready = new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://shengsiong.com.sg/websocket");
    const fail = msg => {
      ddp.ready = null;
      reject(new Error(msg));
      for (const p of ddp.pending.values()) p.reject(new Error(msg));
      ddp.pending.clear();
    };
    const timer = setTimeout(() => { fail("Sheng Siong didn't answer"); ws.close(); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.msg === "connected") { clearTimeout(timer); resolve(ws); }
      else if (d.msg === "ping") ws.send(JSON.stringify({ msg: "pong", id: d.id }));
      else if (d.msg === "result") {
        const p = ddp.pending.get(d.id);
        if (!p) return;
        ddp.pending.delete(d.id);
        d.error ? p.reject(new Error(d.error.reason || d.error.message || "Sheng Siong error")) : p.resolve(d.result);
      }
    };
    ws.onclose = () => { clearTimeout(timer); fail("Lost connection to Sheng Siong"); };
  });
  return ddp.ready;
}

async function ddpCall(method, params) {
  const ws = await ddpConnect();
  const id = String(++ddp.n);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ddp.pending.delete(id); reject(new Error("Sheng Siong took too long")); }, 20000);
    ddp.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify({ msg: "method", id, method, params }));
  });
}

async function shengSiong(q) {
  const e = { slug: "" };
  const params = [
    { categoryFilter: { slugs: [] }, campaignPageFilter: e,
      shoppingListFilter: { slug: "", category: { slug: "" }, search: { slug: "" }, showKeptForLater: false },
      searchFilter: { slug: q, category: { slug: "" } }, preOrderCampaignFilter: e,
      ecommPromotionFilter: { active: false, category: { slug: "" } } },
    { brands: { slugs: [] }, prices: { slugs: [] }, countryOfOrigins: { slugs: [] }, dietaryHabits: { slugs: [] },
      tags: { slugs: [] }, promotionTypes: { slugs: [] }, sortBy: { slug: "" } },
    1, 20,
  ];
  let r;
  try { r = await ddpCall("Products.getByAllSlugs", params); }
  catch { r = await ddpCall("Products.getByAllSlugs", params); }  // the socket may have gone stale; retry once
  return (r ?? []).filter(p => !p.isSoldOut && p.price > 0).map(p => ({
    id: p._id?.$value ?? p.slug, site: "shengSiong", name: `${p.brand ?? ""} ${p.name}`.trim(), size: p.packSize ?? null,
    price: p.price, url: `https://shengsiong.com.sg/product/${p.slug}`,
    image: p.imgKey ? `https://ssecomm.s3.ap-southeast-1.amazonaws.com/products/sm/${p.imgKey}.0.jpg` : null,
  }));
}

export function searchSite(site, q) {
  switch (site) {
    case "fairPrice": return fairPrice(q);
    case "coldStorage": return coldStorage(q);
    case "redMart": return redMart(q);
    case "waangoo": return waangoo(q);
    case "selvi": return woo("selvi", "https://selvionline.com/wp-json/wc/store/products", "https://selvionline.com", q);
    case "kiasumart": return woo("kiasumart", "https://kiasumart.com/wp-json/wc/store/v1/products", "https://kiasumart.com", q);
    case "shengSiong": return shengSiong(q);
  }
}

/// Link that drops this product into the store's cart, where the store supports one.
export function cartLink(offer, qty) {
  if (offer.cartUrl) return offer.cartUrl + qty;
  if (offer.variant) return `https://www.waangoo.com/cart/${offer.variant}:${qty}`;
  return null;
}

/// One link that fills the whole Waangoo cart.
export function waangooCartLink(lines) {
  return `https://www.waangoo.com/cart/${lines.map(l => `${l.offer.variant}:${l.quantity}`).join(",")}`;
}

// ---- Matching (same rules as the Mac app) ----

const SAME_WORD = { dhal: "dal", dhall: "dal", daal: "dal", chilli: "chili", chillies: "chili", chilies: "chili",
  yoghurt: "yogurt", curd: "yogurt" };

export const words = s => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => SAME_WORD[w] ?? w);

export function singular(w) {
  if (w.length <= 3 || !w.endsWith("s") || ["ss", "us", "is"].some(x => w.endsWith(x))) return w;
  return w.slice(0, w.endsWith("oes") ? -2 : -1);
}

/// Store searches find far more for "onion" than "onions".
export const searchText = s => s.split(" ").map(singular).join(" ");

const SIZE = /(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|kgs|gm|gms|g|grams?|ltr|lt|l|litres?|liters?|ml|pcs|pc|pieces?|s|'s)(?![a-z/])/;  // "304S/S" is steel, not 304 pieces

/// Pack size from a title like "1.5kg", "946ml", "2 x 1L" or "10s".
export function measure(o) {
  const m = SIZE.exec(title(o).toLowerCase());
  if (!m) return null;
  let amount = Number(m[2]);
  if (!(amount > 0)) return null;
  if (m[1]) amount *= Number(m[1]);
  const u = m[3];
  if (["kg", "kgs"].includes(u)) return { amount: amount * 1000, unit: "g" };
  if (["g", "gm", "gms", "gram", "grams"].includes(u)) return { amount, unit: "g" };
  if (["l", "lt", "ltr", "litre", "litres", "liter", "liters"].includes(u)) return { amount: amount * 1000, unit: "ml" };
  if (u === "ml") return { amount, unit: "ml" };
  return { amount, unit: "pc" };
}

export function title(o) {
  return o.size && !o.name.toLowerCase().includes(o.size.toLowerCase()) ? `${o.name} · ${o.size}` : o.name;
}

/// Price per 100g / 100ml / piece.
export function unitPrice(o) {
  const m = measure(o);
  return m ? { value: o.price / (m.unit === "pc" ? m.amount : m.amount / 100), unit: m.unit,
    label: m.unit === "pc" ? "pc" : `100${m.unit}` } : null;
}

const DERIVED = ["powder", "lotion", "cake", "crumb", "flour", "tart", "biscuit", "cookie", "chocolate",
  "candy", "soap", "shampoo", "wash", "cream", "mix", "flavour", "flavor", "spread", "chips", "cracker", "snack",
  "sauce", "paste", "jam", "pudding", "ice", "yoghurt", "yogurt", "drink", "soy", "oat", "almond", "banana milk",
  "kheer", "rose", "lassi", "butter", "condensed", "evaporated", "coconut", "loaf", "walnut", "bandung", "tea",
  "coffee", "masala", "ghee", "melon", "cultured", "strawberry", "smoothie", "protein", "pooja", "whisk", "beater",
  "sponge", "slicer", "separator", "plant"];

/// Results where every word of the item starts a word in the product name, among the site's top hits.
export function matches(key, offers) {
  const query = words(key).map(singular).filter(w => w.length >= 2);
  return offers.slice(0, 12).filter(o => {
    const text = `${o.name} ${o.size ?? ""}`.toLowerCase();
    const name = words(text);
    const squashed = text.replaceAll(" ", "");
    // Short words must match whole ("egg" isn't "eggplant", "milk" isn't "milky"); longer ones may start a word.
    const fits = (w, q) => q.length <= 4 ? w === q || w === q + "s" || w === q + "es" : w.startsWith(q);
    const hit = query.every(q => name.some(w => fits(w, q)) || (/\d/.test(q) && squashed.includes(q)));
    // "milk" shouldn't match body lotion or milk powder unless you asked for it.
    const derived = DERIVED.some(d => !query.some(q => q.startsWith(d)) &&
      (d.includes(" ") ? text.includes(d) : name.some(w => w.startsWith(d))));
    return hit && !derived;
  });
}

/// By sticker price, or by unit price within the most common unit (those first), then the rest.
export function sortOffers(offers, byUnit) {
  const byPrice = [...offers].sort((a, b) => a.price - b.price);
  if (!byUnit) return byPrice;
  const counts = {};
  for (const o of offers) { const m = measure(o); if (m) counts[m.unit] = (counts[m.unit] ?? 0) + 1; }
  const unit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!unit) return byPrice;
  const same = byPrice.filter(o => measure(o)?.unit === unit).sort((a, b) => unitPrice(a).value - unitPrice(b).value);
  return [...same, ...byPrice.filter(o => measure(o)?.unit !== unit)];
}

/// Best value first; packs costing over 3× the typical price go last so unit pricing doesn't push a 25kg sack.
export function rank(offers, byUnit) {
  const all = sortOffers(offers, byUnit);
  if (!all.length) return [];
  const median = all.map(o => o.price).sort((a, b) => a - b)[Math.floor(all.length / 2)];
  return [...all.filter(o => o.price <= median * 3), ...all.filter(o => o.price > median * 3)];
}
