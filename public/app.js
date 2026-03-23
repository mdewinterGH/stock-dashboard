/* ── State ──────────────────────────────────────────────────────────────── */
let currentTicker = 'MU';
let currentRange  = '3mo';
let priceChart    = null;
const quarterlyCharts = {};

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const app            = $('app');
const loadingOverlay = $('loadingOverlay');
const errorToast     = $('errorToast');
const tickerInput    = $('tickerInput');
const searchBtn      = $('searchBtn');
const rangeToggle    = $('rangeToggle');

/* ── Bootstrap ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard('MU');

  searchBtn.addEventListener('click', doSearch);
  tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  rangeToggle.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      rangeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      loadPriceChart(currentTicker, currentRange);
    });
  });
});

function doSearch() {
  const v = tickerInput.value.trim().toUpperCase();
  if (!v) return;
  loadDashboard(v);
}

/* ── Main loader ────────────────────────────────────────────────────────── */
async function loadDashboard(ticker) {
  currentTicker = ticker.toUpperCase();
  tickerInput.value = currentTicker;

  showLoading(true);
  app.classList.add('hidden');

  try {
    // Fire all independent requests in parallel
    const [quoteData, metricsData, analystData, newsData, peersData, historyData, financialsData] =
      await Promise.allSettled([
        apiFetch(`/api/quote/${currentTicker}`),
        apiFetch(`/api/metrics/${currentTicker}`),
        apiFetch(`/api/analyst/${currentTicker}`),
        apiFetch(`/api/news/${currentTicker}`),
        apiFetch(`/api/peers/${currentTicker}`),
        apiFetch(`/api/history/${currentTicker}?range=${currentRange}`),
        apiFetch(`/api/financials/${currentTicker}`),
      ]);

    renderHeader(resolve(quoteData));
    renderMetrics(resolve(quoteData), resolve(metricsData), resolve(financialsData));
    renderPriceChart(resolve(historyData));
    renderNews(resolve(newsData));
    renderAnalyst(resolve(analystData));
    renderPeers(resolve(peersData), resolve(quoteData));
    renderQuarterly(resolve(financialsData));

    app.classList.remove('hidden');
    document.title = `${currentTicker} – Stock Dashboard`;
  } catch (err) {
    showError('Failed to load data: ' + err.message);
  } finally {
    showLoading(false);
  }
}

function resolve(settled) {
  return settled.status === 'fulfilled' ? settled.value : null;
}

/* ── API helper ─────────────────────────────────────────────────────────── */
async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/* ── Header ─────────────────────────────────────────────────────────────── */
function renderHeader(data) {
  if (!data) return;
  const { profile, quote } = data;

  $('headerTicker').textContent = currentTicker;
  $('headerName').textContent   = profile?.name || currentTicker;
  $('headerMeta').textContent   =
    [profile?.exchange, profile?.finnhubIndustry, profile?.country]
      .filter(Boolean).join(' · ');

  if (quote) {
    $('headerPrice').textContent = fmt(quote.c, 'currency');
    const dp = quote.dp ?? 0;
    const dd = quote.d  ?? 0;
    const el = $('headerChange');
    el.textContent = `${dd >= 0 ? '+' : ''}${fmt(dd, 'currency')}  (${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%)`;
    el.className = 'change-badge ' + (dp > 0 ? 'up' : dp < 0 ? 'down' : 'flat');
  }
}

/* ── Key Metrics ─────────────────────────────────────────────────────────── */
function renderMetrics(quoteData, metricsData, finData) {
  const m  = metricsData?.metric || {};
  const q  = quoteData?.quote    || {};
  const p  = quoteData?.profile  || {};
  const ov = finData?.overview || {};  // Yahoo Finance financialData/summaryDetail

  // Yahoo Finance returns these as decimal ratios (e.g. 0.34 = 34%)
  const avGrossMargin = ov.GrossMargin       != null ? (ov.GrossMargin       * 100).toFixed(1) + '%' : null;
  const avDivYield    = ov.DividendYield     != null ? (ov.DividendYield     * 100).toFixed(2) + '%' : null;
  const avNetMargin   = ov.ProfitMargin      != null ? (ov.ProfitMargin      * 100).toFixed(1) + '%' : null;
  const avROE         = ov.ReturnOnEquityTTM != null ? (ov.ReturnOnEquityTTM * 100).toFixed(1) + '%' : null;

  const items = [
    { label: 'Market Cap',     value: p.marketCapitalization ? fmtB(p.marketCapitalization * 1e6) : null },
    { label: 'Open',           value: q.o  != null ? fmt(q.o, 'currency') : null },
    { label: '52W High',       value: m['52WeekHigh'] != null ? fmt(m['52WeekHigh'], 'currency') : null },
    { label: '52W Low',        value: m['52WeekLow']  != null ? fmt(m['52WeekLow'],  'currency') : null },
    { label: 'P/E (TTM)',      value: m.peBasicExclExtraTTM != null ? m.peBasicExclExtraTTM.toFixed(1) : null },
    { label: 'P/S (TTM)',      value: m.psTTM      != null ? m.psTTM.toFixed(2)      : null },
    { label: 'P/B',            value: m.pbQuarterly != null ? m.pbQuarterly.toFixed(2) : null },
    { label: 'EPS (TTM)',      value: m.epsTTM     != null ? fmt(m.epsTTM, 'currency') : null },
    // Yahoo Finance-sourced (financialData/summaryDetail); fall back to Finnhub if absent
    { label: 'Div Yield',      value: avDivYield  ?? (m.currentDividendYieldTTM != null ? (m.currentDividendYieldTTM * 100).toFixed(2) + '%' : null) },
    { label: 'Gross Margin',   value: avGrossMargin ?? (m.grossMarginTTM != null ? (m.grossMarginTTM * 100).toFixed(1) + '%' : null) },
    { label: 'Net Margin',     value: avNetMargin ?? (m.netProfitMarginTTM != null ? (m.netProfitMarginTTM * 100).toFixed(1) + '%' : null) },
    { label: 'ROE',            value: avROE       ?? (m.roeTTM != null ? (m.roeTTM * 100).toFixed(1) + '%' : null) },
    { label: 'Beta (5Y)',      value: m.beta != null ? m.beta.toFixed(2) : null },
    { label: 'Avg Vol (3M)',   value: m['3MonthAverageTradingVolume'] != null ? fmtCompact(m['3MonthAverageTradingVolume'] * 1e6) : null },
    { label: 'Float (Shares)', value: m.shareFloat != null ? fmtCompact(m.shareFloat * 1e6) : null },
  ].filter(i => i.value !== null && i.value !== undefined);

  const grid = $('metricsGrid');
  if (!items.length) { grid.innerHTML = '<div class="flat-text">No metrics available.</div>'; return; }
  grid.innerHTML = items.map(i =>
    `<div class="metric-item"><div class="metric-label">${i.label}</div><div class="metric-value">${i.value}</div></div>`
  ).join('');
}

/* ── Price Chart ─────────────────────────────────────────────────────────── */
function renderPriceChart(points) {
  if (!points || !points.length) {
    document.querySelector('.chart-wrap').innerHTML = '<div class="flat-text" style="padding:40px;text-align:center">No price data available.</div>';
    return;
  }
  const labels = points.map(p => p.date);
  const prices = points.map(p => p.close);
  const first  = prices[0];
  const last   = prices[prices.length - 1];
  const isUp   = last >= first;
  const color  = isUp ? '#3fb950' : '#f85149';
  const fillColor = isUp ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)';

  if (priceChart) { priceChart.destroy(); priceChart = null; }

  const ctx = document.getElementById('priceChart').getContext('2d');
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: prices,
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, fillColor);
          g.addColorStop(1, 'transparent');
          return g;
        },
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2330',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: ctx => ` $${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(48,54,61,0.5)', drawTicks: false },
          ticks: {
            color: '#6e7681',
            maxTicksLimit: 8,
            maxRotation: 0,
          },
          border: { color: '#30363d' },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(48,54,61,0.5)', drawTicks: false },
          ticks: {
            color: '#6e7681',
            callback: v => '$' + v.toFixed(0),
          },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

async function loadPriceChart(ticker, range) {
  try {
    const data = await apiFetch(`/api/history/${ticker}?range=${range}`);
    renderPriceChart(data);
  } catch (e) {
    showError('Price history unavailable');
  }
}

/* ── News ────────────────────────────────────────────────────────────────── */
function renderNews(articles) {
  const feed = $('newsFeed');
  if (!articles || !articles.length) {
    feed.innerHTML = '<div class="flat-text">No recent news found.</div>';
    return;
  }
  feed.innerHTML = articles.map(a => {
    const date = a.datetime ? new Date(a.datetime * 1000).toLocaleDateString() : '';
    return `
      <div class="news-item">
        <div class="news-top">
          <div class="news-headline"><a href="${a.url}" target="_blank" rel="noopener">${escHtml(a.headline)}</a></div>
          <span class="sentiment-tag ${a.sentiment}">${a.sentiment}</span>
        </div>
        <div class="news-meta">${escHtml(a.source)} &nbsp;·&nbsp; ${date}</div>
      </div>`;
  }).join('');
}

/* ── Analyst Ratings ─────────────────────────────────────────────────────── */
function renderAnalyst(data) {
  const sec = $('analystSection');
  if (!data) { sec.innerHTML = '<div class="flat-text">No analyst data.</div>'; return; }

  const { recommendations, priceTarget } = data;
  const rec = recommendations?.[0] || null;

  // Price Target
  let ptHtml = '';
  if (priceTarget) {
    const { targetMean, targetHigh, targetLow } = priceTarget;
    ptHtml = `
      <div class="pt-section">
        <div class="pt-label">Consensus Price Target</div>
        <div class="pt-value">${targetMean ? '$' + targetMean.toFixed(2) : '—'}</div>
        ${(targetLow || targetHigh) ? `<div class="pt-range">Low $${(targetLow||0).toFixed(2)} · High $${(targetHigh||0).toFixed(2)}</div>` : ''}
      </div>`;
  }

  // Consensus label
  let consensusHtml = '';
  let totalRatings = 0;
  if (rec) {
    const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = rec;
    totalRatings = strongBuy + buy + hold + sell + strongSell;
    const consensus = deriveConsensus(strongBuy, buy, hold, sell, strongSell);
    consensusHtml = `<div style="text-align:center;margin-bottom:16px">
      <span class="consensus-badge ${consensus}">${consensus}</span>
      <div style="font-size:0.75rem;color:var(--text3);margin-top:4px">${totalRatings} analyst${totalRatings !== 1 ? 's' : ''}</div>
    </div>`;

    if (totalRatings) {
      const bars = [
        { label: 'Strong Buy', count: strongBuy, cls: 'bar-strong-buy' },
        { label: 'Buy',        count: buy,        cls: 'bar-buy' },
        { label: 'Hold',       count: hold,       cls: 'bar-hold' },
        { label: 'Sell',       count: sell,       cls: 'bar-sell' },
        { label: 'Strong Sell',count: strongSell, cls: 'bar-strong-sell' },
      ];
      consensusHtml += bars.map(b => `
        <div class="rating-bar-wrap">
          <div class="rating-bar-label"><span>${b.label}</span><span>${b.count}</span></div>
          <div class="rating-bar-track">
            <div class="rating-bar-fill ${b.cls}" style="width:${totalRatings ? (b.count/totalRatings*100).toFixed(1) : 0}%"></div>
          </div>
        </div>`).join('');
    }
  }

  sec.innerHTML = ptHtml + (consensusHtml || '<div class="flat-text">No ratings available.</div>');
}

function deriveConsensus(sb, b, h, s, ss) {
  const total = sb + b + h + s + ss;
  if (!total) return 'Hold';
  const score = (sb * 5 + b * 4 + h * 3 + s * 2 + ss * 1) / total;
  if (score >= 4.5) return 'Strong Buy';
  if (score >= 3.7) return 'Buy';
  if (score >= 2.7) return 'Hold';
  if (score >= 1.8) return 'Sell';
  return 'Strong Sell';
}

/* ── Peers ────────────────────────────────────────────────────────────────── */
function renderPeers(peers, quoteData) {
  const wrap = $('peersTable');
  const myQuote   = quoteData?.quote || {};
  const myProfile = quoteData?.profile || {};

  if (!peers || !peers.length) {
    wrap.innerHTML = '<div class="flat-text">No peer data available.</div>';
    return;
  }

  // Prepend current ticker row
  const allRows = [
    {
      symbol: currentTicker,
      name: myProfile.name || currentTicker,
      price: myQuote.c || null,
      change: myQuote.dp || null,
      marketCap: myProfile.marketCapitalization ? myProfile.marketCapitalization * 1e6 : null,
      isCurrent: true,
    },
    ...peers.map(p => ({
      ...p,
      marketCap: p.marketCap ? p.marketCap * 1e6 : null,
      isCurrent: false,
    })),
  ];

  wrap.innerHTML = `
    <table class="peers-table">
      <thead>
        <tr>
          <th>Ticker</th><th>Company</th><th>Price</th><th>Change</th><th>Market Cap</th>
        </tr>
      </thead>
      <tbody>
        ${allRows.map(r => {
          const chgClass = r.change > 0 ? 'up-text' : r.change < 0 ? 'down-text' : 'flat-text';
          const chgStr   = r.change != null ? `${r.change >= 0 ? '+' : ''}${r.change.toFixed(2)}%` : '—';
          return `
            <tr style="${r.isCurrent ? 'background:var(--bg3);' : ''}">
              <td class="ticker-col" style="${r.isCurrent ? 'color:var(--accent)' : ''}">${r.symbol}</td>
              <td>${escHtml(r.name)}</td>
              <td>${r.price != null ? '$' + r.price.toFixed(2) : '—'}</td>
              <td class="${chgClass}">${chgStr}</td>
              <td>${r.marketCap != null ? fmtB(r.marketCap) : '—'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

/* ── Quarterly Bar Charts ─────────────────────────────────────────────────── */
function renderQuarterly(fin) {
  const grid = $('quarterlyGrid');

  // Destroy old chart instances
  Object.values(quarterlyCharts).forEach(c => c.destroy());
  Object.keys(quarterlyCharts).forEach(k => delete quarterlyCharts[k]);

  if (!fin || !fin.quarters || !fin.quarters.length) {
    grid.innerHTML = '<div class="flat-text">No quarterly financial data available.</div>';
    return;
  }

  const quarters = fin.quarters;
  const labels   = quarters.map(q => fmtQuarter(q.quarter));

  const charts = [
    { key: 'revenue',         label: 'Revenue',              color: '#58a6ff', unit: '$B', divisor: 1e9 },
    { key: 'netIncome',       label: 'Net Income',           color: '#3fb950', unit: '$B', divisor: 1e9, negColor: '#f85149' },
    { key: 'eps',             label: 'EPS',                  color: '#d2a8ff', unit: '$',  divisor: 1 },
    { key: 'operatingCashFlow', label: 'Operating Cash Flow',color: '#79c0ff', unit: '$B', divisor: 1e9, negColor: '#f85149' },
    { key: 'freeCashFlow',    label: 'Free Cash Flow',       color: '#56d364', unit: '$B', divisor: 1e9, negColor: '#f85149' },
  ];

  // PE and P/S from overview (single value repeated across quarters as reference line)
  // We'll use metric values from the financials overview if available
  const overviewCharts = [
    { key: 'peRatioTTM', label: 'P/E Ratio (TTM)',  color: '#f0883e', single: true },
    { key: 'psTTM',      label: 'Price/Sales (TTM)', color: '#bc8cff', single: true },
  ];

  grid.innerHTML = [
    ...charts.map(c => `<div class="q-chart-box"><div class="q-chart-title">${c.label}</div><div class="q-chart-wrap"><canvas id="qc-${c.key}"></canvas></div></div>`),
    ...overviewCharts.map(c => `<div class="q-chart-box"><div class="q-chart-title">${c.label}</div><div class="q-chart-wrap"><canvas id="qc-${c.key}"></canvas></div></div>`),
  ].join('');

  // Draw bar charts for quarterly series
  charts.forEach(cfg => {
    const raw    = quarters.map(q => q[cfg.key]);
    const values = raw.map(v => v != null ? v / cfg.divisor : null);
    const colors = values.map(v => {
      if (v === null) return cfg.color;
      if (cfg.negColor && v < 0) return cfg.negColor;
      return cfg.color;
    });

    const ctx = document.getElementById(`qc-${cfg.key}`).getContext('2d');
    quarterlyCharts[cfg.key] = new Chart(ctx, makeBarChart(labels, values, colors, cfg.unit, cfg.divisor));
  });

  // Draw overview metric charts
  overviewCharts.forEach(cfg => {
    const val = fin[cfg.key];
    const values = val != null ? quarters.map(() => val) : quarters.map(() => null);
    const ctx = document.getElementById(`qc-${cfg.key}`).getContext('2d');
    quarterlyCharts[cfg.key] = new Chart(ctx, makeBarChart(labels, values, Array(labels.length).fill(cfg.color), '', 1));
  });
}

function makeBarChart(labels, data, colors, unit, divisor) {
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2330',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return '—';
              if (unit === '$B') return ` ${v >= 0 ? '' : '-'}$${Math.abs(v).toFixed(2)}B`;
              if (unit === '$')  return ` $${v.toFixed(2)}`;
              return ` ${v.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6e7681', font: { size: 10 }, maxRotation: 45 },
          border: { color: '#30363d' },
        },
        y: {
          grid: { color: 'rgba(48,54,61,0.5)', drawTicks: false },
          ticks: {
            color: '#6e7681',
            font: { size: 10 },
            callback: v => {
              if (unit === '$B') return `$${v.toFixed(1)}B`;
              if (unit === '$')  return `$${v.toFixed(2)}`;
              return v.toFixed(1);
            },
          },
          border: { color: '#30363d' },
        },
      },
    },
  };
}

/* ── Utilities ───────────────────────────────────────────────────────────── */
function fmt(v, type) {
  if (v == null) return '—';
  if (type === 'currency') return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v;
}

function fmtB(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (Math.abs(v) >= 1e9)  return '$' + (v / 1e9).toFixed(2)  + 'B';
  if (Math.abs(v) >= 1e6)  return '$' + (v / 1e6).toFixed(2)  + 'M';
  return '$' + v.toLocaleString();
}

function fmtCompact(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toLocaleString();
}

function fmtQuarter(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q}'${String(d.getFullYear()).slice(2)}`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showLoading(v) {
  loadingOverlay.classList.toggle('hidden', !v);
}

function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove('hidden');
  setTimeout(() => errorToast.classList.add('hidden'), 4000);
}
