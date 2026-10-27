import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(dataDir, 'rahal.db')

export const db = new DatabaseSync(dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    confirmations INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    owner_hash TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reports_active ON reports(resolved_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_reports_geo ON reports(lat, lng);

  CREATE TABLE IF NOT EXISTS confirmations (
    report_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, device_id),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_confirm_report ON confirmations(report_id);
`)

export const REPORT_TYPES = ['accident', 'traffic', 'traffic_heavy', 'hazard', 'road_work', 'emergency', 'bad_weather', 'checkpoint', 'camera', 'speed_bump', 'fuel', 'animals']
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000
const CONFIRMATION_BOOST_THRESHOLD = 3
const CONFIRMATION_EXTRA_MS = 3 * 60 * 60 * 1000

export function createReport({ type, lat, lng, ownerHash }) {
  const id = randomUUID()
  const now = Date.now()
  const expiresAt = now + DEFAULT_TTL_MS
  const stmt = db.prepare(
    'INSERT INTO reports (id, type, lat, lng, created_at, expires_at, confirmations, owner_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  )
  stmt.run(id, type, lat, lng, now, expiresAt, ownerHash || null)
  return getReport(id)
}

export function getReport(id) {
  const stmt = db.prepare('SELECT * FROM reports WHERE id = ?')
  return stmt.get(id)
}

export function listActiveReports() {
  const now = Date.now()
  const stmt = db.prepare(
    'SELECT * FROM reports WHERE resolved_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 500'
  )
  return stmt.all(now)
}

export function confirmReport(reportId, deviceId) {
  const report = getReport(reportId)
  if (!report) return { ok: false, reason: 'not_found' }
  if (report.resolved_at) return { ok: false, reason: 'resolved' }

  const now = Date.now()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO confirmations (report_id, device_id, created_at) VALUES (?, ?, ?)'
  )
  const result = insert.run(reportId, deviceId, now)
  const added = result.changes > 0
  if (!added) return { ok: true, alreadyConfirmed: true, report }

  const newConfirmations = report.confirmations + 1
  let expiresAt = report.expires_at
  if (newConfirmations >= CONFIRMATION_BOOST_THRESHOLD) {
    expiresAt = Math.max(expiresAt, now + CONFIRMATION_EXTRA_MS)
  }

  const update = db.prepare('UPDATE reports SET confirmations = ?, expires_at = ? WHERE id = ?')
  update.run(newConfirmations, expiresAt, reportId)

  return { ok: true, added: true, report: getReport(reportId) }
}

export function resolveReport(reportId) {
  const now = Date.now()
  const stmt = db.prepare('UPDATE reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
  const result = stmt.run(now, reportId)
  return result.changes > 0
}

export function deleteReport(reportId) {
  const stmt = db.prepare('DELETE FROM reports WHERE id = ?')
  const result = stmt.run(reportId)
  return result.changes > 0
}

export function purgeExpired() {
  const now = Date.now()
  const stmt = db.prepare('DELETE FROM reports WHERE resolved_at IS NULL AND expires_at <= ?')
  const result = stmt.run(now)
  return result.changes
}

export function stats() {
  const now = Date.now()
  const total = db.prepare('SELECT COUNT(*) as c FROM reports').get()
  const active = db.prepare('SELECT COUNT(*) as c FROM reports WHERE resolved_at IS NULL AND expires_at > ?').get(now)
  return { total: total.c, active: active.c }
}
