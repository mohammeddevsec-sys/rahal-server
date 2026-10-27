import express from 'express'
import cors from 'cors'
import { createReport, listActiveReports, confirmReport, resolveReport, deleteReport, purgeExpired, stats, REPORT_TYPES } from './db.js'
import { EdgeTTS } from 'edge-tts-universal'

const PORT = process.env.PORT || 3001
const app = express()

app.use(cors())
app.use(express.json({ limit: '64kb' }))

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), stats: stats() })
})

app.get('/api/reports', (req, res) => {
  try {
    const reports = listActiveReports()
    res.json({ ok: true, reports })
  } catch (err) {
    console.error('list reports failed:', err)
    res.status(500).json({ ok: false, error: 'list_failed' })
  }
})

app.post('/api/reports', (req, res) => {
  try {
    const { type, lat, lng, deviceId } = req.body || {}
    if (!type || !REPORT_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, error: 'invalid_type' })
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ ok: false, error: 'invalid_coords' })
    }
    const report = createReport({ type, lat, lng, ownerHash: deviceId || null })
    res.status(201).json({ ok: true, report })
  } catch (err) {
    console.error('create report failed:', err)
    res.status(500).json({ ok: false, error: 'create_failed' })
  }
})

app.post('/api/reports/:id/confirm', (req, res) => {
  try {
    const { id } = req.params
    const { deviceId } = req.body || {}
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'missing_device' })
    }
    const result = confirmReport(id, deviceId)
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: result.reason })
    }
    res.json({ ok: true, report: result.report, alreadyConfirmed: !!result.alreadyConfirmed })
  } catch (err) {
    console.error('confirm failed:', err)
    res.status(500).json({ ok: false, error: 'confirm_failed' })
  }
})

app.post('/api/reports/:id/resolve', (req, res) => {
  try {
    const { id } = req.params
    const changed = resolveReport(id)
    if (!changed) {
      return res.status(404).json({ ok: false, error: 'not_found_or_resolved' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('resolve failed:', err)
    res.status(500).json({ ok: false, error: 'resolve_failed' })
  }
})

app.delete('/api/reports/:id', (req, res) => {
  try {
    const { id } = req.params
    const changed = deleteReport(id)
    if (!changed) {
      return res.status(404).json({ ok: false, error: 'not_found' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('delete failed:', err)
    res.status(500).json({ ok: false, error: 'delete_failed' })
  }
})

const TTS_MAX_RETRIES = 3
const TTS_RETRY_DELAY_MS = 800

async function synthesizeWithRetry(text, voiceName) {
  let lastErr = null
  for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      const tts = new EdgeTTS(text, voiceName, { rate: '-5%', pitch: '-1Hz', volume: '+0%' })
      const result = await tts.synthesize()
      const buffer = Buffer.from(await result.audio.arrayBuffer())
      if (buffer.length > 0) return buffer
      lastErr = new Error('empty_audio')
    } catch (err) {
      lastErr = err
      console.error('tts attempt ' + attempt + '/' + TTS_MAX_RETRIES + ' failed:', err.message)
    }
    if (attempt < TTS_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, TTS_RETRY_DELAY_MS * attempt))
    }
  }
  throw lastErr || new Error('tts_all_attempts_failed')
}

const OVERPASS_MIRRORS = [
  'http://127.0.0.1:12345/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
]

app.post('/api/overpass', async (req, res) => {
  try {
    const { query } = req.body || {}
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_query' })
    }
    if (query.length > 4000) {
      return res.status(400).json({ ok: false, error: 'query_too_long' })
    }

    let lastErr = null
    for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
      const mirror = OVERPASS_MIRRORS[i]
      try {
        const body = 'data=' + encodeURIComponent(query)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 25000)
        const r = await fetch(mirror, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'RAHAL-Nav/0.1 (Iraq navigation app; +https://rahal.iq)',
            'Referer': 'https://rahal.iq/',
            'Accept': '*/*',
          },
          body,
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const preview = await r.text()
        console.log('overpass try', mirror, 'status=' + r.status, 'len=' + preview.length, 'head=' + preview.slice(0, 200).replace(/\s+/g, ' '))
        if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
          lastErr = new Error('mirror_' + r.status)
          continue
        }
        if (!r.ok) {
          lastErr = new Error('mirror_http_' + r.status)
          continue
        }
        let data
        try { data = JSON.parse(preview) } catch {
          lastErr = new Error('invalid_json')
          continue
        }
        res.set('Cache-Control', 'no-store')
        return res.json({ ok: true, data, mirror })
      } catch (err) {
        lastErr = err
      }
    }

    console.error('overpass proxy failed:', lastErr ? lastErr.message : 'unknown')
    res.status(502).json({ ok: false, error: 'overpass_failed' })
  } catch (err) {
    console.error('overpass proxy crashed:', err.message)
    res.status(500).json({ ok: false, error: 'proxy_crashed' })
  }
})

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body || {}
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_text' })
    }
    if (text.length > 500) {
      return res.status(400).json({ ok: false, error: 'text_too_long' })
    }
    const voiceName = voice || 'ar-IQ-RanaNeural'
    const buffer = await synthesizeWithRetry(text, voiceName)
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    })
    res.send(buffer)
  } catch (err) {
    console.error('tts failed after retries:', err.message)
    res.status(500).json({ ok: false, error: 'tts_failed' })
  }
})

setInterval(() => {
  try {
    const removed = purgeExpired()
    if (removed > 0) console.log('purged expired reports:', removed)
  } catch (err) {
    console.error('purge failed:', err)
  }
}, 5 * 60 * 1000)

app.listen(PORT, () => {
  console.log('rahal-server listening on http://localhost:' + PORT)
  console.log('database:', 'D:\\RAHAL\\server\\data\\rahal.db')
})

