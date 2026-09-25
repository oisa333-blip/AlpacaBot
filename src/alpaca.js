'use strict';

const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL = 'https://api.alpaca.markets';

class AlpacaError extends Error {
  constructor(status, message, body) {
    super(`Alpaca ${status}: ${message}`);
    this.name = 'AlpacaError';
    this.status = status;
    this.body = body;
  }
}

// Minimal Alpaca Trading API client (REST v2) built on fetch.
function createAlpacaClient({ keyId, secretKey, paper = true, fetchImpl = fetch }) {
  const baseUrl = paper ? PAPER_URL : LIVE_URL;

  async function request(method, path, body) {
    const headers = {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secretKey,
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetchImpl(baseUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const message = (data && data.message) || text || res.statusText;
      throw new AlpacaError(res.status, message, data);
    }
    return data;
  }

  return {
    baseUrl,
    paper,
    getAccount: () => request('GET', '/v2/account'),
    getClock: () => request('GET', '/v2/clock'),
    getPositions: () => request('GET', '/v2/positions'),
    async getPosition(symbol) {
      try {
        return await request('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    closePosition: (symbol) => request('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`),
    submitOrder: (order) => request('POST', '/v2/orders', order),
    getOrder: (id) => request('GET', `/v2/orders/${encodeURIComponent(id)}`),
  };
}

module.exports = { createAlpacaClient, AlpacaError, PAPER_URL, LIVE_URL };
