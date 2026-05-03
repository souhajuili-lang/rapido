require('dotenv').config();

const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false  // keep false so your HTML pages load correctly
}));
// ═══════════════════════════════════════════════════════════════
// RAPIDO DELIVERY — Production Server (PostgreSQL)
// Node.js + Express + Socket.io + pg (node-postgres)
// ═══════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
// add this line with your other middleware:
app.use(express.static('public'));
const http       = require('http');
const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');
const { Pool }   = require('pg');

const app    = express();
const rateLimit = require('express-rate-limit');

// Limit login attempts — max 5 tries per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

app.use('/api/auth', authLimiter);
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'rapido_secret_2024';

// ── DATABASE POOL ─────────────────────────────────────────────
//
// Configure via environment variables (12-factor):
//
//   DATABASE_URL=postgres://user:pass@host:5432/rapido   (takes priority)
//     — or —
//   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
//
// For local dev without any env vars, defaults to:
//   postgres://postgres@localhost:5432/rapido
//
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost')
          ? false
          : { rejectUnauthorized: false },  // required for cloud providers (Heroku, Render, Supabase …)
      }
    : {
        host:     process.env.PGHOST     || 'localhost',
        port:     parseInt(process.env.PGPORT || '5432'),
        user:     process.env.PGUSER     || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'rapido',
      }
);

// Verify connection on startup
pool.connect()
  .then(client => {
    console.log('✅  PostgreSQL connected');
    client.release();
  })
  .catch(err => {
    console.error('❌  PostgreSQL connection failed:', err.message);
    console.error('    Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
    process.exit(1);
  });

// ── DB HELPERS ────────────────────────────────────────────────

/** Run a parameterised query and return all rows. */
const query = (text, params) => pool.query(text, params);

/** Return the first row or null. */
const queryOne = async (text, params) => {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
};

/** Translate a pg driver row → camelCase shape for the API. */
function rowToRestaurant(r) {
  if (!r) return null;
  return {
    id:          r.id,
    name:        r.name,
    emoji:       r.emoji,
    category:    r.category,
    address:     r.address,
    lat:         parseFloat(r.lat),
    lng:         parseFloat(r.lng),
    prepTime:    r.prep_time,
    rating:      parseFloat(r.rating),
    deliveryFee: parseFloat(r.delivery_fee),
    status:      r.status,
    hoursOpen:   r.hours_open,
    hoursClose:  r.hours_close,
    menu:        r.menu,
  };
}

function rowToDriver(r, includeHash = false) {
  if (!r) return null;
  const d = {
    id:               r.id,
    name:             r.name,
    phone:            r.phone,
    vehicle:          r.vehicle,
    zone:             r.zone,
    status:           r.status,
    lat:              r.lat ? parseFloat(r.lat) : null,
    lng:              r.lng ? parseFloat(r.lng) : null,
    rating:           parseFloat(r.rating),
    deliveriesToday:  r.deliveries_today,
    earningsToday:    parseFloat(r.earnings_today),
    totalDeliveries:  r.total_deliveries,
  };
  if (includeHash) d.pinHash = r.pin_hash;
  return d;
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    id:          r.id,
    customer:    r.customer,
    phone:       r.phone,
    restaurantId:r.restaurant_id,
    restaurant:  r.restaurant,
    items:       r.items,
    total:       parseFloat(r.total),
    deliveryFee: parseFloat(r.delivery_fee),
    address:     r.address,
    driverId:    r.driver_id,
    status:      r.status,
    rating:      r.rating,
    createdAt:   r.created_at ? new Date(r.created_at).getTime() : null,
    assignedAt:  r.assigned_at ? new Date(r.assigned_at).getTime() : null,
    deliveredAt: r.delivered_at ? new Date(r.delivered_at).getTime() : null,
  };
}

// Generate the next order ID atomically using the pg sequence
async function nextOrderId() {
  const { rows } = await pool.query("SELECT 'RP-' || nextval('order_seq') AS id");
  return rows[0].id;
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function authDriver(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── BROADCAST HELPER ──────────────────────────────────────────
function broadcast(event, data) {
  io.emit(event, data);
}

// ── AUTH ROUTES ───────────────────────────────────────────────

// POST /api/auth/driver  { driverId, pin }
app.post('/api/auth/driver', async (req, res) => {
  try {
    const { driverId, pin } = req.body;
    if (!driverId || !pin) return res.status(400).json({ error: 'driverId and pin required' });

    // Use pgcrypto crypt() to verify — avoids pulling the hash into JS
    const row = await queryOne(
      `SELECT *, (pin_hash = crypt($1, pin_hash)) AS pin_ok
         FROM drivers WHERE id = $2`,
      [String(pin), parseInt(driverId)]
    );

    if (!row)        return res.status(404).json({ error: 'Livreur introuvable' });
    if (!row.pin_ok) return res.status(401).json({ error: 'PIN incorrect' });

    const token = jwt.sign(
      { id: row.id, role: 'driver', name: row.name },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, driver: rowToDriver(row) });
  } catch (err) {
    console.error('auth/driver:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/admin  { pin }
app.post('/api/auth/admin', async (req, res) => {
  try {
    const { pin } = req.body;
    const row = await queryOne(
      `SELECT (admin_pin_hash = crypt($1, admin_pin_hash)) AS pin_ok FROM settings WHERE id = 1`,
      [String(pin)]
    );
    if (!row || !row.pin_ok) return res.status(401).json({ error: 'PIN admin incorrect' });

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) {
    console.error('auth/admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── RESTAURANT ROUTES ─────────────────────────────────────────

// GET /api/restaurants
app.get('/api/restaurants', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM restaurants ORDER BY id');
    res.json(rows.map(rowToRestaurant));
  } catch (err) {
    console.error('GET /restaurants:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/restaurants/:id
app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM restaurants WHERE id = $1', [parseInt(req.params.id)]);
    row ? res.json(rowToRestaurant(row)) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('GET /restaurants/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/restaurants
app.post('/api/restaurants', authAdmin, async (req, res) => {
  try {
    const { name, emoji='🍽️', category, address, lat, lng,
            prepTime=15, deliveryFee=2.5, status='open',
            hoursOpen='09:00', hoursClose='22:00', menu=[] } = req.body;
    if (!name || !category || !address)
      return res.status(400).json({ error: 'name, category and address are required' });

    const { rows } = await pool.query(
      `INSERT INTO restaurants (name,emoji,category,address,lat,lng,prep_time,delivery_fee,status,hours_open,hours_close,menu)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [name, emoji, category, address, lat||null, lng||null,
       prepTime, deliveryFee, status, hoursOpen, hoursClose, JSON.stringify(menu)]
    );
    const newRest = rowToRestaurant(rows[0]);
    broadcast('restaurant:added', newRest);
    res.json(newRest);
  } catch (err) {
    console.error('POST /restaurants:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/restaurants/:id   (full replace from admin form)
app.put('/api/restaurants/:id', authAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, emoji, category, address, lat, lng,
            prepTime, deliveryFee, status, hoursOpen, hoursClose, menu } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurants
          SET name=$1, emoji=$2, category=$3, address=$4, lat=$5, lng=$6,
              prep_time=$7, delivery_fee=$8, status=$9,
              hours_open=$10, hours_close=$11, menu=$12
        WHERE id=$13 RETURNING *`,
      [name, emoji, category, address, lat||null, lng||null,
       prepTime, deliveryFee, status, hoursOpen, hoursClose,
       JSON.stringify(menu||[]), id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const updated = rowToRestaurant(rows[0]);
    broadcast('restaurant:updated', updated);
    res.json(updated);
  } catch (err) {
    console.error('PUT /restaurants/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/restaurants/:id
app.delete('/api/restaurants/:id', authAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM restaurants WHERE id=$1', [id]);
    broadcast('restaurant:deleted', { id });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /restaurants/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ORDER ROUTES ──────────────────────────────────────────────

// GET /api/orders?status=pending&driverId=1
app.get('/api/orders', async (req, res) => {
  try {
    const conditions = [];
    const params     = [];

    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (req.query.driverId) {
      params.push(parseInt(req.query.driverId));
      conditions.push(`driver_id = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(rows.map(rowToOrder));
  } catch (err) {
    console.error('GET /orders:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/orders/:id
app.get('/api/orders/:id', async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    row ? res.json(rowToOrder(row)) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('GET /orders/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  try {
    const {
      customer, phone='', restaurantId, restaurant,
      items=[], total=0, deliveryFee, address,
    } = req.body;

    if (!customer || !restaurant || !address)
      return res.status(400).json({ error: 'customer, restaurant and address are required' });

    // Get restaurant's delivery fee if not provided
    let fee = deliveryFee;
    if (fee === undefined || fee === null) {
      const restRow = await queryOne('SELECT delivery_fee FROM restaurants WHERE id=$1', [restaurantId]);
      fee = restRow ? parseFloat(restRow.delivery_fee) : 2.5;
    }

    const id = await nextOrderId();
    const { rows } = await pool.query(
      `INSERT INTO orders (id,customer,phone,restaurant_id,restaurant,items,total,delivery_fee,address,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW()) RETURNING *`,
      [id, customer, phone, restaurantId||null, restaurant,
       JSON.stringify(items), total, fee, address]
    );
    const newOrder = rowToOrder(rows[0]);
    broadcast('order:new', newOrder);

    // Auto-assign if enabled
    const settings = await queryOne('SELECT auto_assign FROM settings WHERE id=1');
    if (settings?.auto_assign) {
      const freeDriver = await queryOne(
        "SELECT id FROM drivers WHERE status='online' ORDER BY deliveries_today ASC LIMIT 1"
      );
      if (freeDriver) {
        // Delay 3 s to mimic async dispatch
        setTimeout(() => autoAssign(id, freeDriver.id), 3000);
      }
    }

    res.json(newOrder);
  } catch (err) {
    console.error('POST /orders:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function autoAssign(orderId, driverId) {
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET driver_id=$1, status='on_the_way', assigned_at=NOW()
         WHERE id=$2 AND status='pending' RETURNING *`,
      [driverId, orderId]
    );
    if (!rows[0]) return;  // already taken
    await pool.query(
      "UPDATE drivers SET status='busy' WHERE id=$1", [driverId]
    );
    broadcast('order:updated', rowToOrder(rows[0]));
    broadcast('driver:updated', rowToDriver(
      await queryOne('SELECT * FROM drivers WHERE id=$1', [driverId])
    ));
  } catch (err) {
    console.error('autoAssign error:', err);
  }
}

// PATCH /api/orders/:id  — update status, rating, driver, etc.
app.patch('/api/orders/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id      = req.params.id;
    const updates = req.body;

    // Build dynamic SET clause
    const setClauses = [];
    const params     = [];

    const fieldMap = {
      status:      'status',
      driverId:    'driver_id',
      rating:      'rating',
      assignedAt:  'assigned_at',
      deliveredAt: 'delivered_at',
    };

    for (const [jsKey, pgCol] of Object.entries(fieldMap)) {
      if (jsKey in updates) {
        params.push(
          jsKey === 'assignedAt' || jsKey === 'deliveredAt'
            ? updates[jsKey] ? new Date(updates[jsKey]) : null
            : updates[jsKey]
        );
        setClauses.push(`${pgCol} = $${params.length}`);
      }
    }

    // Special: deliveredAt NOW() shorthand
    if (updates.status === 'delivered' && !('deliveredAt' in updates)) {
      setClauses.push('delivered_at = NOW()');
    }

    if (setClauses.length === 0)
      return res.status(400).json({ error: 'No valid fields to update' });

    params.push(id);
    const { rows } = await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );

    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const updated = rowToOrder(rows[0]);

    // On delivery — update driver stats & free them
    if (updates.status === 'delivered' && updated.driverId) {
      await client.query(
        `UPDATE drivers
            SET status          = 'online',
                deliveries_today = deliveries_today + 1,
                earnings_today   = earnings_today + $1,
                total_deliveries = total_deliveries + 1
          WHERE id = $2`,
        [updated.deliveryFee * 1.8, updated.driverId]
      );
      const driverRow = await client.query('SELECT * FROM drivers WHERE id=$1', [updated.driverId]);
      broadcast('driver:updated', rowToDriver(driverRow.rows[0]));
    }

    await client.query('COMMIT');
    broadcast('order:updated', updated);
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /orders/:id:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── DRIVER ROUTES ─────────────────────────────────────────────

// GET /api/drivers  (admin only — returns all without pin_hash)
app.get('/api/drivers', authAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM drivers ORDER BY id');
    res.json(rows.map(r => rowToDriver(r)));
  } catch (err) {
    console.error('GET /drivers:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/drivers/me  (driver's own data)
app.get('/api/drivers/me', authDriver, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM drivers WHERE id=$1', [req.user.id]);
    row ? res.json(rowToDriver(row)) : res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('GET /drivers/me:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/drivers/:id  (driver can update own record)
app.patch('/api/drivers/:id', authDriver, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (req.user.id !== id) return res.status(403).json({ error: 'Forbidden' });

    const { status, lat, lng, earningsToday, deliveriesToday, totalDeliveries } = req.body;

    const setClauses = [];
    const params     = [];

    const allowed = { status, lat, lng,
                      earningsToday:   'earnings_today',
                      deliveriesToday: 'deliveries_today',
                      totalDeliveries: 'total_deliveries' };

    if (status !== undefined) { params.push(status); setClauses.push(`status=$${params.length}`); }
    if (lat    !== undefined) { params.push(lat);    setClauses.push(`lat=$${params.length}`);    }
    if (lng    !== undefined) { params.push(lng);    setClauses.push(`lng=$${params.length}`);    }
    if (earningsToday  !== undefined) { params.push(earningsToday);  setClauses.push(`earnings_today=$${params.length}`);   }
    if (deliveriesToday!== undefined) { params.push(deliveriesToday);setClauses.push(`deliveries_today=$${params.length}`); }
    if (totalDeliveries!== undefined) { params.push(totalDeliveries);setClauses.push(`total_deliveries=$${params.length}`); }

    if (!setClauses.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE drivers SET ${setClauses.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    const updated = rowToDriver(rows[0]);
    broadcast('driver:updated', updated);
    res.json(updated);
  } catch (err) {
    console.error('PATCH /drivers/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/drivers/:id  (admin can update any driver field)
app.patch('/api/admin/drivers/:id', authAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, lat, lng } = req.body;

    const setClauses = [];
    const params     = [];
    if (status !== undefined) { params.push(status); setClauses.push(`status=$${params.length}`); }
    if (lat    !== undefined) { params.push(lat);    setClauses.push(`lat=$${params.length}`);    }
    if (lng    !== undefined) { params.push(lng);    setClauses.push(`lng=$${params.length}`);    }

    if (!setClauses.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE drivers SET ${setClauses.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    const updated = rowToDriver(rows[0]);
    broadcast('driver:updated', updated);
    res.json(updated);
  } catch (err) {
    console.error('PATCH /admin/drivers/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SETTINGS ROUTES ───────────────────────────────────────────

// GET /api/settings
app.get('/api/settings', authAdmin, async (_req, res) => {
  try {
    const row = await queryOne('SELECT * FROM settings WHERE id=1');
    if (!row) return res.status(500).json({ error: 'Settings not found' });
    res.json({
      deliveryFee:         parseFloat(row.delivery_fee),
      maxRadius:           row.max_radius,
      acceptOrders:        row.accept_orders,
      autoAssign:          row.auto_assign,
      platformCommission:  row.platform_commission,
      // Never expose the hash to the client
    });
  } catch (err) {
    console.error('GET /settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/settings
app.patch('/api/settings', authAdmin, async (req, res) => {
  try {
    const { deliveryFee, maxRadius, acceptOrders, autoAssign, platformCommission, adminPin } = req.body;

    const setClauses = [];
    const params     = [];

    if (deliveryFee        !== undefined) { params.push(deliveryFee);        setClauses.push(`delivery_fee=$${params.length}`);        }
    if (maxRadius          !== undefined) { params.push(maxRadius);          setClauses.push(`max_radius=$${params.length}`);          }
    if (acceptOrders       !== undefined) { params.push(acceptOrders);       setClauses.push(`accept_orders=$${params.length}`);       }
    if (autoAssign         !== undefined) { params.push(autoAssign);         setClauses.push(`auto_assign=$${params.length}`);         }
    if (platformCommission !== undefined) { params.push(platformCommission); setClauses.push(`platform_commission=$${params.length}`); }
    if (adminPin           !== undefined) {
      // Re-hash the new PIN with bcrypt via pgcrypto
      params.push(String(adminPin));
      setClauses.push(`admin_pin_hash = crypt($${params.length}, gen_salt('bf',10))`);
    }

    if (!setClauses.length) return res.status(400).json({ error: 'Nothing to update' });

    await pool.query(
      `UPDATE settings SET ${setClauses.join(',')} WHERE id=1`,
      params
    );
    // Return fresh settings (sans hash)
    const updated = await queryOne('SELECT * FROM settings WHERE id=1');
    res.json({
      deliveryFee:         parseFloat(updated.delivery_fee),
      maxRadius:           updated.max_radius,
      acceptOrders:        updated.accept_orders,
      autoAssign:          updated.auto_assign,
      platformCommission:  updated.platform_commission,
      adminPin:            adminPin ? '****' : undefined,   // masked
    });
  } catch (err) {
    console.error('PATCH /settings:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── STATS ─────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                              AS orders_today,
        COALESCE(SUM(total + delivery_fee),0)                AS revenue_today,
        (SELECT COUNT(*) FROM drivers WHERE status != 'offline')   AS active_drivers,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending')     AS pending_orders
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);
    const r = rows[0];
    res.json({
      ordersToday:     parseInt(r.orders_today),
      revenueToday:    parseFloat(r.revenue_today),
      activeDrivers:   parseInt(r.active_drivers),
      pendingOrders:   parseInt(r.pending_orders),
      avgDeliveryTime: 23,
    });
  } catch (err) {
    console.error('GET /stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  // Driver sends live GPS
  socket.on('driver:position', async ({ driverId, lat, lng, token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user.id !== driverId) return;
      await pool.query('UPDATE drivers SET lat=$1,lng=$2 WHERE id=$3', [lat, lng, driverId]);
      io.emit('driver:position', { driverId, lat, lng });
    } catch {}
  });

  // Driver joins own room
  socket.on('driver:join', ({ driverId, token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user.id === driverId) socket.join('driver:' + driverId);
    } catch {}
  });

  socket.on('disconnect', () => {});
});

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🛵  Rapido Production Backend`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Database: PostgreSQL (${process.env.DATABASE_URL || process.env.PGDATABASE || 'rapido'})`);
  console.log(`\n   Default credentials:`);
  console.log(`   Admin PIN : 0000`);
  console.log(`   Drivers   : Ahmed=1234  Khalil=2345  Rim=3456  Mohamed=4567\n`);
});
