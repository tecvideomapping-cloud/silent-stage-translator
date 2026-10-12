const Redis = require('ioredis');
const EventEmitter = require('events');

class PubSubManager extends EventEmitter {
  constructor() {
    super();
    this.isRedis = false;
    this.pub = null;
    this.sub = null;
  }

  init() {
    if (!process.env.REDIS_URL) {
      console.log('[REDIS] REDIS_URL não configurada. Operando com Pub/Sub em memória.');
      return;
    }

    try {
      this.pub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
      this.sub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });

      this.pub.on('connect', () => {
        console.log('[REDIS] Publicador conectado ao Redis.');
        this.isRedis = true;
      });

      this.sub.on('connect', () => {
        console.log('[REDIS] Assinante conectado ao Redis.');
      });

      this.pub.on('error', (err) => {
        console.warn('[REDIS] Erro no Redis Pub:', err.message);
      });

      this.sub.on('error', (err) => {
        console.warn('[REDIS] Erro no Redis Sub:', err.message);
      });

      this.sub.on('messageBuffer', (channel, message) => {
        this.emit(channel.toString(), message);
      });
      this.sub.on('message', (channel, message) => {
        this.emit(channel, message);
      });
    } catch (err) {
      console.warn('[REDIS] Falha ao iniciar Redis, usando fallback local:', err.message);
      this.isRedis = false;
    }
  }

  async subscribeChannel(channel) {
    if (this.isRedis && this.sub) {
      try {
        await this.sub.subscribe(channel);
      } catch (e) {
        console.error(`[REDIS] Erro ao assinar canal ${channel}:`, e.message);
      }
    }
  }

  async publishMessage(channel, data) {
    if (this.isRedis && this.pub) {
      try {
        await this.pub.publish(channel, typeof data === 'string' ? data : JSON.stringify(data));
      } catch (e) {
        console.error(`[REDIS] Erro ao publicar em ${channel}:`, e.message);
      }
    } else {
      this.emit(channel, typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  async publishBinary(channel, buffer) {
    if (this.isRedis && this.pub) {
      try {
        await this.pub.publishBuffer(channel, buffer);
      } catch (e) {
        console.error(`[REDIS] Erro ao publicar buffer em ${channel}:`, e.message);
      }
    } else {
      this.emit(channel, buffer);
    }
  }
}

const pubSub = new PubSubManager();

module.exports = {
  pubSub
};
