// === MOD_002 · NET_FORGE — Pure utilities ===
// Side-effect-free helpers extracted from mod_002_netmap.js.
// Only depends on JS built-ins; no DOM, no state object, no Supabase.
// Imported from mod_002_netmap.js as ES module (mod_002 is loaded with
// <script type="module">).

// --- IPv4 / CIDR ---------------------------------------------------------

// Parse "10.0.0.5", "10.0.0.5/24", etc. Returns null on malformed input.
// Returned shape: { ip, ipNum, prefix, mask, netNum, network }
//   - prefix defaults to /32 when no slash is given
//   - octets must be 0-255, prefix is clamped to 0-32
export function parseCidr(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d+))?$/);
  if (!m) return null;
  const oct = [+m[1], +m[2], +m[3], +m[4]];
  if (oct.some((o) => o < 0 || o > 255)) return null;
  const prefix = m[5] != null ? Math.max(0, Math.min(32, +m[5])) : 32;
  const ipNum = oct[0] * 0x1000000 + oct[1] * 0x10000 + oct[2] * 0x100 + oct[3];
  const mask = prefixToMask(prefix);
  const netNum = (ipNum & mask) >>> 0;
  return { ip: oct.join('.'), ipNum, prefix, mask, netNum, network: numToIp(netNum) };
}

// Build a 32-bit subnet mask from a prefix length (0..32).
export function prefixToMask(prefix) {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xFFFFFFFF;
  return ((0xFFFFFFFF << (32 - prefix)) >>> 0);
}

// Format a 32-bit unsigned int as dotted-quad IPv4 ("a.b.c.d").
export function numToIp(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Snap a CIDR string to its network base ("10.0.0.5/24" → "10.0.0.0/24").
// Returns null on invalid input.
export function cidrNormalize(str) {
  const p = parseCidr(str);
  if (!p) return null;
  return `${p.network}/${p.prefix}`;
}

// True if `ip` falls inside `cidr`. Both are CIDR-parseable strings.
export function ipInCidr(ip, cidr) {
  const a = parseCidr(ip), b = parseCidr(cidr);
  if (!a || !b) return false;
  return ((a.ipNum & b.mask) >>> 0) === b.netNum;
}

// Strip leading zeros from each octet of a dotted IP / CIDR string.
// "10.0.0.05" → "10.0.0.5", "010.0.0.005/24" → "10.0.0.5/24". Only rewrites
// strings that already match the full IP shape so partial input ("10.0.0.")
// and non-IP text pass through unchanged — keeps live typing usable.
export function normalizeIpInput(str) {
  if (str == null) return str;
  const s = String(str);
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d+)?$/);
  if (!m) return s;
  const oct = [m[1], m[2], m[3], m[4]].map((o) => String(parseInt(o, 10) || 0));
  if (oct.some((o) => Number(o) > 255)) return s;
  return oct.join('.') + (m[5] || '');
}

// --- ID generation -------------------------------------------------------

// Short, sortable-ish unique id. Random-prefixed + base36 timestamp suffix
// so collisions during a single click batch stay astronomically unlikely.
export function rid() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
