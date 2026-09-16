'use strict';

/**
 * Auto-discovery of Hollyland Astra (and other VISCA-over-IP) cameras.
 *
 * Strategy: for every host on the local /24 subnet(s), send a VISCA version
 * inquiry to both the Sony framing port (52381) and the raw UDP port (1259).
 * Anything that answers on either port is a VISCA camera. Sony-port replies
 * are preferred when a camera answers on both.
 */

const os = require('os');
const dgram = require('dgram');
const { cmd, sonyWrap, SONY_PORT, RAW_PORT } = require('./visca');

/** IPv4 /24 subnets of this machine, e.g. ["192.168.1"] */
function localSubnets() {
  const subnets = new Set();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        subnets.add(iface.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return [...subnets];
}

/**
 * Probe hosts for VISCA cameras.
 * @param {string[]} subnets  like ["192.168.1"]; defaults to local subnets
 * @param {number} timeoutMs  how long to wait for replies
 * @returns {Promise<Array<{ip: string, protocol: 'sony'|'raw'}>>}
 */
function scan(subnets, timeoutMs = 2500) {
  const nets = (subnets && subnets.length ? subnets : localSubnets());
  if (!nets.length) return Promise.resolve([]);

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map(); // ip -> protocol

    socket.on('error', () => {});
    socket.on('message', (msg, rinfo) => {
      if (!msg.length) return;
      const protocol = rinfo.port === SONY_PORT ? 'sony' : 'raw';
      const existing = found.get(rinfo.address);
      if (!existing || (existing === 'raw' && protocol === 'sony')) {
        found.set(rinfo.address, protocol);
      }
    });

    socket.bind(() => {
      const inq = cmd.versionInq();
      const sonyPacket = sonyWrap(inq, 1, 0x0110);
      let i = 1;
      // Pace the sends so we don't overflow the socket buffer: 32 hosts per tick.
      const interval = setInterval(() => {
        for (let n = 0; n < 32 && i <= 254; n++, i++) {
          for (const net of nets) {
            const ip = `${net}.${i}`;
            socket.send(sonyPacket, SONY_PORT, ip, () => {});
            socket.send(inq, RAW_PORT, ip, () => {});
          }
        }
        if (i > 254) clearInterval(interval);
      }, 20);

      setTimeout(() => {
        clearInterval(interval);
        try { socket.close(); } catch {}
        resolve([...found].map(([ip, protocol]) => ({ ip, protocol })));
      }, timeoutMs + 254 / 32 * 20);
    });
  });
}

module.exports = { scan, localSubnets };
