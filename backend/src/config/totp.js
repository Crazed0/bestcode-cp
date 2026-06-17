const crypto = require('crypto');

/**
 * Decodifica uma string Base32 para um Buffer
 */
function decodeBase32(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bin = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i].toUpperCase();
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    bin += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i < bin.length; i += 8) {
    if (i + 8 <= bin.length) {
      bytes.push(parseInt(bin.substring(i, i + 8), 2));
    }
  }
  return Buffer.from(bytes);
}

/**
 * Gera um código HOTP (baseado em contador) de acordo com a RFC 4226
 */
function generateHOTP(secretBuffer, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(buffer);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code = ((hmacResult[offset] & 0x7f) << 24) |
               ((hmacResult[offset + 1] & 0xff) << 16) |
               ((hmacResult[offset + 2] & 0xff) << 8) |
               (hmacResult[offset + 3] & 0xff);

  const otp = code % 1000000;
  return otp.toString().padStart(6, '0');
}

/**
 * Gera um segredo Base32 aleatório (16 caracteres) para o Google Authenticator
 */
function generateSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < 16; i++) {
    secret += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return secret;
}

/**
 * Valida um código TOTP de 6 dígitos com tolerância de clock drift (-1, 0, +1)
 */
function verifyTOTP(token, secret) {
  try {
    const secretBuffer = decodeBase32(secret);
    const counter = Math.floor(Date.now() / 30000);

    for (let i = -1; i <= 1; i++) {
      const code = generateHOTP(secretBuffer, counter + i);
      if (code === token) {
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

module.exports = {
  generateSecret,
  verifyTOTP
};
