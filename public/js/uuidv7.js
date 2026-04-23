// UUIDv7: 48-bit unix-ms timestamp | 4-bit version | 12-bit random | 2-bit variant | 62-bit random.
// Monotonic within a single page session: if two calls land in the same ms, bumps the low bits.
let lastMs = 0;
let lastRand = 0n;

export function uuidv7() {
  const ms = Date.now();
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  let n = 0n;
  for (let i = 0; i < 10; i++) n = (n << 8n) | BigInt(rand[i]);

  if (ms === lastMs) {
    // Bump to preserve monotonicity within the same ms.
    n = lastRand + 1n;
  }
  lastMs = ms;
  lastRand = n;

  const rand74 = n & ((1n << 74n) - 1n);
  const ts = BigInt(ms) & ((1n << 48n) - 1n);

  // Layout: ts(48) | ver=0111(4) | rand_a(12) | var=10(2) | rand_b(62)
  const randA = (rand74 >> 62n) & 0xfffn;
  const randB = rand74 & ((1n << 62n) - 1n);

  const hi64 = (ts << 16n) | (0x7n << 12n) | randA;
  const lo64 = (0x2n << 62n) | randB;

  const hex = hi64.toString(16).padStart(16, '0') + lo64.toString(16).padStart(16, '0');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
