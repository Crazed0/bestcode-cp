const redis = require('redis');

let redisClient = {
  isReady: false,
  // Fallback in-memory cache if Redis is offline
  _memoryCache: new Map(),

  async get(key) {
    if (this.isReady) {
      try {
        return await this.client.get(key);
      } catch (err) {
        console.error(`[REDIS] Erro ao obter chave ${key}:`, err.message);
      }
    }
    return this._memoryCache.get(key) || null;
  },

  async setEx(key, seconds, value) {
    if (this.isReady) {
      try {
        await this.client.setEx(key, seconds, value);
        return;
      } catch (err) {
        console.error(`[REDIS] Erro ao definir chave ${key}:`, err.message);
      }
    }
    this._memoryCache.set(key, value);
    // Auto-clean local memory cache after seconds
    setTimeout(() => {
      this._memoryCache.delete(key);
    }, seconds * 1000);
  },

  async del(key) {
    if (this.isReady) {
      try {
        await this.client.del(key);
        return;
      } catch (err) {
        console.error(`[REDIS] Erro ao deletar chave ${key}:`, err.message);
      }
    }
    this._memoryCache.delete(key);
  }
};

// Estabelece a ligação com o Redis
const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});

client.on('connect', () => {
  console.log('[REDIS] Conectando ao servidor Redis...');
});

client.on('ready', () => {
  console.log('[REDIS] Cliente pronto e conectado com sucesso.');
  redisClient.isReady = true;
});

client.on('error', (err) => {
  console.warn('[REDIS] Erro ou Servidor Offline. Ativando fallback em memória local.', err.message);
  redisClient.isReady = false;
});

client.on('end', () => {
  console.log('[REDIS] Conexão encerrada.');
  redisClient.isReady = false;
});

// Inicia conexão assíncrona sem travar o boot
client.connect().catch((err) => {
  console.warn('[REDIS] Não foi possível conectar ao Redis. Modo de fallback em memória local ativado.');
});

redisClient.client = client;

module.exports = redisClient;
