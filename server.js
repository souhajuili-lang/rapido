// ═══════════════════════════════════════════════════════════════
// RAPIDO DELIVERY — Production Server (PostgreSQL + Web Push)
// ═══════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const { Pool }   = require('pg');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const webpush    = require('web-push');

// ── APP INIT ──────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 5, message: { error: 'Trop de tentatives.' } });
app.use('/api/auth', authLimiter);

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'rapido_secret_2024';

// ── VAPID / WEB PUSH ──────────────────────────────────────────
// Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY + VAPID_EMAIL as Railway env vars
// to use your own keys in production.
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BMzvAY7G1n-OZJ3MxdVsXYrKAZK61i20WY0Cac65Ha0uvy6KiDCBoXYXaDvvb5JJPEqf4DFAzAD4k1FP4kr3Ucg';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'bkSVHLUieiI_4F6rZPuk-Z1xhD_GP70lZuV0F1CBPQY';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@rapido.tn';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// In-memory subscription store: key → PushSubscription
// key format: "admin:<timestamp>" or "driver:<id>"
const pushSubs = new Map();

async function sendPush(key, payload) {
  const sub = pushSubs.get(key);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) pushSubs.delete(key);
    else console.warn('[push] error:', err.message);
  }
}

async function pushToAllAdmins(payload) {
  for (const [key] of pushSubs) {
    if (key.startsWith('admin')) await sendPush(key, payload);
  }
}

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }
    : { host: process.env.PGHOST||'localhost', port: parseInt(process.env.PGPORT||'5432'), user: process.env.PGUSER||'postgres', password: process.env.PGPASSWORD||'', database: process.env.PGDATABASE||'rapido' }
);

pool.connect()
  .then(c => { console.log('✅  PostgreSQL connected'); c.release(); })
  .catch(err => { console.error('❌  PostgreSQL failed:', err.message); process.exit(1); });

const query    = (t, p) => pool.query(t, p);
const queryOne = async (t, p) => { const { rows } = await pool.query(t, p); return rows[0] || null; };

function rowToRestaurant(r) {
  if (!r) return null;
  return { id:r.id, name:r.name, emoji:r.emoji, category:r.category, address:r.address, lat:parseFloat(r.lat), lng:parseFloat(r.lng), prepTime:r.prep_time, rating:parseFloat(r.rating), deliveryFee:parseFloat(r.delivery_fee), status:r.status, hoursOpen:r.hours_open, hoursClose:r.hours_close, menu:r.menu };
}
function rowToDriver(r) {
  if (!r) return null;
  return { id:r.id, name:r.name, phone:r.phone, vehicle:r.vehicle, zone:r.zone, status:r.status, lat:r.lat?parseFloat(r.lat):null, lng:r.lng?parseFloat(r.lng):null, rating:parseFloat(r.rating), deliveriesToday:r.deliveries_today, earningsToday:parseFloat(r.earnings_today), totalDeliveries:r.total_deliveries };
}
function rowToOrder(r) {
  if (!r) return null;
  return { id:r.id, customer:r.customer, phone:r.phone, restaurantId:r.restaurant_id, restaurant:r.restaurant, items:r.items, total:parseFloat(r.total), deliveryFee:parseFloat(r.delivery_fee), address:r.address, driverId:r.driver_id, status:r.status, rating:r.rating, createdAt:r.created_at?new Date(r.created_at).getTime():null, assignedAt:r.assigned_at?new Date(r.assigned_at).getTime():null, deliveredAt:r.delivered_at?new Date(r.delivered_at).getTime():null };
}
async function nextOrderId() { const { rows } = await pool.query("SELECT 'RP-' || nextval('order_seq') AS id"); return rows[0].id; }
function broadcast(ev, data) { io.emit(ev, data); }

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function authDriver(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Invalid token' }); }
}
function authAdmin(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'No token' });
  try { const u = jwt.verify(t, JWT_SECRET); if (u.role!=='admin') return res.status(403).json({ error:'Forbidden' }); req.user=u; next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── PUSH ROUTES ───────────────────────────────────────────────

// Client asks for VAPID public key before subscribing
app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Save a push subscription
// Body: { role: 'admin' | 'driver', driverId?: number, subscription: PushSubscription }
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { role, driverId, subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    const key = role === 'driver' && driverId ? `driver:${driverId}` : `admin:${Date.now()}`;
    pushSubs.set(key, subscription);
    console.log(`[push] + ${key}  (total: ${pushSubs.size})`);

    // Welcome notification
    await sendPush(key, {
      title: '🛵 Rapido',
      body: role === 'driver'
        ? 'Notifications activées — vos livraisons arriveront ici.'
        : 'Notifications activées — vous serez alerté à chaque commande.',
      tag:   'welcome',
      icon:  '/rapido-icon-192.png',
      badge: '/rapido-icon-192.png',
    });

    res.json({ ok: true, key });
  } catch (err) { console.error('[push] subscribe:', err); res.status(500).json({ error: 'Server error' }); }
});

// Remove a subscription
app.post('/api/push/unsubscribe', (req, res) => {
  const { key } = req.body;
  if (key) { pushSubs.delete(key); console.log(`[push] - ${key}`); }
  res.json({ ok: true });
});

// Admin: send a test notification to themselves
app.post('/api/push/test', authAdmin, async (req, res) => {
  let sent = 0;
  for (const [key] of pushSubs) {
    if (key.startsWith('admin')) {
      await sendPush(key, { title:'🔔 Test Rapido', body:'Les notifications fonctionnent !', tag:'test', icon:'/rapido-icon-admin-192.png', badge:'/rapido-icon-admin-192.png' });
      sent++;
    }
  }
  res.json({ ok: true, sent });
});

// ── AUTH ROUTES ───────────────────────────────────────────────
app.post('/api/auth/driver', async (req, res) => {
  try {
    const { driverId, pin } = req.body;
    if (!driverId || !pin) return res.status(400).json({ error: 'driverId and pin required' });
    const row = await queryOne(`SELECT *, (pin_hash = crypt($1, pin_hash)) AS pin_ok FROM drivers WHERE id = $2`, [String(pin), parseInt(driverId)]);
    if (!row)        return res.status(404).json({ error: 'Livreur introuvable' });
    if (!row.pin_ok) return res.status(401).json({ error: 'PIN incorrect' });
    const token = jwt.sign({ id:row.id, role:'driver', name:row.name }, JWT_SECRET, { expiresIn:'12h' });
    res.json({ token, driver: rowToDriver(row) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/admin', async (req, res) => {
  try {
    const { pin } = req.body;
    const row = await queryOne(`SELECT (admin_pin_hash = crypt($1, admin_pin_hash)) AS pin_ok FROM settings WHERE id = 1`, [String(pin)]);
    if (!row || !row.pin_ok) return res.status(401).json({ error: 'PIN admin incorrect' });
    const token = jwt.sign({ role:'admin' }, JWT_SECRET, { expiresIn:'8h' });
    res.json({ token });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── RESTAURANT ROUTES ─────────────────────────────────────────
app.get('/api/restaurants', async (_req, res) => {
  try { const { rows } = await query('SELECT * FROM restaurants ORDER BY id'); res.json(rows.map(rowToRestaurant)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/restaurants/:id', async (req, res) => {
  try { const row = await queryOne('SELECT * FROM restaurants WHERE id=$1', [parseInt(req.params.id)]); row ? res.json(rowToRestaurant(row)) : res.status(404).json({ error:'Not found' }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/restaurants', authAdmin, async (req, res) => {
  try {
    const { name, emoji='🍽️', category, address, lat, lng, prepTime=15, deliveryFee=2.5, status='open', hoursOpen='09:00', hoursClose='22:00', menu=[] } = req.body;
    if (!name||!category||!address) return res.status(400).json({ error:'name, category and address are required' });
    const { rows } = await pool.query(`INSERT INTO restaurants (name,emoji,category,address,lat,lng,prep_time,delivery_fee,status,hours_open,hours_close,menu) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [name,emoji,category,address,lat||null,lng||null,prepTime,deliveryFee,status,hoursOpen,hoursClose,JSON.stringify(menu)]);
    const r = rowToRestaurant(rows[0]); broadcast('restaurant:added', r); res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/restaurants/:id', authAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name,emoji,category,address,lat,lng,prepTime,deliveryFee,status,hoursOpen,hoursClose,menu } = req.body;
    const { rows } = await pool.query(`UPDATE restaurants SET name=$1,emoji=$2,category=$3,address=$4,lat=$5,lng=$6,prep_time=$7,delivery_fee=$8,status=$9,hours_open=$10,hours_close=$11,menu=$12 WHERE id=$13 RETURNING *`, [name,emoji,category,address,lat||null,lng||null,prepTime,deliveryFee,status,hoursOpen,hoursClose,JSON.stringify(menu||[]),id]);
    if (!rows[0]) return res.status(404).json({ error:'Not found' });
    const r = rowToRestaurant(rows[0]); broadcast('restaurant:updated', r); res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.delete('/api/restaurants/:id', authAdmin, async (req, res) => {
  try { const id=parseInt(req.params.id); await pool.query('DELETE FROM restaurants WHERE id=$1',[id]); broadcast('restaurant:deleted',{id}); res.json({ok:true}); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ── ORDER ROUTES ──────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const conditions=[], params=[];
    if (req.query.status)   { params.push(req.query.status);            conditions.push(`status=$${params.length}`);    }
    if (req.query.driverId) { params.push(parseInt(req.query.driverId));conditions.push(`driver_id=$${params.length}`); }
    const { rows } = await pool.query(`SELECT * FROM orders ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY created_at DESC`, params);
    res.json(rows.map(rowToOrder));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/orders/:id', async (req, res) => {
  try { const row = await queryOne('SELECT * FROM orders WHERE id=$1',[req.params.id]); row ? res.json(rowToOrder(row)) : res.status(404).json({ error:'Not found' }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { customer, phone='', restaurantId, restaurant, items=[], total=0, deliveryFee, address } = req.body;
    if (!customer||!restaurant||!address) return res.status(400).json({ error:'customer, restaurant and address are required' });
    let fee = deliveryFee;
    if (fee==null) { const rr=await queryOne('SELECT delivery_fee FROM restaurants WHERE id=$1',[restaurantId]); fee=rr?parseFloat(rr.delivery_fee):2.5; }
    const id = await nextOrderId();
    const { rows } = await pool.query(
      `INSERT INTO orders (id,customer,phone,restaurant_id,restaurant,items,total,delivery_fee,address,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW()) RETURNING *`,
      [id,customer,phone,restaurantId||null,restaurant,JSON.stringify(items),total,fee,address]
    );
    const newOrder = rowToOrder(rows[0]);
    broadcast('order:new', newOrder);

    // 🔔 Push all admins
    pushToAllAdmins({
      title: `🛵 Nouvelle commande ${newOrder.id}`,
      body:  `${newOrder.customer} · ${newOrder.restaurant} · ${newOrder.total.toFixed(1)} DT`,
      tag:   'new-order',
      url:   '/rapido-admin.html',
      icon:  '/rapido-icon-admin-192.png',
      badge: '/rapido-icon-admin-192.png',
      data:  { orderId: newOrder.id },
    }).catch(console.error);

    const settings = await queryOne('SELECT auto_assign FROM settings WHERE id=1');
    if (settings?.auto_assign) {
      const fd = await queryOne("SELECT id FROM drivers WHERE status='online' ORDER BY deliveries_today ASC LIMIT 1");
      if (fd) setTimeout(() => autoAssign(id, fd.id), 3000);
    }
    res.json(newOrder);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

async function autoAssign(orderId, driverId) {
  try {
    const { rows } = await pool.query(`UPDATE orders SET driver_id=$1,status='on_the_way',assigned_at=NOW() WHERE id=$2 AND status='pending' RETURNING *`, [driverId, orderId]);
    if (!rows[0]) return;
    await pool.query("UPDATE drivers SET status='busy' WHERE id=$1",[driverId]);
    const order = rowToOrder(rows[0]);
    broadcast('order:updated', order);
    broadcast('driver:updated', rowToDriver(await queryOne('SELECT * FROM drivers WHERE id=$1',[driverId])));

    // 🔔 Push the assigned driver
    await sendPush(`driver:${driverId}`, {
      title: '📦 Nouvelle livraison !',
      body:  `${order.restaurant} → ${order.address}`,
      tag:   'order-assigned',
      url:   '/rapido-driver.html',
      icon:  '/rapido-icon-driver-192.png',
      badge: '/rapido-icon-driver-192.png',
      data:  { orderId: order.id },
    });
  } catch (err) { console.error('autoAssign:', err); }
}

app.patch('/api/orders/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id=req.params.id, updates=req.body;
    const setClauses=[], params=[];
    const fieldMap = { status:'status', driverId:'driver_id', rating:'rating', assignedAt:'assigned_at', deliveredAt:'delivered_at' };
    for (const [jk,pc] of Object.entries(fieldMap)) {
      if (jk in updates) { params.push(jk==='assignedAt'||jk==='deliveredAt'?(updates[jk]?new Date(updates[jk]):null):updates[jk]); setClauses.push(`${pc}=$${params.length}`); }
    }
    if (updates.status==='delivered'&&!('deliveredAt' in updates)) setClauses.push('delivered_at=NOW()');
    if (!setClauses.length) return res.status(400).json({ error:'No valid fields' });
    params.push(id);
    const { rows } = await client.query(`UPDATE orders SET ${setClauses.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error:'Not found' }); }
    const updated = rowToOrder(rows[0]);
    if (updates.status==='delivered' && updated.driverId) {
      await client.query(`UPDATE drivers SET status='online',deliveries_today=deliveries_today+1,earnings_today=earnings_today+$1,total_deliveries=total_deliveries+1 WHERE id=$2`, [updated.deliveryFee*1.8, updated.driverId]);
      const dr = await client.query('SELECT * FROM drivers WHERE id=$1',[updated.driverId]);
      broadcast('driver:updated', rowToDriver(dr.rows[0]));
    }
    // 🔔 Push driver when admin manually assigns
    if (updates.driverId && updates.status==='on_the_way') {
      sendPush(`driver:${updates.driverId}`, {
        title: '📦 Nouvelle livraison !',
        body:  `${updated.restaurant} → ${updated.address}`,
        tag:   'order-assigned',
        url:   '/rapido-driver.html',
        icon:  '/rapido-icon-driver-192.png',
        badge: '/rapido-icon-driver-192.png',
        data:  { orderId: updated.id },
      }).catch(console.error);
    }
    await client.query('COMMIT');
    broadcast('order:updated', updated);
    res.json(updated);
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error:'Server error' }); }
  finally { client.release(); }
});

// ── DRIVER ROUTES ─────────────────────────────────────────────
app.get('/api/drivers', authAdmin, async (_req, res) => {
  try { const { rows }=await pool.query('SELECT * FROM drivers ORDER BY id'); res.json(rows.map(rowToDriver)); }
  catch (err) { console.error(err); res.status(500).json({ error:'Server error' }); }
});
app.get('/api/drivers/me', authDriver, async (req, res) => {
  try { const row=await queryOne('SELECT * FROM drivers WHERE id=$1',[req.user.id]); row?res.json(rowToDriver(row)):res.status(404).json({error:'Not found'}); }
  catch (err) { console.error(err); res.status(500).json({ error:'Server error' }); }
});
app.patch('/api/drivers/:id', authDriver, async (req, res) => {
  try {
    const id=parseInt(req.params.id);
    if (req.user.id!==id) return res.status(403).json({error:'Forbidden'});
    const { status,lat,lng,earningsToday,deliveriesToday,totalDeliveries }=req.body;
    const sc=[], p=[];
    if (status!==undefined)          { p.push(status);          sc.push(`status=$${p.length}`);           }
    if (lat!==undefined)             { p.push(lat);             sc.push(`lat=$${p.length}`);              }
    if (lng!==undefined)             { p.push(lng);             sc.push(`lng=$${p.length}`);              }
    if (earningsToday!==undefined)   { p.push(earningsToday);   sc.push(`earnings_today=$${p.length}`);   }
    if (deliveriesToday!==undefined) { p.push(deliveriesToday); sc.push(`deliveries_today=$${p.length}`); }
    if (totalDeliveries!==undefined) { p.push(totalDeliveries); sc.push(`total_deliveries=$${p.length}`); }
    if (!sc.length) return res.status(400).json({error:'Nothing to update'});
    p.push(id);
    const { rows }=await pool.query(`UPDATE drivers SET ${sc.join(',')} WHERE id=$${p.length} RETURNING *`,p);
    const u=rowToDriver(rows[0]); broadcast('driver:updated',u); res.json(u);
  } catch (err) { console.error(err); res.status(500).json({error:'Server error'}); }
});
app.patch('/api/admin/drivers/:id', authAdmin, async (req, res) => {
  try {
    const id=parseInt(req.params.id); const {status,lat,lng}=req.body; const sc=[],p=[];
    if (status!==undefined){p.push(status);sc.push(`status=$${p.length}`);}
    if (lat!==undefined)   {p.push(lat);   sc.push(`lat=$${p.length}`);}
    if (lng!==undefined)   {p.push(lng);   sc.push(`lng=$${p.length}`);}
    if (!sc.length) return res.status(400).json({error:'Nothing to update'});
    p.push(id);
    const { rows }=await pool.query(`UPDATE drivers SET ${sc.join(',')} WHERE id=$${p.length} RETURNING *`,p);
    const u=rowToDriver(rows[0]); broadcast('driver:updated',u); res.json(u);
  } catch (err) { console.error(err); res.status(500).json({error:'Server error'}); }
});

// ── SETTINGS ──────────────────────────────────────────────────
app.get('/api/settings', authAdmin, async (_req, res) => {
  try {
    const row=await queryOne('SELECT * FROM settings WHERE id=1');
    if (!row) return res.status(500).json({error:'Settings not found'});
    res.json({ deliveryFee:parseFloat(row.delivery_fee), maxRadius:row.max_radius, acceptOrders:row.accept_orders, autoAssign:row.auto_assign, platformCommission:row.platform_commission });
  } catch (err) { console.error(err); res.status(500).json({error:'Server error'}); }
});
app.patch('/api/settings', authAdmin, async (req, res) => {
  try {
    const { deliveryFee,maxRadius,acceptOrders,autoAssign,platformCommission,adminPin }=req.body;
    const sc=[],p=[];
    if (deliveryFee!==undefined)        {p.push(deliveryFee);        sc.push(`delivery_fee=$${p.length}`);}
    if (maxRadius!==undefined)          {p.push(maxRadius);          sc.push(`max_radius=$${p.length}`);}
    if (acceptOrders!==undefined)       {p.push(acceptOrders);       sc.push(`accept_orders=$${p.length}`);}
    if (autoAssign!==undefined)         {p.push(autoAssign);         sc.push(`auto_assign=$${p.length}`);}
    if (platformCommission!==undefined) {p.push(platformCommission); sc.push(`platform_commission=$${p.length}`);}
    if (adminPin!==undefined)           {p.push(String(adminPin));   sc.push(`admin_pin_hash=crypt($${p.length},gen_salt('bf',10))`);}
    if (!sc.length) return res.status(400).json({error:'Nothing to update'});
    await pool.query(`UPDATE settings SET ${sc.join(',')} WHERE id=1`,p);
    const u=await queryOne('SELECT * FROM settings WHERE id=1');
    res.json({ deliveryFee:parseFloat(u.delivery_fee), maxRadius:u.max_radius, acceptOrders:u.accept_orders, autoAssign:u.auto_assign, platformCommission:u.platform_commission, adminPin:adminPin?'****':undefined });
  } catch (err) { console.error(err); res.status(500).json({error:'Server error'}); }
});

// ── STATS ─────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows }=await pool.query(`SELECT COUNT(*) AS orders_today, COALESCE(SUM(total+delivery_fee),0) AS revenue_today, (SELECT COUNT(*) FROM drivers WHERE status!='offline') AS active_drivers, (SELECT COUNT(*) FROM orders WHERE status='pending') AS pending_orders FROM orders WHERE created_at>=NOW()-INTERVAL '24 hours'`);
    const r=rows[0];
    res.json({ ordersToday:parseInt(r.orders_today), revenueToday:parseFloat(r.revenue_today), activeDrivers:parseInt(r.active_drivers), pendingOrders:parseInt(r.pending_orders), avgDeliveryTime:23 });
  } catch (err) { console.error(err); res.status(500).json({error:'Server error'}); }
});

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('driver:position', async ({ driverId, lat, lng, token }) => {
    try { const u=jwt.verify(token,JWT_SECRET); if(u.id!==driverId)return; await pool.query('UPDATE drivers SET lat=$1,lng=$2 WHERE id=$3',[lat,lng,driverId]); io.emit('driver:position',{driverId,lat,lng}); } catch {}
  });
  socket.on('driver:join', ({ driverId, token }) => {
    try { const u=jwt.verify(token,JWT_SECRET); if(u.id===driverId)socket.join('driver:'+driverId); } catch {}
  });
});

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🛵  Rapido Production Backend`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Push VAPID: ${VAPID_PUBLIC.slice(0,20)}…`);
  console.log(`\n   Admin PIN : 0000`);
  console.log(`   Drivers   : Ahmed=1234  Khalil=2345  Rim=3456  Mohamed=4567\n`);
});