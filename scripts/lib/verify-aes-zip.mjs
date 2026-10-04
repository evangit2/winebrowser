import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Independent WinZip AES reader. The Windows DLL computes its own PBKDF2,
// encryption, authentication and deflate; Node validates all four independently.
export function verifyAesZip(archive, expected, password) {
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50)
    end--;
  assert.ok(end >= 0);
  const count = archive.readUInt16LE(end + 10),
    files = [],
    encrypted = [];
  let at = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    assert.equal(archive.readUInt16LE(at + 10), 99);
    const nameLength = archive.readUInt16LE(at + 28),
      extraLength = archive.readUInt16LE(at + 30);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const extra = archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    let aes;
    for (let offset = 0; offset + 4 <= extra.length;) {
      const size = extra.readUInt16LE(offset + 2);
      if (extra.readUInt16LE(offset) === 0x9901)
        aes = extra.subarray(offset + 4, offset + 4 + size);
      offset += 4 + size;
    }
    assert.ok(aes);
    assert.equal(aes.readUInt16LE(0), 2);
    assert.equal(aes.subarray(2, 4).toString(), 'AE');
    assert.equal(aes[4], 3); // AES-256
    const method = aes.readUInt16LE(5);
    assert.ok(method === 0 || method === 8); // stored or deflate, chosen by the original codec
    const local = archive.readUInt32LE(at + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const payload = archive.subarray(start, start + archive.readUInt32LE(at + 20));
    const salt = payload.subarray(0, 16),
      verifier = payload.subarray(16, 18);
    const ciphertext = payload.subarray(18, -10),
      authentication = payload.subarray(-10);
    const keys = pbkdf2Sync(password, salt, 1000, 66, 'sha1');
    assert.deepEqual(verifier, keys.subarray(64));
    assert.deepEqual(
      authentication,
      createHmac('sha1', keys.subarray(32, 64)).update(ciphertext).digest().subarray(0, 10),
    );
    const counters = Buffer.alloc(Math.ceil(ciphertext.length / 16) * 16);
    for (let block = 0; block < counters.length / 16; block++)
      counters.writeUInt32LE(block + 1, block * 16);
    const cipher = createCipheriv('aes-256-ecb', keys.subarray(0, 32), null);
    cipher.setAutoPadding(false);
    const stream = Buffer.concat([cipher.update(counters), cipher.final()]);
    const compressed = Buffer.from(ciphertext);
    for (let n = 0; n < compressed.length; n++) compressed[n] ^= stream[n];
    assert.deepEqual(method === 8 ? inflateRawSync(compressed) : compressed, expected[name], name);
    files.push(name);
    encrypted.push({ name, method, ciphertextOffset: start + 18, salt: salt.toString('hex') });
    at += 46 + nameLength + extraLength + archive.readUInt16LE(at + 32);
  }
  assert.deepEqual(files.sort(), Object.keys(expected).sort());
  assert.equal(new Set(encrypted.map((e) => e.salt)).size, count);
  assert.ok(encrypted.some((e) => e.method === 8));
  return encrypted;
}
