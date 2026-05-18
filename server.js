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
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ DEFAULT NOW(),

      -- ІЧ датчики
      ir_left       TEXT,        -- 'black' | 'white'
      ir_right      TEXT,
      ir_left_raw   INTEGER,     -- 0 | 1 (сирий сигнал)
      ir_right_raw  INTEGER,

      -- Режим і команда
      mode          TEXT,        -- 'auto' | 'manual'
      command       TEXT,        -- 'forward' | 'stop' | 'auto_forward' тощо
      motors_on     BOOLEAN,
      motor_left    BOOLEAN,
      motor_right   BOOLEAN,

      -- Рух
      distance_m    REAL,        -- накопичена відстань (м)
      uptime_s      INTEGER,     -- час роботи (сек)
      base_speed    INTEGER      -- PWM швидкість 0-255
    )
  `);

  // Таблиця подій (зміна режиму, помилки тощо)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      type       TEXT,   -- 'mode_change' | 'command_change' | 'line_lost' | 'line_found'
      value      TEXT,   -- деталі події
      prev_value TEXT    -- попереднє значення
    )
  `);

  console.log('✅ БД готова');
}

initDB().catch(console.error);

// ===================== MIDDLEWARE — перевірка API ключа =====================
function checkKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===================== СТАН (для відстеження змін між запитами) =====================
let lastState = {
  mode: null,
  command: null,
  ir_left: null,
  ir_right: null,
};

// ===================== ЕНДПОІНТИ =====================

// ESP32 надсилає дані
app.post('/api/data', checkKey, async (req, res) => {
  const {
    ir_left, ir_right, ir_left_raw, ir_right_raw,
    mode, command, motors_on, motor_left, motor_right,
    distance_m, uptime_s, base_speed
  } = req.body;

  try {
    // Записуємо телеметрію
    await pool.query(`
      INSERT INTO telemetry
        (ir_left, ir_right, ir_left_raw, ir_right_raw, mode, command,
         motors_on, motor_left, motor_right, distance_m, uptime_s, base_speed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [ir_left, ir_right, ir_left_raw, ir_right_raw, mode, command,
        motors_on, motor_left, motor_right, distance_m, uptime_s, base_speed]);

    // Перевіряємо зміни та записуємо події
    const eventsToInsert = [];

    if (lastState.mode !== null && lastState.mode !== mode) {
      eventsToInsert.push(['mode_change', mode, lastState.mode]);
    }
    if (lastState.command !== null && lastState.command !== command) {
      eventsToInsert.push(['command_change', command, lastState.command]);
    }
    if (lastState.ir_left !== null && lastState.ir_left !== ir_left) {
      eventsToInsert.push(['ir_left_change', ir_left, lastState.ir_left]);
    }
    if (lastState.ir_right !== null && lastState.ir_right !== ir_right) {
      eventsToInsert.push(['ir_right_change', ir_right, lastState.ir_right]);
    }
    // Якщо обидва датчики втратили лінію в авто режимі
    if (mode === 'auto' && ir_left === 'white' && ir_right === 'white' &&
        !(lastState.ir_left === 'white' && lastState.ir_right === 'white')) {
      eventsToInsert.push(['line_lost', 'both_white', null]);
    }

    for (const [type, value, prev] of eventsToInsert) {
      await pool.query(
        'INSERT INTO events (type, value, prev_value) VALUES ($1,$2,$3)',
        [type, value, prev]
      );
    }

    // Оновлюємо lastState
    lastState = { mode, command, ir_left, ir_right };

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Останній стан (для дашборду)
app.get('/api/latest', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM telemetry ORDER BY id DESC LIMIT 1'
    );
    res.json(rows[0] ?? {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Історія телеметрії
app.get('/api/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 500);
  try {
    const { rows } = await pool.query(`
      SELECT created_at, mode, command, ir_left, ir_right,
             motors_on, distance_m, uptime_s
      FROM telemetry ORDER BY id DESC LIMIT $1
    `, [limit]);
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Останні події (журнал)
app.get('/api/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 200);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Статистика сесії
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                    AS total_records,
        MAX(distance_m)                             AS max_distance,
        MAX(uptime_s)                               AS max_uptime,
        COUNT(*) FILTER (WHERE mode = 'auto')       AS auto_records,
        COUNT(*) FILTER (WHERE mode = 'manual')     AS manual_records,
        COUNT(*) FILTER (WHERE motors_on = true)    AS moving_records,
        MIN(created_at)                             AS session_start,
        MAX(created_at)                             AS last_seen
      FROM telemetry
    `);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));