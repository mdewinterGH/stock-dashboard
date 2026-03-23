require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const FINNHUB_KEY = process.env.FINNHUB_KEY;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Helper ──────────────────────────────────────────────────────────────────
function finnhubGet(path, params = {}) {
  return axios.get(`https://finnhub.io/api/v1${path}`, {
    params: { ...params, token: FINNHUB_KEY },
    timeout: 8000,
  });
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

function yahooSummary(symbol, modules) {
  return axios.get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}`, {
    params: { modules: modules.join(',') },
    headers: YAHOO_HEADERS,
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

// Yahoo Finance – quarterly financials + metrics overview (single request)
app.get('/api/financials/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const r = await yahooSummary(symbol, [
      'incomeStatementHistoryQuarterly',
      'cashflowStatementHistoryQuarterly',
      'earningsHistory',
      'financialData',
      'summaryDetail',
      'defaultKeyStatistics',
    ]);

    const data = r.data?.quoteSummary?.result?.[0];
    if (!data) return res.json({ quarters: [], peRatioTTM: null, psTTM: null, pbTTM: null, eps: null, overview: {} });

    const incomeList  = data.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const cashList    = data.cashflowStatementHistoryQuarterly?.cashflowStatements   || [];
    const epsList     = data.earningsHistory?.history || [];
    const fd          = data.financialData        || {};
    const sd          = data.summaryDetail        || {};
    const ks          = data.defaultKeyStatistics || {};

    // Yahoo returns newest-first; reverse so charts render oldest→newest
    const income   = incomeList.slice(0, 8).reverse();
    const cashflow = cashList.slice(0, 8).reverse();

    const quarters = income.map((q, i) => {
      const cf      = cashflow[i] || {};
      const endTs   = q.endDate?.raw;
      // Match EPS entry by quarter timestamp (within 45-day window), fall back to index
      const epsEntry = epsList.find(e => Math.abs((e.quarter?.raw || 0) - endTs) < 45 * 86400)
                    || epsList[income.length - 1 - i]
                    || {};
      const ocf   = yNum(cf.totalCashFromOperatingActivities);
      const capex = yNum(cf.capitalExpenditures); // negative in Yahoo Finance
      return {
        quarter:           q.endDate?.fmt || null,
        revenue:           yNum(q.totalRevenue),
        netIncome:         yNum(q.netIncome),
        eps:               yNum(epsEntry.epsActual),
        operatingCashFlow: ocf,
        freeCashFlow:      ocf !== null && capex !== null ? ocf + capex : null,
      };
    });

    res.json({
      quarters,
      peRatioTTM: yNum(sd.trailingPE)  ?? yNum(ks.trailingPE),
      psTTM:      yNum(sd.priceToSalesTrailing12Months),
      pbTTM:      yNum(ks.priceToBook),
      eps:        yNum(ks.trailingEps),
      overview: {
        DividendYield:     yNum(sd.dividendYield),
        GrossMargin:       yNum(fd.grossMargins),
        ProfitMargin:      yNum(fd.profitMargins),
        ReturnOnEquityTTM: yNum(fd.returnOnEquity),
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

// Unwrap Yahoo Finance { raw, fmt } objects or pass plain numbers through
function yNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  if (typeof v === 'object' && v.raw != null) return isNaN(v.raw) ? null : v.raw;
  return null;
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
