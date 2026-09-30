// server.js
import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 3000

const LIST_API = 'https://api.vmp.ir/server/list/list.json'
const PLAYERS_API = 'https://api.vmp.ir/server/api.php?work=singleData2&id='
const CACHE_TTL = 60000
const SCAN_WORKERS = 6
const SCAN_TIMEOUT = 8000

app.use(cors())
app.use(express.json())

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return hit.v
}

function cacheSet(key, v) {
  cache.set(key, { v, t: Date.now() })
}

async function fetchJson(url, timeout = SCAN_TIMEOUT) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function stripColors(s) {
  return String(s ?? '').replace(/\^\d/g, '')
}

function boostTotal(s) {
  if (s.upvotePower) return s.upvotePower
  if (s.boosts) return Object.values(s.boosts).reduce((a, b) => a + (b.count || 0), 0)
  return 0
}

function isBoosted(s) {
  return (s.upvotePower || 0) > 0 || (s.boosts && Object.keys(s.boosts).length > 0)
}

function normalizeServer(s) {
  return {
    id: s.id,
    hostname: stripColors(s.hostname || s.vars?.sv_projectName || ''),
    projectName: s.vars?.sv_projectName || null,
    gametype: s.gametype || null,
    mapname: s.mapname || null,
    locale: s.vars?.locale || null,
    tags: (s.vars?.tags || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean),
    clients: s.clients || 0,
    maxClients: Number(s.svMaxclients || s.vars?.sv_maxClients || 0),
    upvotePower: s.upvotePower || 0,
    boostCount: boostTotal(s),
    boosted: isBoosted(s),
    premium: s.premium || null,
    connectEndPoints: s.connectEndPoints || [],
    iconVersion: s.iconVersion ?? null,
  }
}

function normalizePlayer(p) {
  return {
    id: p.id,
    name: stripColors(p.name || ''),
    ping: p.ping ?? null,
    identifiers: p.identifiers || [],
  }
}

function matchPlayer(p, rawQuery) {
  const q = rawQuery.toLowerCase().trim()
  if (!q) return false

  if (
    stripColors(p.name || '')
      .toLowerCase()
      .includes(q)
  )
    return true
  if (String(p.id) === q) return true

  const nq = q.replace(/^(steam|license|vmp|discord):/i, '').trim()
  if (!nq) return false

  for (const id of p.identifiers || []) {
    const norm = id.toLowerCase().replace(/^(steam|license|vmp|discord):/i, '')
    if (norm === nq || norm.includes(nq)) return true
  }
  return false
}

function matchType(p, rawQuery) {
  const q = rawQuery.toLowerCase().trim()
  if (
    stripColors(p.name || '')
      .toLowerCase()
      .includes(q)
  )
    return 'name'

  const nq = q.replace(/^(steam|license|vmp|discord):/i, '').trim()
  if (!nq) return 'id'

  for (const id of p.identifiers || []) {
    const norm = id.toLowerCase().replace(/^(steam|license|vmp|discord):/i, '')
    if (norm === nq) return 'id-exact'
    if (norm.includes(nq)) return 'id-partial'
  }
  return 'id'
}

async function getServers() {
  const cached = cacheGet('servers')
  if (cached) return cached

  const raw = await fetchJson(LIST_API, 15000)
  const list = Array.isArray(raw) ? raw : raw.Data || raw.servers || []
  const normalized = list.map(normalizeServer)
  cacheSet('servers', normalized)
  return normalized
}

async function getServerPlayers(serverId) {
  const key = `srv:${serverId}`
  const cached = cacheGet(key)
  if (cached) return cached

  const json = await fetchJson(PLAYERS_API + encodeURIComponent(serverId))
  const d = json.Data || {}
  const result = {
    id: d.hostname ? serverId : serverId,
    hostname: stripColors(d.hostname || ''),
    gametype: d.gametype || null,
    mapname: d.mapname || null,
    clients: d.clients || 0,
    maxClients: Number(d.sv_maxclients || 0),
    players: (d.players || []).map(normalizePlayer).sort((a, b) => (a.id || 0) - (b.id || 0)),
  }
  cacheSet(key, result)
  return result
}

async function searchPlayers(query, options = {}) {
  const { includeEmpty = false, limit = 100, concurrency = SCAN_WORKERS } = options
  const servers = await getServers()

  const targets = includeEmpty ? servers : servers.filter(s => s.clients > 0)
  const queue = targets.slice()
  const hits = []

  async function worker() {
    while (queue.length) {
      const srv = queue.shift()
      if (!srv) break
      try {
        const data = await getServerPlayers(srv.id)
        for (const p of data.players || []) {
          if (matchPlayer(p, query)) {
            hits.push({
              player: p,
              server: {
                id: srv.id,
                hostname: srv.hostname,
                clients: data.clients,
                maxClients: data.maxClients,
              },
              matchType: matchType(p, query),
              scannedAt: new Date().toISOString(),
            })
            if (hits.length >= limit) return
          }
        }
      } catch {
        // skip unreachable servers
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  await Promise.all(workers)

  const order = { 'id-exact': 0, name: 1, 'id-partial': 2, id: 3 }
  hits.sort((a, b) => {
    const d = (order[a.matchType] ?? 9) - (order[b.matchType] ?? 9)
    return d !== 0 ? d : a.player.name.localeCompare(b.player.name, 'fa')
  })

  return {
    query,
    scannedServers: targets.length,
    totalResults: hits.length,
    results: hits,
  }
}

app.get('/api/servers', async (req, res) => {
  try {
    const servers = await getServers()
    const { gametype, locale, boosted, online, q, sort, limit } = req.query

    let out = servers.filter(s => {
      if (gametype && s.gametype !== gametype) return false
      if (locale && s.locale !== locale) return false
      if (boosted === 'true' && !s.boosted) return false
      if (boosted === 'false' && s.boosted) return false
      if (online === 'true' && s.clients <= 0) return false
      if (q) {
        const hay = [s.hostname, s.projectName, s.gametype, s.tags.join(' '), s.id]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q.toLowerCase())) return false
      }
      return true
    })

    const sorters = {
      players_desc: (a, b) => b.clients - a.clients,
      players_asc: (a, b) => a.clients - b.clients,
      max_desc: (a, b) => b.maxClients - a.maxClients,
      name_asc: (a, b) => a.hostname.localeCompare(b.hostname, 'fa'),
      boost_desc: (a, b) => b.boostCount - a.boostCount,
    }
    out.sort(sorters[sort] || sorters.players_desc)

    if (limit) out = out.slice(0, Number(limit))

    res.json({
      total: out.length,
      servers: out,
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/servers/:id', async (req, res) => {
  try {
    const data = await getServerPlayers(req.params.id)
    res.json(data)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/servers/:id/players', async (req, res) => {
  try {
    const data = await getServerPlayers(req.params.id)
    res.json({
      serverId: req.params.id,
      hostname: data.hostname,
      clients: data.clients,
      maxClients: data.maxClients,
      players: data.players,
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'query required' })

  const includeEmpty = req.query.includeEmpty === 'true'
  const limit = Math.min(Number(req.query.limit) || 100, 500)

  try {
    const result = await searchPlayers(q, { includeEmpty, limit })
    res.json(result)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/stats', async (req, res) => {
  try {
    const servers = await getServers()
    res.json({
      totalServers: servers.length,
      onlineServers: servers.filter(s => s.clients > 0).length,
      totalPlayers: servers.reduce((a, s) => a + s.clients, 0),
      boostedServers: servers.filter(s => s.boosted).length,
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedKeys: cache.size, uptime: process.uptime() })
})

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`)
})
