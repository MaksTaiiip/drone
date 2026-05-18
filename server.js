require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== ІНІЦІАЛІЗАЦІЯ БД =====================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      ir_left         TEXT,
      ir_right        TEXT,
      ir_left_raw     INTEGER,
      ir_right_raw    INTEGER,
      mode            TEXT,
      command         TEXT,
      motors_on       BOOLEAN,
      motor_left      BOOLEAN,
      motor_right     BOOLEAN,
      sonar_cm        REAL,
      obstacle        BOOLEAN,
      obstacle_count  INTEGER,
      distance_m      REAL,
      uptime_s        INTEGER,
      base_speed      INTEGER
    )
  `);

  // Міграція для існуючої БД
  for (const sql of [
    "ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS sonar_cm       REAL",
    "ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS obstacle        BOOLEAN",
    "ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS obstacle_count  INTEGER",
  ]) await pool.query(sql).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      type       TEXT,
      value      TEXT,
      prev_value TEXT
    )
  `);

  console.log('✅ БД готова');
}

initDB().catch(console.error);

function checkKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

let lastState = { mode: null, command: null, ir_left: null, ir_right: null, obstacle: null };

// ===================== ЕНДПОІНТИ =====================

app.post('/api/data', checkKey, async (req, res) => {
  const {
    ir_left, ir_right, ir_left_raw, ir_right_raw,
    mode, command, motors_on, motor_left, motor_right,
    sonar_cm, obstacle, obstacle_count,
    distance_m, uptime_s, base_speed
  } = req.body;

  try {
    await pool.query(`
      INSERT INTO telemetry
        (ir_left, ir_right, ir_left_raw, ir_right_raw,
         mode, command, motors_on, motor_left, motor_right,
         sonar_cm, obstacle, obstacle_count,
         distance_m, uptime_s, base_speed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [ir_left, ir_right, ir_left_raw, ir_right_raw,
        mode, command, motors_on, motor_left, motor_right,
        sonar_cm ?? null, obstacle ?? null, obstacle_count ?? null,
        distance_m, uptime_s, base_speed]);

    const ev = [];
    if (lastState.mode     !== null && lastState.mode     !== mode)     ev.push(['mode_change',        mode,                         lastState.mode]);
    if (lastState.command  !== null && lastState.command  !== command)  ev.push(['command_change',      command,                      lastState.command]);
    if (lastState.ir_left  !== null && lastState.ir_left  !== ir_left)  ev.push(['ir_left_change',      ir_left,                      lastState.ir_left]);
    if (lastState.ir_right !== null && lastState.ir_right !== ir_right) ev.push(['ir_right_change',     ir_right,                     lastState.ir_right]);
    if (lastState.obstacle === false && obstacle === true)               ev.push(['obstacle_detected',   `${(sonar_cm||0).toFixed(1)} см`, null]);
    if (lastState.obstacle === true  && obstacle === false)              ev.push(['obstacle_cleared',    'шлях вільний',               null]);
    if (mode === 'auto' && ir_left === 'white' && ir_right === 'white'
        && !(lastState.ir_left === 'white' && lastState.ir_right === 'white'))
      ev.push(['line_lost', 'обидва датчики: біла', null]);

    for (const [type, value, prev] of ev)
      await pool.query('INSERT INTO events (type,value,prev_value) VALUES ($1,$2,$3)', [type, value, prev]);

    lastState = { mode, command, ir_left, ir_right, obstacle: obstacle ?? null };
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM telemetry ORDER BY id DESC LIMIT 1');
    if (!rows[0]) return res.json({});
    rows[0].online = (Date.now() - new Date(rows[0].created_at).getTime()) < 15000;
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 500);
  try {
    const { rows } = await pool.query(`
      SELECT created_at, mode, command, ir_left, ir_right,
             motors_on, distance_m, uptime_s, sonar_cm, obstacle
      FROM telemetry ORDER BY id DESC LIMIT $1`, [limit]);
    res.json(rows.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 200);
  try {
    const { rows } = await pool.query('SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                      AS total_records,
        MAX(distance_m)                               AS max_distance,
        MAX(uptime_s)                                 AS max_uptime,
        COUNT(*) FILTER (WHERE mode = 'auto')         AS auto_records,
        COUNT(*) FILTER (WHERE mode = 'manual')       AS manual_records,
        COUNT(*) FILTER (WHERE mode = 'avoid')        AS avoid_records,
        COUNT(*) FILTER (WHERE motors_on = true)      AS moving_records,
        MAX(obstacle_count)                           AS total_obstacles,
        MIN(created_at)                               AS session_start,
        MAX(created_at)                               AS last_seen
      FROM telemetry
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    const https = require('https');
    setInterval(() => {
      https.get(SELF_URL + '/api/latest', r =>
        console.log(`[ping] ${new Date().toISOString()} → ${r.statusCode}`)
      ).on('error', e => console.error(`[ping] ${e.message}`));
    }, 14 * 60 * 1000);
    console.log(`🔔 Self-ping → ${SELF_URL}`);
  }
});
