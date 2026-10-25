// Minimal server side of RFC 6455 for broadcasting: text and binary frames out,
// ping/close handled. Visitors may only report where their camera looks.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function accept(request, socket, { maxClients = 500, clients }) {
  const key = request.headers['sec-websocket-key'];
  if (!key || request.headers.upgrade?.toLowerCase() !== 'websocket' || clients.size >= maxClients) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const client = { socket, alive: true, buffered: () => socket.writableLength };
  clients.add(client);
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 64 * 1024) return drop();
    while (pending.length >= 2) {
      const op = pending[0] & 0x0f, masked = pending[1] & 0x80;
      let len = pending[1] & 0x7f, off = 2;
      if (len === 126) { if (pending.length < 4) return; len = pending.readUInt16BE(2); off = 4; }
      else if (len === 127) return drop();
      const need = off + (masked ? 4 : 0) + len;
      if (pending.length < need) return;
      const mask = masked ? pending.subarray(off, off + 4) : null, body = Buffer.from(pending.subarray(need - len, need));
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      pending = pending.subarray(need);
      if (op === 0x8) return drop(true);
      if (op === 0x1 && body.length <= 512) client.onText?.(body.toString('utf8'));
      if (op === 0x9) send(client, body, 0xA);
      if (op === 0xA) client.alive = true;
    }
  });
  const drop = (polite = false) => {
    if (!clients.has(client)) return;
    clients.delete(client);
    try { if (polite) socket.write(Buffer.from([0x88, 0])); } catch {}
    socket.destroy();
  };
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => drop());
  client.drop = drop;
  return client;
}

export function frame(payload, opcode) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}
export function send(client, payload, opcode = 0x2) { sendRaw(client, frame(payload, opcode)); }
// Slow viewers are skipped rather than allowed to grow server memory.
export function sendRaw(client, bytes) { if (client.buffered() < 2 * 1024 * 1024) client.socket.write(bytes); }
