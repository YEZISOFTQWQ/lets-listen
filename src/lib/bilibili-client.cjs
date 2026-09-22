'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  Operation,
  encodePacket,
  parsePacketStream,
  parseJsonBody,
} = require('./bili-protocol.cjs');

const DEFAULT_API_BASE = 'https://live-open.biliapi.com';
const HEARTBEAT_INTERVAL_MS = 20_000;

function signRequest(body, accessKey, accessSecret, options = {}) {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = String(options.nonce ?? crypto.randomUUID());
  const contentMd5 = crypto.createHash('md5').update(body, 'utf8').digest('hex');
  const biliHeaders = {
    'x-bili-accesskeyid': accessKey,
    'x-bili-content-md5': contentMd5,
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': nonce,
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': timestamp,
  };

  const canonical = Object.keys(biliHeaders)
    .sort()
    .map((key) => `${key}:${biliHeaders[key]}`)
    .join('\n');

  const authorization = crypto
    .createHmac('sha256', accessSecret)
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    ...biliHeaders,
    Authorization: authorization,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function createStartBody(identityCode, appId) {
  const cleanAppId = String(appId).trim();
  if (!/^\d+$/.test(cleanAppId)) throw new Error('app_id 必须是纯数字');
  return `{"code":${JSON.stringify(String(identityCode).trim())},"app_id":${cleanAppId}}`;
}

function createEndBody(gameId, appId) {
  const cleanAppId = String(appId).trim();
  if (!/^\d+$/.test(cleanAppId)) throw new Error('app_id 必须是纯数字');
  return `{"game_id":${JSON.stringify(gameId)},"app_id":${cleanAppId}}`;
}

class BilibiliLiveClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      apiBase: DEFAULT_API_BASE,
      ...config,
    };
    this.gameId = '';
    this.websocketInfo = null;
    this.anchorInfo = null;
    this.socket = null;
    this.socketHeartbeat = null;
    this.appHeartbeat = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
  }

  async request(path, body) {
    const headers = signRequest(
      body,
      this.config.accessKey,
      this.config.accessSecret,
    );
    const response = await fetch(`${this.config.apiBase}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`B站接口返回了非 JSON 内容（HTTP ${response.status}）`);
    }
    if (payload.code !== 0) {
      const error = new Error(`B站接口错误 ${payload.code}: ${payload.message || '未知错误'}`);
      error.code = payload.code;
      error.payload = payload;
      throw error;
    }
    return payload.data;
  }

  async start(identityCode) {
    if (!identityCode || !String(identityCode).trim()) throw new Error('请输入主播身份码');
    if (!this.config.accessKey || !this.config.accessSecret || !this.config.appId) {
      throw new Error('请先填写并保存 app_id、access_key 和 access_secret');
    }

    this.closedByUser = false;
    this.emitState('starting', '正在启动互动场次…');
    const data = await this.request(
      '/v2/app/start',
      createStartBody(identityCode, this.config.appId),
    );
    this.gameId = data.game_info?.game_id || '';
    this.websocketInfo = data.websocket_info;
    this.anchorInfo = data.anchor_info || null;
    if (!this.gameId || !this.websocketInfo?.auth_body || !this.websocketInfo?.wss_link?.length) {
      throw new Error('B站启动接口缺少 game_id 或 WebSocket 信息');
    }
    await this.connectSocket();
    this.startAppHeartbeat();
    return {
      gameId: this.gameId,
      anchorInfo: this.anchorInfo,
    };
  }

  async connectSocket() {
    const links = this.websocketInfo.wss_link;
    let lastError;
    for (let index = 0; index < links.length; index += 1) {
      try {
        await this.openSocket(links[index]);
        this.reconnectAttempt = 0;
        return;
      } catch (error) {
        lastError = error;
        this.emit('diagnostic', {
          level: 'warn',
          message: `长连接节点 ${index + 1} 连接失败：${error.message}`,
        });
      }
    }
    throw lastError || new Error('没有可用的 B站 WebSocket 节点');
  }

  openSocket(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('WebSocket 连接超时'));
      }, 12_000);

      socket.addEventListener('open', () => {
        this.socket = socket;
        socket.send(encodePacket(Operation.AUTH, this.websocketInfo.auth_body));
      });

      socket.addEventListener('message', (event) => {
        try {
          const packets = parsePacketStream(Buffer.from(event.data));
          for (const packet of packets) {
            if (packet.operation === Operation.AUTH_REPLY) {
              const authResult = parseJsonBody(packet) || {};
              if (authResult.code !== 0) {
                throw new Error(`长连接鉴权失败：${authResult.code}`);
              }
              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                this.startSocketHeartbeat();
                this.emitState('connected', '已连接官方弹幕长链');
                resolve();
              }
            } else if (packet.operation === Operation.MESSAGE) {
              const message = parseJsonBody(packet);
              if (message) {
                this.emit('message', message);
                if (message.cmd === 'LIVE_OPEN_PLATFORM_INTERACTION_END') {
                  this.emitState('ended', 'B站已结束本场消息推送');
                }
              }
            } else if (packet.operation === Operation.HEARTBEAT_REPLY) {
              this.emit('heartbeat', { type: 'websocket', at: Date.now() });
            }
          }
        } catch (error) {
          this.emit('diagnostic', { level: 'error', message: `弹幕包解析失败：${error.message}` });
        }
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('WebSocket 网络错误'));
        }
      });

      socket.addEventListener('close', (event) => {
        clearTimeout(timeout);
        this.stopSocketHeartbeat();
        if (this.socket === socket) this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket 提前关闭（${event.code}）`));
          return;
        }
        if (!this.closedByUser && this.gameId) {
          this.emitState('reconnecting', '弹幕长链断开，正在重连…');
          this.scheduleReconnect();
        }
      });
    });
  }

  startSocketHeartbeat() {
    this.stopSocketHeartbeat();
    this.socketHeartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(encodePacket(Operation.HEARTBEAT));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopSocketHeartbeat() {
    if (this.socketHeartbeat) clearInterval(this.socketHeartbeat);
    this.socketHeartbeat = null;
  }

  startAppHeartbeat() {
    this.stopAppHeartbeat();
    this.appHeartbeat = setInterval(async () => {
      if (!this.gameId) return;
      try {
        const body = JSON.stringify({ game_id: this.gameId });
        await this.request('/v2/app/heartbeat', body);
        this.emit('heartbeat', { type: 'application', at: Date.now() });
      } catch (error) {
        this.emit('diagnostic', { level: 'error', message: `项目心跳失败：${error.message}` });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopAppHeartbeat() {
    if (this.appHeartbeat) clearInterval(this.appHeartbeat);
    this.appHeartbeat = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectSocket();
      } catch (error) {
        this.emit('diagnostic', { level: 'error', message: `重连失败：${error.message}` });
        this.scheduleReconnect();
      }
    }, delay);
  }

  async stop() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopSocketHeartbeat();
    this.stopAppHeartbeat();
    if (this.socket) {
      this.socket.close(1000, 'client stop');
      this.socket = null;
    }

    const gameId = this.gameId;
    this.gameId = '';
    if (gameId) {
      try {
        await this.request('/v2/app/end', createEndBody(gameId, this.config.appId));
      } finally {
        this.emitState('disconnected', '互动场次已关闭');
      }
    } else {
      this.emitState('disconnected', '未连接');
    }
  }

  emitState(status, message) {
    this.emit('state', {
      status,
      message,
      gameId: this.gameId || null,
      anchorInfo: this.anchorInfo,
    });
  }
}

module.exports = {
  BilibiliLiveClient,
  DEFAULT_API_BASE,
  HEARTBEAT_INTERVAL_MS,
  signRequest,
  createStartBody,
  createEndBody,
};

