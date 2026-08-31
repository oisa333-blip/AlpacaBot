const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";

app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory cache so a page full of clients doesn't burn through the
// free-tier Alpha Vantage rate limit (5 req/min, 25/day) on every refresh.
const CACHE_TTL_MS = 30_000;
const cache = new Map();

async function cached(key, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await fetcher();
  cache.set(key, { data, at: Date.now() });
  return data;
}

async function fetchEquityQuote(symbol) {
  if (!ALPHA_VANTAGE_KEY) {
    return { symbol, error: "ALPHA_VANTAGE_API_KEY not configured" };
  }
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${ALPHA_VANTAGE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return { symbol, error: `upstream HTTP ${res.status}` };
  const body = await res.json();
  const quote = body["Global Quote"];
  if (!quote || !quote["05. price"]) {
    return { symbol, error: body.Note || body.Information || "no data returned" };
  }
  return {
    symbol,
    price: Number(quote["05. price"]),
    change: Number(quote["09. change"]),
    changePercent: Number((quote["10. change percent"] || "0").replace("%", "")),
    open: Number(quote["02. open"]),
    high: Number(quote["03. high"]),
    low: Number(quote["04. low"]),
    previousClose: Number(quote["08. previous close"]),
    volume: Number(quote["06. volume"]),
    asOf: quote["07. latest trading day"],
  };
}

async function fetchBtcQuote() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true";
  const res = await fetch(url);
  if (!res.ok) return { symbol: "BTC/USD", error: `upstream HTTP ${res.status}` };
  const body = await res.json();
  const btc = body.bitcoin;
  if (!btc) return { symbol: "BTC/USD", error: "no data returned" };
  return {
    symbol: "BTC/USD",
    price: btc.usd,
    changePercent: btc.usd_24h_change,
    volume: btc.usd_24h_vol,
    asOf: new Date().toISOString(),
  };
}

app.get("/api/quotes", async (req, res) => {
  const symbolsParam = (req.query.symbols || "QQQ,SPY,BTC").toUpperCase();
  const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    const results = await Promise.all(
      symbols.map((symbol) =>
        symbol === "BTC"
          ? cached("BTC", fetchBtcQuote)
          : cached(symbol, () => fetchEquityQuote(symbol))
      )
    );
    res.json({ quotes: results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Trader's View running at http://localhost:${PORT}`);
  if (!ALPHA_VANTAGE_KEY) {
    console.warn("ALPHA_VANTAGE_API_KEY is not set — QQQ/SPY quotes will show as unavailable. Get a free key at https://www.alphavantage.co/support/#api-key");
  }
});
