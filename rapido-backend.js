// ═══════════════════════════════════════════════════════════════
// RAPIDO DELIVERY — API Client (replaces localStorage backend)
// Falls back to localStorage demo mode if server is unreachable.
// ═══════════════════════════════════════════════════════════════

const RAPIDO_API = window.RAPIDO_API_URL || 'http://localhost:3000';
const TOKEN_KEY  = 'rapido_token';
const RAPIDO_KEY = 'rapido_db';
const SOCKET_AVAILABLE = typeof io !== 'undefined';

const RapidoAuth = {
  getToken()  { return localStorage.getItem(TOKEN_KEY); },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken(){ localStorage.removeItem(TOKEN_KEY); },
  headers()   {
    const t = this.getToken();
    return { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) };
  },
};

let _serverMode = null;
async function detectServerMode() {
  try {
    const r = await fetch(RAPIDO_API + '/api/stats', { signal: AbortSignal.timeout(2000) });
    _serverMode = r.ok;
  } catch { _serverMode = false; }
  return _serverMode;
}

async function apiCall(method, path, body) {
  const opts = { method, headers: RapidoAuth.headers(), signal: AbortSignal.timeout(5000) };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(RAPIDO_API + path, opts);
  if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error || r.statusText); }
  return r.json();
}

// Socket.io
let _socket = null;
const _listeners = [];
function getRapidoSocket() {
  if (_socket) return _socket;
  if (!SOCKET_AVAILABLE) return null;
  _socket = io(RAPIDO_API);
  const events = ['order:new','order:updated','driver:updated','driver:position','restaurant:added','restaurant:updated','restaurant:deleted'];
  events.forEach(ev => _socket.on(ev, d => _listeners.forEach(fn => fn(ev, d))));
  return _socket;
}

// Fallback localStorage DB
const DEFAULT_DB = {
  orders: [
    { id:'RP-2040', customer:'Sana K.', phone:'+216 28 555 666', restaurant:'Brik & Lablabi', restaurantId:4, items:[{name:"Brik à l'oeuf",price:4,qty:1},{name:'Lablabi',price:5,qty:1}], total:9.0, deliveryFee:1.5, address:'Cité Bouzid, Gabès', driverId:null, status:'pending', createdAt:Date.now()-600000, assignedAt:null, deliveredAt:null, rating:null },
    { id:'RP-2041', customer:'Yassine T.', phone:'+216 23 777 888', restaurant:'Burger District', restaurantId:3, items:[{name:'Classic Burger',price:13,qty:1},{name:'Frites',price:5,qty:1}], total:18.0, deliveryFee:2.5, address:'Rue du 7 Novembre, Gabès', driverId:1, status:'on_the_way', createdAt:Date.now()-900000, assignedAt:Date.now()-800000, deliveredAt:null, rating:null },
  ],
  drivers: [
    { id:1, name:'Ahmed Ben Ali',  phone:'+216 22 100 200', vehicle:'Scooter', zone:'Centre', pin:'1234', status:'online',  lat:33.8828, lng:10.0982, rating:4.9, deliveriesToday:8, earningsToday:47.5, totalDeliveries:342 },
    { id:2, name:'Khalil Haj',     phone:'+216 25 300 400', vehicle:'Moto',    zone:'Sud',    pin:'2345', status:'online',  lat:33.8781, lng:10.1024, rating:4.7, deliveriesToday:6, earningsToday:35.0, totalDeliveries:201 },
    { id:3, name:'Rim Dridi',      phone:'+216 28 500 600', vehicle:'Scooter', zone:'Nord',   pin:'3456', status:'busy',    lat:33.8852, lng:10.0952, rating:4.8, deliveriesToday:5, earningsToday:29.0, totalDeliveries:178 },
    { id:4, name:'Mohamed Salah',  phone:'+216 23 700 800', vehicle:'Vélo',    zone:'Centre', pin:'4567', status:'offline', lat:33.8801, lng:10.1001, rating:4.5, deliveriesToday:0, earningsToday:0,    totalDeliveries:89  },
  ],
  restaurants: [
    { id:1, name:'Pizza Roma',     emoji:'🍕', category:'Pizza',      address:'Av. Habib Bourguiba',  lat:33.8847, lng:10.0966, prepTime:18, rating:4.8, deliveryFee:2.5, status:'open', hoursOpen:'10:00', hoursClose:'23:00', menu:[{name:'Margherita',price:12,desc:'Tomate, mozzarella, basilic'},{name:'Quatre Fromages',price:15,desc:'Mix de 4 fromages fondus'},{name:'Soft Drink',price:2.5,desc:'Coca, Pepsi, Fanta'}] },
    { id:2, name:'Shawarma House', emoji:'🥙', category:'Sandwiches', address:'Rue de Tunis',         lat:33.8812, lng:10.1015, prepTime:12, rating:4.6, deliveryFee:2.0, status:'open', hoursOpen:'09:00', hoursClose:'22:00', menu:[{name:'Shawarma Poulet',price:9,desc:'Poulet grillé, légumes, sauce'},{name:'Shawarma Viande',price:11,desc:'Viande marinée, tomate, salade'},{name:'Jus Frais',price:3,desc:'Orange, citron ou ananas'}] },
    { id:3, name:'Burger District',emoji:'🍔', category:'Burgers',    address:'Cité Bouzid',          lat:33.8795, lng:10.0948, prepTime:22, rating:4.5, deliveryFee:2.5, status:'open', hoursOpen:'11:00', hoursClose:'23:30', menu:[{name:'Classic Burger',price:13,desc:'Steak haché, cheddar, salade'},{name:'Double Smash',price:17,desc:'Double steak, sauce spéciale'},{name:'Frites',price:5,desc:'Frites maison croustillantes'}] },
    { id:4, name:'Brik & Lablabi', emoji:'🧆', category:'Local',      address:'Medina de Gabès',      lat:33.8831, lng:10.1038, prepTime:10, rating:4.9, deliveryFee:1.5, status:'open', hoursOpen:'07:00', hoursClose:'21:00', menu:[{name:"Brik à l'oeuf",price:4,desc:"Feuille de brik croustillante, oeuf"},{name:'Lablabi',price:5,desc:'Soupe de pois chiches traditionnelle'}] },
    { id:5, name:'Green Bowl',     emoji:'🥗', category:'Healthy',    address:"Rue de la République", lat:33.8820, lng:10.0975, prepTime:15, rating:4.3, deliveryFee:2.0, status:'open', hoursOpen:'09:00', hoursClose:'21:00', menu:[{name:'Bowl Quinoa',price:14,desc:'Quinoa, légumes rôtis, tahini'},{name:'Salade César',price:11,desc:'Romaine, poulet grillé, parmesan'}] },
    { id:6, name:'Café Jasmin',    emoji:'☕', category:'Drinks',     address:"Av. de la Liberté",    lat:33.8805, lng:10.0991, prepTime:8,  rating:4.7, deliveryFee:1.5, status:'busy', hoursOpen:'07:00', hoursClose:'22:00', menu:[{name:'Café Latte',price:4,desc:'Espresso, lait mousseux'},{name:'Cappuccino',price:4.5,desc:'Espresso, mousse de lait'}] },
  ],
  settings: { deliveryFee:2.5, maxRadius:10, acceptOrders:true, autoAssign:true, platformCommission:15, adminPin:'0000' },
  nextOrderId: 2042,
};

const _ls = {
  load() { try { const r = localStorage.getItem(RAPIDO_KEY); if(r) return JSON.parse(r); } catch{} this.save(DEFAULT_DB); return DEFAULT_DB; },
  save(db) { localStorage.setItem(RAPIDO_KEY, JSON.stringify(db)); },
};

const RapidoDB = {
  // AUTH
  async loginDriver(driverId, pin) {
    try {
      const res = await apiCall('POST', '/api/auth/driver', { driverId, pin });
      RapidoAuth.setToken(res.token); _serverMode = true;
      return { ok: true, driver: res.driver };
    } catch(e) {
      const d = _ls.load().drivers.find(d => d.id === driverId);
      if (!d) return { ok: false, error: 'Livreur introuvable' };
      if (d.pin !== String(pin)) return { ok: false, error: 'PIN incorrect' };
      _serverMode = false;
      return { ok: true, driver: { ...d, pin: undefined } };
    }
  },
  async loginAdmin(pin) {
    try {
      const res = await apiCall('POST', '/api/auth/admin', { pin });
      RapidoAuth.setToken(res.token); _serverMode = true;
      return { ok: true };
    } catch(e) {
      const s = _ls.load().settings;
      if (String(pin) !== String(s.adminPin)) return { ok: false, error: 'PIN incorrect' };
      _serverMode = false; return { ok: true };
    }
  },
  logout() { RapidoAuth.clearToken(); _serverMode = null; },

  // RESTAURANTS
  async getRestaurants()    { try { return await apiCall('GET','/api/restaurants'); } catch { return _ls.load().restaurants; } },
  async getRestaurant(id)   { try { return await apiCall('GET','/api/restaurants/'+id); } catch { return _ls.load().restaurants.find(r=>r.id===id); } },
  async addRestaurant(d)    { try { return await apiCall('POST','/api/restaurants',d); } catch { const db=_ls.load(); const r={id:Math.max(...db.restaurants.map(r=>r.id),0)+1,rating:4.5,...d}; db.restaurants.push(r); _ls.save(db); return r; } },
  async updateRestaurant(id,d){ try { return await apiCall('PUT','/api/restaurants/'+id,d); } catch { const db=_ls.load(); const i=db.restaurants.findIndex(r=>r.id===id); if(i>=0){db.restaurants[i]={...db.restaurants[i],...d};_ls.save(db);} return db.restaurants[i]; } },
  async deleteRestaurant(id){ try { return await apiCall('DELETE','/api/restaurants/'+id); } catch { const db=_ls.load(); db.restaurants=db.restaurants.filter(r=>r.id!==id); _ls.save(db); return {ok:true}; } },

  // ORDERS
  async getOrders(f={})  { try { return await apiCall('GET','/api/orders'+(Object.keys(f).length?'?'+new URLSearchParams(f):'')); } catch { return _ls.load().orders; } },
  async getOrder(id)     { try { return await apiCall('GET','/api/orders/'+id); } catch { return _ls.load().orders.find(o=>o.id===id); } },
  async addOrder(d)      { try { return await apiCall('POST','/api/orders',d); } catch { const db=_ls.load(); const id='RP-'+db.nextOrderId++; const o={id,...d,driverId:null,status:'pending',createdAt:Date.now(),assignedAt:null,deliveredAt:null,rating:null}; db.orders.unshift(o); _ls.save(db); return o; } },
  async updateOrder(id,u){ try { return await apiCall('PATCH','/api/orders/'+id,u); } catch { const db=_ls.load(); const i=db.orders.findIndex(o=>o.id===id); if(i>=0){db.orders[i]={...db.orders[i],...u};_ls.save(db);} return db.orders[i]; } },

  // DRIVERS
  async getDrivers()       { try { return await apiCall('GET','/api/drivers'); } catch { return _ls.load().drivers.map(d=>({...d,pin:undefined})); } },
  async getDriver(id)      { try { return await apiCall('GET','/api/drivers/me'); } catch { const d=_ls.load().drivers.find(d=>d.id===id); return d?{...d,pin:undefined}:null; } },
  async updateDriver(id,u) { try { return await apiCall('PATCH','/api/drivers/'+id,u); } catch { const db=_ls.load(); const i=db.drivers.findIndex(d=>d.id===id); if(i>=0){db.drivers[i]={...db.drivers[i],...u};_ls.save(db);} } },

  // SETTINGS
  async getSettings()    { try { return await apiCall('GET','/api/settings'); } catch { return _ls.load().settings; } },
  async updateSettings(u){ try { return await apiCall('PATCH','/api/settings',u); } catch { const db=_ls.load(); db.settings={...db.settings,...u}; _ls.save(db); } },

  // STATS
  async getStats() {
    try { return await apiCall('GET','/api/stats'); }
    catch {
      const db=_ls.load(); const today=db.orders.filter(o=>Date.now()-o.createdAt<86400000);
      return { ordersToday:today.length, revenueToday:today.reduce((s,o)=>s+(o.total||0)+(o.deliveryFee||0),0), activeDrivers:db.drivers.filter(d=>d.status!=='offline').length, pendingOrders:db.orders.filter(o=>o.status==='pending').length, avgDeliveryTime:23 };
    }
  },

  isOnline() { return _serverMode === true; },
};

function onRapidoUpdate(callback) {
  if (SOCKET_AVAILABLE) {
    const socket = getRapidoSocket();
    if (socket) { _listeners.push(callback); return; }
  }
  let last = JSON.stringify(_ls.load());
  setInterval(() => { const c=JSON.stringify(_ls.load()); if(c!==last){last=c;callback('change',{});} }, 3000);
}

function broadcastDriverPosition(driverId, lat, lng) {
  const socket = _socket || (SOCKET_AVAILABLE ? getRapidoSocket() : null);
  if (socket) socket.emit('driver:position', { driverId, lat, lng, token: RapidoAuth.getToken() });
}

function showServerModeBanner(isOnline) {
  const old = document.getElementById('rapido-mode-banner');
  if (old) old.remove();
  const b = document.createElement('div');
  b.id = 'rapido-mode-banner';
  b.style.cssText = 'position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:9999;padding:4px 16px;font-size:11px;font-weight:700;border-radius:12px 12px 0 0;pointer-events:none;' + (isOnline ? 'background:rgba(0,201,177,.15);color:#00C9B1;' : 'background:rgba(212,131,26,.15);color:#D4831A;');
  b.textContent = isOnline ? '🟢 Serveur connecté' : '🟡 Mode démo — lancez: node server.js';
  document.body.appendChild(b);
  if (isOnline) setTimeout(() => b.remove(), 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', async () => {
    const online = await detectServerMode();
    showServerModeBanner(online);
    if (online && SOCKET_AVAILABLE) getRapidoSocket();
  });
} else {
  detectServerMode().then(online => {
    showServerModeBanner(online);
    if (online && SOCKET_AVAILABLE) getRapidoSocket();
  });
}
function calcDeliveryFee(restLat, restLng, clientLat, clientLng) {
  // Haversine formula — gives real distance in km
  const R = 6371;
  const dLat = (clientLat - restLat) * Math.PI / 180;
  const dLng = (clientLng - restLng) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(restLat * Math.PI/180) *
            Math.cos(clientLat * Math.PI/180) *
            Math.sin(dLng/2) ** 2;
  const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  const fee = 1.0 + (distanceKm * 1.0);
  return Math.min(Math.max(fee, 1.0), 10.0); // between 1 and 10 DT
}
navigator.geolocation.getCurrentPosition(pos => {
  const fee = calcDeliveryFee(
    rest.lat, rest.lng,
    pos.coords.latitude,
    pos.coords.longitude
  );
  // show fee in the restaurant card
});