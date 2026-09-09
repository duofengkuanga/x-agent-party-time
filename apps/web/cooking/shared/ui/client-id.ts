const HEX = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function')
    return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function')
    throw new Error('当前浏览器不支持安全随机数');

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return [
    HEX[bytes[0]!],
    HEX[bytes[1]!],
    HEX[bytes[2]!],
    HEX[bytes[3]!],
    '-',
    HEX[bytes[4]!],
    HEX[bytes[5]!],
    '-',
    HEX[bytes[6]!],
    HEX[bytes[7]!],
    '-',
    HEX[bytes[8]!],
    HEX[bytes[9]!],
    '-',
    HEX[bytes[10]!],
    HEX[bytes[11]!],
    HEX[bytes[12]!],
    HEX[bytes[13]!],
    HEX[bytes[14]!],
    HEX[bytes[15]!],
  ].join('');
}
