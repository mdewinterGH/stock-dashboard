require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Helper ──────────────────────────────────────────────────────────────────
function finnhubGet(path, params = {}) {
  return axios.get(`https://finnhub.io/api/v1${path}`, {
    params: { ...params, token: FINNHUB_KEY },
    timeout: 8000,
  });
}

function alphaGet(params = {}) {
  return axios.get('https://www.alphavantage.co/query', {
    params: { ...params, apikey: ALPHAVANTAGE_KEY },
    timeout: 10000,
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Company profile + quote
app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [profileRes, quoteRes] = await Promise.allSettled([
      finnhubGet('/stock/profile2', { symbol }),
      finnhubGet('/quote', { symbol }),
    ]);
    res.json({
      profile: profileRes.status === 'fulfilled' ? profileRes.value.data : {},
      quote:   quoteRes.status   === 'fulfilled' ? quoteRes.value.data   : {},
    });
  } catch (err) {
    res.json({ profile: {}, quote: {} });
  }
});

// Finnhub basic financials (metrics)
app.get('/api/metrics/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const r = await finnhubGet('/stock/metric', { symbol, metric: 'all' });
    res.json(r.data);
  } catch (err) {
    res.json({ metric: {} });
  }
});

// Analyst recommendations (price-target endpoint requires a paid Finnhub plan)
app.get('/api/analyst/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const recRes = await finnhubGet('/stock/recommendation', { symbol });
    res.json({ recommendations: recRes.data || [], priceTarget: null });
  } catch (err) {
    res.json({ recommendations: [], priceTarget: null });
  }
});

// News + basic sentiment
app.get('/api/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const to   = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const r = await finnhubGet('/company-news', { symbol, from, to });
    const articles = (r.data || []).slice(0, 12).map(a => ({
      headline: a.headline,
      summary:  a.summary,
      url:      a.url,
      source:   a.source,
      datetime: a.datetime,
      sentiment: scoreSentiment(a.headline + ' ' + (a.summary || '')),
    }));
    res.json(articles);
  } catch (err) {
    res.json([]);
  }
});

// Peers / competitors
app.get('/api/peers/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const peersRes = await finnhubGet('/stock/peers', { symbol });
    const peers = (peersRes.data || []).filter(p => p !== symbol).slice(0, 5);
    const quotePromises = peers.map(p =>
      finnhubGet('/quote', { symbol: p }).then(r => ({ symbol: p, quote: r.data })).catch(() => null)
    );
    const profilePromises = peers.map(p =>
      finnhubGet('/stock/profile2', { symbol: p }).then(r => ({ symbol: p, profile: r.data })).catch(() => null)
    );
    const [quotes, profiles] = await Promise.all([
      Promise.all(quotePromises),
      Promise.all(profilePromises),
    ]);
    const result = peers.map(p => {
      const q  = quotes.find(x => x && x.symbol === p);
      const pr = profiles.find(x => x && x.symbol === p);
      return {
        symbol:    p,
        name:      pr?.profile?.name || p,
        price:     q?.quote?.c  || null,
        change:    q?.quote?.dp || null,
        marketCap: pr?.profile?.marketCapitalization || null,
      };
    });
    res.json(result);
  } catch (err) {
    res.json([]);
  }
});

// Yahoo Finance price history proxy
app.get('/api/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const range = req.query.range || '3mo';
  const intervalMap = { '3mo': '1d', '6mo': '1d', '1y': '1wk' };
  const interval = intervalMap[range] || '1d';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const r = await axios.get(url, {
      params: { range, interval, includePrePost: false },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });
    const result = r.data?.chart?.result?.[0];
    if (!result) return res.json([]);
    const timestamps = result.timestamps || result.timestamp || [];
    const closes  = result.indicators?.quote?.[0]?.close  || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];
    const points = timestamps.map((t, i) => ({
      date:   new Date(t * 1000).toISOString().split('T')[0],
      close:  closes[i]  != null ? parseFloat(closes[i].toFixed(2)) : null,
      volume: volumes[i] || null,
    })).filter(p => p.close !== null);
    res.json(points);
  } catch (err) {
    res.json([]);
  }
});

// Alpha Vantage – quarterly income statement + EPS + cash flow + overview
app.get('/api/financials/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // Use allSettled so a single AV rate-limit or error doesn't kill the whole response
    const [incomeRes, earningsRes, cashflowRes, overviewRes] = await Promise.allSettled([
      alphaGet({ function: 'INCOME_STATEMENT', symbol }),
      alphaGet({ function: 'EARNINGS',         symbol }),
      alphaGet({ function: 'CASH_FLOW',        symbol }),
      alphaGet({ function: 'OVERVIEW',         symbol }),
    ]);

    const income   = incomeRes.status   === 'fulfilled' ? (incomeRes.value.data?.quarterlyReports?.slice(0, 8).reverse()   || []) : [];
    const earnings = earningsRes.status === 'fulfilled' ? (earningsRes.value.data?.quarterlyEarnings?.slice(0, 8).reverse() || []) : [];
    const cashflow = cashflowRes.status === 'fulfilled' ? (cashflowRes.value.data?.quarterlyReports?.slice(0, 8).reverse()  || []) : [];
    const overview = overviewRes.status === 'fulfilled' ? (overviewRes.value.data || {}) : {};

    const quarters = income.map((q, i) => {
      const cf   = cashflow[i] || {};
      const eps  = earnings.find(e => e.fiscalDateEnding === q.fiscalDateEnding) || earnings[i] || {};
      const ocf  = parseNum(cf.operatingCashflow);
      const capex = parseNum(cf.capitalExpenditures);
      return {
        quarter:          q.fiscalDateEnding,
        revenue:          parseNum(q.totalRevenue),
        netIncome:        parseNum(q.netIncome),
        eps:              parseFloat(eps.reportedEPS) || null,
        operatingCashFlow: ocf,
        freeCashFlow:     ocf !== null && capex !== null ? ocf - Math.abs(capex) : null,
      };
    });

    res.json({
      quarters,
      peRatioTTM: parseFloat(overview.PERatio)               || null,
      psTTM:      parseFloat(overview.PriceToSalesRatioTTM)  || null,
      pbTTM:      parseFloat(overview.PriceToBookRatio)       || null,
      eps:        parseFloat(overview.EPS)                    || null,
      // Fields used by the metrics panel — avNum strips AV's "None"/"N/A" strings
      overview: {
        DividendYield:     avNum(overview.DividendYield),
        ProfitMargin:      avNum(overview.ProfitMargin),
        GrossProfitTTM:    avNum(overview.GrossProfitTTM),
        RevenueTTM:        avNum(overview.RevenueTTM),
        ReturnOnEquityTTM: avNum(overview.ReturnOnEquityTTM),
      },
    });
  } catch (err) {
    res.json({ quarters: [], peRatioTTM: null, psTTM: null, pbTTM: null, eps: null, overview: {} });
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Alpha Vantage returns "None" / "N/A" for missing fields — normalize to null
function avNum(v) {
  if (v == null || v === 'None' || v === 'N/A' || v === '-') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

const POS_WORDS = ['beat', 'surge', 'soar', 'gain', 'rise', 'jump', 'strong', 'profit', 'growth',
  'record', 'rally', 'upgrade', 'outperform', 'buy', 'positive', 'exceed', 'boost'];
const NEG_WORDS = ['miss', 'drop', 'fall', 'decline', 'loss', 'weak', 'cut', 'downgrade',
  'sell', 'negative', 'warn', 'plunge', 'slump', 'risk', 'concern', 'layoff'];

function scoreSentiment(text) {
  const t = text.toLowerCase();
  let score = 0;
  POS_WORDS.forEach(w => { if (t.includes(w)) score++; });
  NEG_WORDS.forEach(w => { if (t.includes(w)) score--; });
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

app.listen(PORT, () => console.log(`Stock dashboard running at http://localhost:${PORT}`));
