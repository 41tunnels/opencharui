// Real cross-process verification of relayFetch: a real Go relay binary
// and a real Go fakeagent binary (secure mode — the actual E2E handshake,
// not --insecure), talking to this project's real WebCrypto
// implementation over a real WebSocket on localhost. This is strictly
// stronger than the mock-socket tests in fetch.test.ts (which mock the
// network but use real crypto) — here nothing is mocked except which
// process is playing the "agent" role, since real amallo isn't buildable
// in this environment yet (see the build plan's Step 4 toolchain notes).
//
// Gated behind AMALLO_SMOKE_RELAY_EXE / AMALLO_SMOKE_FAKEAGENT_EXE env
// vars pointing at pre-built binaries — unset, these tests are skipped
// rather than failed, matching the equivalent gate in amallo's own
// smoke_test.rs.
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayTransport } from '@browser/relay/transport'
import { createRelayFetch } from '@browser/relay/fetch'
import { importPsk } from '@browser/relay/crypto'

function requireEnv(): { relayExe: string; fakeagentExe: string } | null {
  const relayExe = process.env.AMALLO_SMOKE_RELAY_EXE
  const fakeagentExe = process.env.AMALLO_SMOKE_FAKEAGENT_EXE
  if (!relayExe || !fakeagentExe) return null
  return { relayExe, fakeagentExe }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not allocate a port')))
      }
    })
  })
}

function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
        sock.end()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`))
        else setTimeout(attempt, 50)
      })
    }
    attempt()
  })
}

/** Accumulates a child's stderr from the moment it's attached — required
 * because a process typically writes several startup lines close enough
 * together that Node delivers them in one 'data' event; a listener
 * attached only *after* the first awaited match would already have
 * missed the rest. */
function trackStderr(child: ChildProcess): { buffer: () => string } {
  let text = ''
  child.stderr?.on('data', (buf: Buffer) => {
    text += buf.toString('utf8')
  })
  return { buffer: () => text }
}

function waitForMatch(getBuffer: () => string, pattern: RegExp, timeoutMs = 5000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = getBuffer().match(pattern)
      if (match) {
        resolve(match)
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${pattern} in:\n${getBuffer()}`))
        return
      }
      setTimeout(check, 20)
    }
    check()
  })
}

const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
})

describe('relayFetch: real cross-process smoke test (Go relay + Go fakeagent)', () => {
  const env = requireEnv()
  const maybeIt = env ? it : it.skip

  maybeIt('streams tokens through a real relay + real agent process, no mock', async () => {
    if (!env) return
    const relayPort = await freePort()
    const metricsPort = await freePort()

    const relay = spawn(env.relayExe, [], {
      env: {
        ...process.env,
        RELAY_ADDR: `:${relayPort}`,
        RELAY_METRICS_ADDR: `:${metricsPort}`,
        RELAY_ALLOWED_ORIGINS: '*'
      }
    })
    children.push(relay)
    await waitForPort(relayPort)

    const relayUrl = `ws://127.0.0.1:${relayPort}`
    const fakeagent = spawn(env.fakeagentExe, ['-relay', relayUrl])
    children.push(fakeagent)
    const fakeagentStderr = trackStderr(fakeagent)

    // fakeagent prints its generated pair_id/psk to stderr on startup —
    // parse them out so this test doesn't need to hardcode any pairing
    // material.
    const pairMatch = await waitForMatch(fakeagentStderr.buffer, /pair_id=(\S+)/)
    const pskMatch = await waitForMatch(fakeagentStderr.buffer, /psk=(\S+)/)
    const pairIdB64 = pairMatch[1]
    const pskB64 = pskMatch[1]

    const pairId = base64UrlDecode(pairIdB64)
    const psk = await importPsk(base64UrlDecode(pskB64))

    const transport = new RelayTransport({ relayUrl, pairId, psk })
    children.push({ kill: () => transport.close() } as unknown as ChildProcess)
    const relayFetch = createRelayFetch(() => transport)

    // fakeagent with no -upstream echoes a canned JSON response — enough
    // to prove the full real handshake + REQ/RESP round trip works end to
    // end across two separate OS processes.
    const res = await relayFetch('/api/tags', { method: 'GET' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"echo":true')
    expect(text).toContain('"method":"GET"')

    transport.close()
  }, 20000)

  maybeIt('recovers on the same socket when a second agent displaces the first', async () => {
    if (!env) return
    const relayPort = await freePort()
    const metricsPort = await freePort()

    const relay = spawn(env.relayExe, [], {
      env: {
        ...process.env,
        RELAY_ADDR: `:${relayPort}`,
        RELAY_METRICS_ADDR: `:${metricsPort}`,
        RELAY_ALLOWED_ORIGINS: '*'
      }
    })
    children.push(relay)
    await waitForPort(relayPort)
    const relayUrl = `ws://127.0.0.1:${relayPort}`

    const agentA = spawn(env.fakeagentExe, ['-relay', relayUrl])
    children.push(agentA)
    const aStderr = trackStderr(agentA)
    const pairIdB64 = (await waitForMatch(aStderr.buffer, /pair_id=(\S+)/))[1]
    const pskB64 = (await waitForMatch(aStderr.buffer, /psk=(\S+)/))[1]

    // Count sockets: the whole point is that the browser recovers by
    // handshaking again on the socket it already has.
    const socketUrls: string[] = []
    const transport = new RelayTransport(
      { relayUrl, pairId: base64UrlDecode(pairIdB64), psk: await importPsk(base64UrlDecode(pskB64)) },
      (url) => {
        socketUrls.push(url)
        return new WebSocket(url) as never
      }
    )
    children.push({ kill: () => transport.close() } as unknown as ChildProcess)
    const relayFetch = createRelayFetch(() => transport)

    expect((await relayFetch('/api/tags', { method: 'GET' })).status).toBe(200)
    await waitForMatch(aStderr.buffer, /stream \d+: GET \/api\/tags/)

    // A second agent on the same pairing displaces the first, exactly as a
    // redialling amallo does when the relay hasn't yet reaped the socket
    // its previous process left behind (sleep/wake, Wi-Fi flip). The relay
    // swaps the agent slot and sends this client nothing but peer_online.
    const agentB = spawn(env.fakeagentExe, ['-relay', relayUrl, '-pair', pairIdB64, '-psk', pskB64])
    children.push(agentB)
    const bStderr = trackStderr(agentB)
    await waitForMatch(aStderr.buffer, /recv:/, 10000)

    // Before the session lifecycle landed in transport.ts, this request
    // was sealed under the displaced session's keys and simply never
    // arrived — the agent held it, waiting for a HELLO that never came.
    const after = await relayFetch('/api/tags', { method: 'GET' })
    expect(after.status).toBe(200)
    expect(await after.text()).toContain('"echo":true')

    // Served by the *new* agent, over the *original* socket.
    await waitForMatch(bStderr.buffer, /stream \d+: GET \/api\/tags/, 10000)
    expect(socketUrls).toHaveLength(1)

    transport.close()
  }, 30000)
})

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
