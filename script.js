const presetTicker = document.getElementById("presetTicker");
const manualTicker = document.getElementById("manualTicker");
const refreshButton = document.getElementById("refreshButton");
const copyTextButton = document.getElementById("copyTextButton");
const copySummaryButton = document.getElementById("copySummaryButton");
const fetchStatus = document.getElementById("fetchStatus");
const copyStatus = document.getElementById("copyStatus");
const reportRoot = document.getElementById("reportRoot");
const reportTemplate = document.getElementById("reportTemplate");
const tradeDirection = document.getElementById("tradeDirection");
const entryPrice = document.getElementById("entryPrice");
const stopLossPrice = document.getElementById("stopLossPrice");
const preferredRr = document.getElementById("preferredRr");
const maxHoldingPeriod = document.getElementById("maxHoldingPeriod");
const positionRisk = document.getElementById("positionRisk");

const money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percent1 = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

let currentPayload = null;
let copyResetTimer = null;

const safeUpperTicker = (value) => (value || "").trim().toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 12);

const formatMoney = (value) => (Number.isFinite(value) ? money0.format(value) : "Data unavailable");
const formatMoneyShort = (value) => {
  if (!Number.isFinite(value)) return "Data unavailable";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${value < 0 ? "-" : ""}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${value < 0 ? "-" : ""}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${value < 0 ? "-" : ""}$${(abs / 1e6).toFixed(1)}M`;
  return money0.format(value);
};
const formatPrice = (value) => (Number.isFinite(value) ? money2.format(value) : "Data unavailable");
const formatNumber = (value) => (Number.isFinite(value) ? number0.format(value) : "Data unavailable");
const formatPercent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : "Data unavailable");
const formatRatio = (value) => (Number.isFinite(value) ? value.toFixed(2) : "Data unavailable");
const formatShares = (value) => (Number.isFinite(value) ? `${Math.floor(value).toLocaleString("en-US")} sh` : "Data unavailable");

const setStatus = (element, message, tone = "muted") => {
  element.textContent = message;
  element.className = `status-pill ${tone}`;
};

const getSelectedTicker = () => {
  const manual = safeUpperTicker(manualTicker.value);
  const preset = safeUpperTicker(presetTicker.value);
  return manual || preset || "TSLA";
};

const describeRiskLabel = (score) => {
  if (score <= 25) return { label: "Low", tone: "green" };
  if (score <= 50) return { label: "Moderate", tone: "amber" };
  if (score <= 75) return { label: "Elevated", tone: "amber" };
  return { label: "High", tone: "red" };
};

const assessmentClass = (status) => {
  if (status === "favorable" || status === "strong") return "green";
  if (status === "weak" || status === "high-risk") return "red";
  return "amber";
};

const metricTone = (tone) => {
  if (tone === "green" || tone === "positive" || tone === "attractive") return "green";
  if (tone === "red" || tone === "negative" || tone === "risky") return "red";
  return "amber";
};

const arrowForDelta = (value) => {
  if (!Number.isFinite(value)) return "";
  if (value > 0.2) return "▲";
  if (value < -0.2) return "▼";
  return "•";
};

const renderLoading = () => {
  reportRoot.classList.add("loading");
  reportRoot.innerHTML = `
    <section class="report-page skeleton-page">
      <div class="skeleton skeleton-hero"></div>
      <div class="skeleton-grid">
        <div class="skeleton skeleton-card tall"></div>
        <div class="skeleton skeleton-card tall"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
      </div>
    </section>
  `;
};

const renderEmptyState = (message) => {
  reportRoot.classList.remove("loading");
  reportRoot.innerHTML = `<section class="report-page"><div class="empty-state">${message}</div></section>`;
};

const buildGauge = (score) => {
  const { label, tone } = describeRiskLabel(score);
  const startX = 28;
  const endX = 212;
  const baselineY = 124;
  const radius = 92;
  const circumference = Math.PI * radius;
  const progress = Math.min(100, Math.max(0, score)) / 100;
  const arcLength = circumference * progress;
  const markerAngle = Math.PI * (1 - progress);
  const markerX = 120 + Math.cos(markerAngle) * radius;
  const markerY = 124 - Math.sin(markerAngle) * radius;
  const toneColor = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : "var(--amber)";

  return `
    <path d="M ${startX} ${baselineY} A ${radius} ${radius} 0 0 1 ${endX} ${baselineY}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="18" stroke-linecap="round"></path>
    <path d="M ${startX} ${baselineY} A ${radius} ${radius} 0 0 1 ${endX} ${baselineY}" fill="none" stroke="url(#gaugeGradient)" stroke-width="18" stroke-linecap="round" stroke-dasharray="${arcLength} ${circumference}"></path>
    <circle cx="${markerX}" cy="${markerY}" r="9" fill="${toneColor}" stroke="#08090d" stroke-width="4"></circle>
    <text x="28" y="152" fill="var(--muted)" font-size="12" font-family="var(--mono)">0</text>
    <text x="110" y="152" fill="var(--muted)" font-size="12" font-family="var(--mono)">50</text>
    <text x="198" y="152" fill="var(--muted)" font-size="12" font-family="var(--mono)">100</text>
    <defs>
      <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#4fd68b"></stop>
        <stop offset="55%" stop-color="#ffbf5f"></stop>
        <stop offset="100%" stop-color="#ff6f7d"></stop>
      </linearGradient>
    </defs>
  `;
};

const buildBreakdownRow = (item) => `
  <div class="breakdown-row">
    <div>
      <strong>${item.label}</strong>
      <div class="muted compact">${item.weight}% weight</div>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${item.rawScore}%;"></div></div>
    <div class="mono">${item.rawScore.toFixed(1)} / 100</div>
    <div class="mono">${item.weightedContribution.toFixed(1)} pts</div>
  </div>
`;

const buildKpiItem = (label, value, note = "", tone = "amber") => `
  <div class="kpi-item ${metricTone(tone)}">
    <div class="kpi-label"><span class="status-dot"></span>${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-note">${note}</div>
  </div>
`;

const buildMetricTile = (label, value, note = "", tone = "amber") => `
  <div class="metric-tile ${metricTone(tone)}">
    <div class="metric-label"><span class="status-dot"></span>${label}</div>
    <div class="metric-value mono">${value}</div>
    ${note ? `<div class="metric-note">${note}</div>` : ""}
  </div>
`;

const buildSourceLinks = (sources = []) =>
  sources
    .map((source, index) => `<a href="${source.url}" target="_blank" rel="noreferrer">[${index + 1}] ${source.label}</a>`)
    .join("");

const parseTradeNumber = (element) => {
  const value = Number(String(element.value).replace(/[$,]/g, "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

const getSwingTradeInputs = () => {
  const entry = parseTradeNumber(entryPrice);
  const stop = parseTradeNumber(stopLossPrice);
  const rr = parseTradeNumber(preferredRr) ?? 2;
  const provided = entry != null || stop != null || preferredRr.value.trim() || maxHoldingPeriod.value.trim() || positionRisk.value.trim();
  return {
    provided,
    direction: tradeDirection.value === "short" ? "short" : "long",
    entry,
    stop,
    preferredRr: Math.max(0.1, rr),
    maxHoldingPeriod: maxHoldingPeriod.value.trim(),
    positionRisk: positionRisk.value.trim(),
  };
};

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

const calculateAtrProxy = (points) => {
  const changes = points
    .slice(-15)
    .map((point, index, array) => (index === 0 ? null : Math.abs(point.close - array[index - 1].close)))
    .filter(Number.isFinite);
  return average(changes);
};

const nearestAbove = (levels, reference) => {
  const candidates = levels.filter((level) => Number.isFinite(level) && level > reference).sort((a, b) => a - b);
  return candidates[0] ?? null;
};

const nearestBelow = (levels, reference) => {
  const candidates = levels.filter((level) => Number.isFinite(level) && level < reference).sort((a, b) => b - a);
  return candidates[0] ?? null;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const extractRiskBudget = (value) => {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
};

const buildAnalysisCard = (card) => `
  <article class="analysis-item">
    <div class="analysis-topline">
      <h4>${card.title}</h4>
      <span class="assessment-chip ${assessmentClass(card.status)}">${card.badge}</span>
    </div>
    <ul>${card.points.map((point) => `<li>${point}</li>`).join("")}</ul>
    ${card.source ? `<p class="source-note">${card.source}</p>` : ""}
  </article>
`;

const buildNarrativeBlock = (title, body, meta = "") => `
  <div class="narrative-block">
    <h4>${title}</h4>
    ${meta ? `<p class="mini-label">${meta}</p>` : ""}
    <p>${body}</p>
  </div>
`;

const buildLegendTag = (label, color) => `
  <span class="legend-tag"><span class="legend-dot" style="background:${color};"></span>${label}</span>
`;

const scoreTone = (value) => {
  if (!Number.isFinite(value)) return "watch";
  if (value >= 0.5) return "beat";
  if (value <= -0.5) return "miss";
  return "watch";
};

const normalizeQuarterMetric = (value) => (Number.isFinite(value) ? value : null);

const renderQuarterlyTable = (quarters) => {
  const table = document.getElementById("quarterlyTable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  if (!quarters.length) {
    thead.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="6">Quarterly financials unavailable for this ticker.</td></tr>`;
    return;
  }

  const shownQuarters = quarters.slice(0, 4);
  const trendTone = (values, higherIsBetter = true) => {
    const clean = values.filter(Number.isFinite);
    if (clean.length < 2) return "watch";
    const delta = clean[0] - clean[clean.length - 1];
    const direction = higherIsBetter ? delta : -delta;
    if (direction > Math.abs(clean[clean.length - 1] || 1) * 0.04) return "beat";
    if (direction < -Math.abs(clean[clean.length - 1] || 1) * 0.04) return "miss";
    return "watch";
  };
  const row = (label, getValue, formatter, higherIsBetter = true) => {
    const values = shownQuarters.map(getValue);
    const tone = trendTone(values, higherIsBetter);
    const trendLabel = tone === "beat" ? "Improving" : tone === "miss" ? "Worsening" : "Stable / mixed";
    return `
      <tr>
        <th>${label}</th>
        ${shownQuarters.map((quarter) => `<td>${formatter(getValue(quarter))}</td>`).join("")}
        <td><span class="${tone}">${trendLabel}</span></td>
      </tr>
    `;
  };

  thead.innerHTML = `
    <tr>
      <th>Metric</th>
      ${shownQuarters.map((quarter) => `<th>${quarter.label}</th>`).join("")}
      <th>Trend</th>
    </tr>
  `;

  tbody.innerHTML = [
    row("Revenue", (q) => q.revenue, formatMoneyShort),
    row("Revenue growth YoY", (q) => q.revenueGrowthYoY, formatPercent),
    row("Gross margin", (q) => q.grossMargin, formatPercent),
    row("Operating margin", (q) => q.operatingMargin, formatPercent),
    row("Net income", (q) => q.netIncome, formatMoneyShort),
    row("EPS", (q) => q.eps, (value) => (Number.isFinite(value) ? value.toFixed(2) : "Data unavailable")),
    row("Free cash flow", (q) => q.freeCashFlow, formatMoneyShort),
    row("Cash", (q) => q.cash, formatMoneyShort),
    row("Debt", (q) => q.debt, formatMoneyShort, false),
  ].join("");
};

const setCopyFeedback = (message, tone) => {
  clearTimeout(copyResetTimer);
  setStatus(copyStatus, message, tone);
  copyResetTimer = setTimeout(() => {
    setStatus(copyStatus, "Clipboard idle", "muted");
  }, 2400);
};

const buildTextReport = (payload) => {
  const { quote, scoring, chart, narrative, quarterly, rating, technical, performance } = payload;
  const breakdown = scoring.breakdown
    .map((item) => `${item.label}: ${item.rawScore.toFixed(1)}/100 (${item.weight}% weight, ${item.weightedContribution.toFixed(1)} pts)`)
    .join("\n");
  const quarterLines = quarterly
    .map(
      (quarter) =>
        `${quarter.label}: Revenue ${formatMoney(quarter.revenue)}, EPS ${Number.isFinite(quarter.eps) ? quarter.eps.toFixed(2) : "n/a"}, Operating Margin ${formatPercent(quarter.operatingMargin)}, FCF ${formatMoney(quarter.freeCashFlow)}`,
    )
    .join("\n");
  const swingAnalysis = buildSwingTradeAnalysis(payload);
  const swingLines =
    swingAnalysis.state === "ready"
      ? [
          "Swing trade setup",
          `Direction: ${swingAnalysis.direction}`,
          `Entry: ${formatPrice(swingAnalysis.entry)} | Stop: ${formatPrice(swingAnalysis.stop)}`,
          `Risk/share: ${formatPrice(swingAnalysis.riskPerShare)} (${formatPercent(swingAnalysis.percentRisk)})`,
          `Targets: 1R ${formatPrice(swingAnalysis.oneR)}, 2R ${formatPrice(swingAnalysis.twoR)}, 3R ${formatPrice(swingAnalysis.threeR)}`,
          `Recommended take profit: ${formatPrice(swingAnalysis.recommended)} (${swingAnalysis.expectedRr.toFixed(2)}R)`,
          `Trade quality: ${swingAnalysis.quality}/100 | Setup type: ${swingAnalysis.setupType}`,
          swingAnalysis.rationale,
          "",
        ]
      : [];

  return [
    `Risk Score Report - ${quote.companyName} (${quote.ticker})`,
    `${quote.exchange || "Exchange unavailable"} | Price ${formatPrice(quote.currentPrice)} | Daily move ${formatPercent(quote.dailyChangePercent)}`,
    `Last updated: ${quote.updatedAtLabel}`,
    "",
    `Risk Score: ${scoring.totalScore.toFixed(1)} (${scoring.label})`,
    `Rating: ${rating?.label || scoring.rating || "Hold"} | Confidence ${rating?.confidence ?? "n/a"}/10 | Investor type ${rating?.investorType || "Balanced"}`,
    `Verdict: ${scoring.verdict}`,
    "",
    "Score Breakdown",
    breakdown,
    "",
    `12M range: Low ${formatPrice(chart.low)} | High ${formatPrice(chart.high)} | Return ${formatPercent(chart.returnPercent)}`,
    "",
    "Latest update",
    narrative.latestSummary,
    narrative.deliverySummary ? `Delivery update: ${narrative.deliverySummary}` : "",
    "",
    "Company overview",
    narrative.companyOverview,
    "",
    "Performance",
    `1M ${formatPercent(performance?.oneMonth)} | 6M ${formatPercent(performance?.sixMonth)} | 1Y ${formatPercent(performance?.oneYear)} | 5Y ${formatPercent(performance?.fiveYear)}`,
    `S&P 500 comparison: ${formatPercent(performance?.sp500OneYear)} | Sector ETF comparison: ${formatPercent(performance?.sectorEtfOneYear)}`,
    "",
    "Technical analysis",
    technical?.summary || "Technical data unavailable",
    "",
    ...swingLines,
    "Catalysts",
    ...narrative.catalysts.map((item) => `- ${item}`),
    "",
    "Risks",
    ...narrative.risks.map((item) => `- ${item}`),
    "",
    "Quarterly trend",
    quarterLines || "Quarterly data unavailable",
    "",
    "Bottom line",
    narrative.bottomLine,
  ]
    .filter(Boolean)
    .join("\n");
};

const buildSummaryReport = (payload) => {
  const { quote, scoring, narrative, rating } = payload;
  return [
    `${quote.ticker} Summary`,
    `Risk score: ${scoring.totalScore.toFixed(1)} / 100 (${scoring.label})`,
    `Rating: ${rating?.label || "Hold"}`,
    `Confidence: ${rating?.confidence ?? "n/a"} / 10`,
    "",
    "Key risks",
    ...narrative.risks.slice(0, 4).map((item) => `- ${item}`),
    "",
    "Key catalysts",
    ...narrative.catalysts.slice(0, 4).map((item) => `- ${item}`),
    "",
    "Final verdict",
    narrative.bottomLine,
  ].join("\n");
};

const copyTextReport = async () => {
  if (!currentPayload) return;
  try {
    await navigator.clipboard.writeText(buildTextReport(currentPayload));
    setCopyFeedback("Text report copied", "success");
  } catch (error) {
    setCopyFeedback(error instanceof Error ? error.message : "Copy failed", "error");
  }
};

const copySummaryReport = async () => {
  if (!currentPayload) return;
  try {
    await navigator.clipboard.writeText(buildSummaryReport(currentPayload));
    setCopyFeedback("Summary copied", "success");
  } catch (error) {
    setCopyFeedback(error instanceof Error ? error.message : "Copy failed", "error");
  }
};

const renderChart = (chart, events) => {
  const svg = document.getElementById("priceChart");
  const tooltip = document.getElementById("chartTooltip");
  const legend = document.getElementById("chartLegend");

  if (!chart.points.length) {
    svg.innerHTML = `<text x="24" y="48" fill="var(--muted)" font-size="16">Price history unavailable for this ticker.</text>`;
    legend.innerHTML = "";
    return;
  }

  const width = 880;
  const height = 320;
  const padding = { top: 28, right: 22, bottom: 44, left: 24 };
  const xs = chart.points.map((_, index) => index);
  const ys = chart.points.map((point) => point.close);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeY = maxY - minY || 1;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const scaleX = (index) => padding.left + (index / Math.max(1, xs.length - 1)) * innerWidth;
  const scaleY = (value) => padding.top + innerHeight - ((value - minY) / rangeY) * innerHeight;

  const linePath = chart.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${scaleX(index).toFixed(1)} ${scaleY(point.close).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L ${scaleX(xs.length - 1).toFixed(1)} ${padding.top + innerHeight} L ${scaleX(0).toFixed(1)} ${padding.top + innerHeight} Z`;

  const yTicks = Array.from({ length: 4 }, (_, index) => minY + (rangeY / 3) * index);
  const xTickIndexes = [0, Math.floor(xs.length / 3), Math.floor((xs.length / 3) * 2), xs.length - 1];
  const eventMarkup = events
    .map((event) => {
      const index = chart.points.findIndex((point) => point.date === event.chartDate);
      if (index < 0) return "";
      const x = scaleX(index);
      const y = scaleY(chart.points[index].close);
      return `
        <g class="chart-event" data-label="${event.label}" data-detail="${event.detail}" data-date="${event.displayDate}" transform="translate(${x}, ${y})">
          <line x1="0" y1="${height - padding.bottom - y}" x2="0" y2="16" stroke="rgba(255,255,255,0.16)" stroke-dasharray="4 6"></line>
          <circle cx="0" cy="0" r="5" fill="${event.color}"></circle>
        </g>
      `;
    })
    .join("");

  svg.innerHTML = `
    <defs>
      <linearGradient id="areaFill" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="rgba(87,208,255,0.32)"></stop>
        <stop offset="100%" stop-color="rgba(87,208,255,0.02)"></stop>
      </linearGradient>
    </defs>
    ${yTicks
      .map(
        (tick) => `
          <g>
            <line x1="${padding.left}" y1="${scaleY(tick)}" x2="${width - padding.right}" y2="${scaleY(tick)}" stroke="rgba(255,255,255,0.08)"></line>
            <text x="${padding.left}" y="${scaleY(tick) - 8}" fill="var(--muted)" font-size="11" font-family="var(--mono)">${formatPrice(tick)}</text>
          </g>
        `,
      )
      .join("")}
    <path d="${areaPath}" fill="url(#areaFill)"></path>
    <path d="${linePath}" fill="none" stroke="var(--cyan)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
    ${xTickIndexes
      .map((index) => {
        const point = chart.points[index];
        return `<text x="${scaleX(index)}" y="${height - 14}" fill="var(--muted)" font-size="11" text-anchor="middle" font-family="var(--mono)">${point.label}</text>`;
      })
      .join("")}
    <g id="chartDots">
      ${chart.points
        .filter((_, index) => index % Math.ceil(chart.points.length / 36) === 0 || index === chart.points.length - 1)
        .map((point, index, filtered) => {
          const actualIndex = chart.points.findIndex((item) => item.date === point.date);
          return `<circle class="chart-dot" data-index="${actualIndex}" cx="${scaleX(actualIndex)}" cy="${scaleY(point.close)}" r="4"></circle>`;
        })
        .join("")}
    </g>
    ${eventMarkup}
  `;

  legend.innerHTML = [
    buildLegendTag("Price trend", "var(--cyan)"),
    ...events.map((event) => buildLegendTag(event.label, event.color)),
  ].join("");

  const showTooltip = (x, y, title, body) => {
    tooltip.classList.remove("hidden");
    tooltip.style.left = `${Math.max(18, Math.min(x + 14, svg.clientWidth - 196))}px`;
    tooltip.style.top = `${Math.max(18, y - 18)}px`;
    tooltip.innerHTML = `<strong>${title}</strong><div class="muted compact" style="margin-top:6px;">${body}</div>`;
  };

  svg.querySelectorAll(".chart-dot").forEach((node) => {
    node.addEventListener("mouseenter", () => {
      const point = chart.points[Number(node.dataset.index)];
      showTooltip(node.cx.baseVal.value, node.cy.baseVal.value, `${point.displayDate} • ${formatPrice(point.close)}`, point.deltaLabel);
    });
  });

  svg.querySelectorAll(".chart-event").forEach((node) => {
    node.addEventListener("mouseenter", () => {
      showTooltip(node.transform.baseVal[0].matrix.e, node.transform.baseVal[0].matrix.f, `${node.dataset.label} • ${node.dataset.date}`, node.dataset.detail);
    });
  });

  svg.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
};

const buildSwingTradeAnalysis = (payload) => {
  const inputs = getSwingTradeInputs();
  if (!inputs.provided) {
    return { state: "empty" };
  }

  if (inputs.entry == null || inputs.stop == null) {
    return { state: "invalid", message: "Enter both an entry price and a stop-loss price to generate the swing-trade setup." };
  }

  const isLong = inputs.direction === "long";
  const riskPerShare = isLong ? inputs.entry - inputs.stop : inputs.stop - inputs.entry;
  if (riskPerShare <= 0) {
    return {
      state: "invalid",
      message: isLong ? "For a long trade, the stop loss must be below the entry price." : "For a short trade, the stop loss must be above the entry price.",
    };
  }

  const { quote, chart, technical, narrative } = payload;
  const current = quote.currentPrice;
  const oneR = isLong ? inputs.entry + riskPerShare : inputs.entry - riskPerShare;
  const twoR = isLong ? inputs.entry + riskPerShare * 2 : inputs.entry - riskPerShare * 2;
  const threeR = isLong ? inputs.entry + riskPerShare * 3 : inputs.entry - riskPerShare * 3;
  const preferredTarget = isLong ? inputs.entry + riskPerShare * inputs.preferredRr : inputs.entry - riskPerShare * inputs.preferredRr;
  const atrProxy = calculateAtrProxy(chart.points || []);
  const swingHigh = Math.max(...(chart.points || []).slice(-42).map((point) => point.close).filter(Number.isFinite));
  const swingLow = Math.min(...(chart.points || []).slice(-42).map((point) => point.close).filter(Number.isFinite));
  const upperLevels = [technical.resistance, swingHigh, technical.sma50, technical.sma200, quote.fiftyTwoWeekHigh ?? chart.high, chart.high].filter(Number.isFinite);
  const lowerLevels = [technical.support, swingLow, technical.sma50, technical.sma200, quote.fiftyTwoWeekLow ?? chart.low, chart.low].filter(Number.isFinite);
  const nearestResistance = nearestAbove(upperLevels, inputs.entry);
  const nearestSupport = nearestBelow(lowerLevels, inputs.entry);
  const rangeHigh = quote.fiftyTwoWeekHigh ?? chart.high;
  const rangeLow = quote.fiftyTwoWeekLow ?? chart.low;
  const rsi = technical.rsi14;
  const strongLong = technical.trend === "Uptrend" && technical.volumeTrend === "Above average";
  const strongShort = technical.trend === "Downtrend" && technical.volumeTrend === "Above average";
  const overbought = Number.isFinite(rsi) && rsi >= 70;
  const oversold = Number.isFinite(rsi) && rsi <= 30;
  let recommended = preferredTarget;
  const reasons = [];

  if (isLong) {
    if (nearestResistance && twoR > nearestResistance) {
      recommended = Math.min(recommended, nearestResistance * 0.995);
      reasons.push("The 2R/preferred target runs into nearby resistance, so the target is placed slightly below that zone.");
    }
    if (Number.isFinite(atrProxy) && threeR - inputs.entry > atrProxy * 5 && !strongLong) {
      recommended = Math.min(recommended, twoR);
      reasons.push("The 3R target is stretched versus recent volatility, so it is not used as the main objective.");
    }
    if (overbought) {
      recommended = Math.min(recommended, twoR, nearestResistance ? nearestResistance * 0.995 : twoR);
      reasons.push("RSI is overbought, so the plan uses a more conservative take-profit level.");
    }
    if (strongLong && !overbought && preferredTarget >= twoR) {
      recommended = Math.max(recommended, Math.min(threeR, rangeHigh || threeR));
      reasons.push("Trend and volume are supportive, so the setup can tolerate a more aggressive target.");
    }
    if (rangeHigh && recommended > rangeHigh && !strongLong) {
      recommended = rangeHigh * 0.995;
      reasons.push("The target is capped just below the 12-month high because that area can attract supply.");
    }
  } else {
    if (nearestSupport && twoR < nearestSupport) {
      recommended = Math.max(recommended, nearestSupport * 1.005);
      reasons.push("The 2R/preferred target runs into nearby support, so the target is placed slightly above that zone.");
    }
    if (Number.isFinite(atrProxy) && inputs.entry - threeR > atrProxy * 5 && !strongShort) {
      recommended = Math.max(recommended, twoR);
      reasons.push("The 3R target is stretched versus recent volatility, so it is not used as the main objective.");
    }
    if (oversold) {
      recommended = Math.max(recommended, twoR, nearestSupport ? nearestSupport * 1.005 : twoR);
      reasons.push("RSI is oversold, so the plan uses a more conservative short target.");
    }
    if (strongShort && !oversold && preferredTarget <= twoR) {
      recommended = Math.min(recommended, Math.max(threeR, rangeLow || threeR));
      reasons.push("Trend and volume support the short setup, allowing a more aggressive downside target.");
    }
    if (rangeLow && recommended < rangeLow && !strongShort) {
      recommended = rangeLow * 1.005;
      reasons.push("The target is capped just above the 12-month low because that area can attract demand.");
    }
  }

  if (!Number.isFinite(recommended) || (isLong && recommended <= inputs.entry) || (!isLong && recommended >= inputs.entry)) {
    recommended = oneR;
    reasons.push("Nearby levels leave limited room, so the realistic target falls back to 1R.");
  }

  const expectedRr = Math.abs(recommended - inputs.entry) / riskPerShare;
  const percentRisk = (riskPerShare / inputs.entry) * 100;
  let quality = 50;
  quality += expectedRr >= 2 ? 18 : expectedRr >= 1.5 ? 8 : -18;
  quality += (isLong && technical.trend === "Uptrend") || (!isLong && technical.trend === "Downtrend") ? 14 : -8;
  quality += (isLong && overbought) || (!isLong && oversold) ? -14 : 0;
  quality += (isLong && oversold) || (!isLong && overbought) ? 6 : 0;
  quality += technical.volumeTrend === "Above average" ? 7 : technical.volumeTrend === "Below average" ? -5 : 0;
  quality += Number.isFinite(atrProxy) && riskPerShare >= atrProxy * 0.6 && riskPerShare <= atrProxy * 3 ? 6 : -5;
  quality += expectedRr < 1.2 ? -18 : 0;
  quality = Math.round(clamp(quality, 0, 100));

  let setupType = "Range trade";
  if (expectedRr < 1.2 || quality < 35) setupType = "Failed setup / avoid";
  else if ((isLong && technical.trend === "Uptrend" && inputs.entry > (nearestResistance ?? Infinity) * 0.98) || (!isLong && technical.trend === "Downtrend" && inputs.entry < (nearestSupport ?? -Infinity) * 1.02)) setupType = "Momentum breakout";
  else if ((isLong && technical.trend === "Uptrend") || (!isLong && technical.trend === "Downtrend")) setupType = "Pullback continuation";
  else if ((isLong && oversold) || (!isLong && overbought)) setupType = "Mean reversion";

  const tone = quality >= 70 ? "green" : quality >= 45 ? "amber" : "red";
  const invalidation = isLong
    ? `A close below ${formatPrice(inputs.stop)} or a failed bounce at support would invalidate the long setup.`
    : `A close above ${formatPrice(inputs.stop)} or a failed rejection at resistance would invalidate the short setup.`;
  const watchNext = [
    narrative.importantDates && !/unavailable/i.test(narrative.importantDates) ? narrative.importantDates : null,
    `RSI ${Number.isFinite(rsi) ? rsi.toFixed(1) : "unavailable"}`,
    technical.volumeTrend ? `volume trend: ${technical.volumeTrend.toLowerCase()}` : null,
    isLong ? `resistance near ${formatPrice(nearestResistance ?? rangeHigh)}` : `support near ${formatPrice(nearestSupport ?? rangeLow)}`,
  ]
    .filter(Boolean)
    .join("; ");

  const riskBudget = extractRiskBudget(inputs.positionRisk);
  const estimatedShares = riskBudget && !/%/.test(inputs.positionRisk) ? riskBudget / riskPerShare : null;

  return {
    state: "ready",
    direction: inputs.direction,
    entry: inputs.entry,
    stop: inputs.stop,
    riskPerShare,
    percentRisk,
    oneR,
    twoR,
    threeR,
    recommended,
    expectedRr,
    quality,
    tone,
    setupType,
    atrProxy,
    nearestResistance,
    nearestSupport,
    current,
    rangeHigh,
    rangeLow,
    maxHoldingPeriod: inputs.maxHoldingPeriod,
    positionRisk: inputs.positionRisk,
    estimatedShares,
    rationale:
      reasons.length > 0
        ? reasons.join(" ")
        : "The recommended target balances the preferred risk/reward input with the current trend, recent support/resistance, RSI, moving averages, and 12-month range.",
    plan: [
      `Enter near: ${formatPrice(inputs.entry)}.`,
      `Stop if price ${isLong ? "falls" : "rises"} to: ${formatPrice(inputs.stop)}.`,
      `Consider taking profit near: ${formatPrice(recommended)}.`,
      `Risk/reward: ${expectedRr.toFixed(2)}R.`,
      `Invalidation: ${invalidation}`,
      `Watch next: ${watchNext}.`,
      inputs.maxHoldingPeriod ? `Max holding period: ${inputs.maxHoldingPeriod}.` : null,
      inputs.positionRisk ? `Position risk note: ${inputs.positionRisk}${estimatedShares ? `, about ${formatShares(estimatedShares)} at this stop distance` : ""}.` : null,
    ].filter(Boolean),
  };
};

const renderTradePlanChart = (analysis) => {
  const svg = document.getElementById("tradePlanChart");
  if (!svg) return;
  const width = 880;
  const height = 280;
  const padding = { top: 22, right: 130, bottom: 24, left: 26 };
  const levels = [
    analysis.entry,
    analysis.stop,
    analysis.recommended,
    analysis.oneR,
    analysis.twoR,
    analysis.threeR,
    analysis.current,
    analysis.nearestResistance,
    analysis.nearestSupport,
    analysis.rangeHigh,
    analysis.rangeLow,
  ].filter(Number.isFinite);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const span = max - min || 1;
  const y = (value) => padding.top + ((max - value) / span) * (height - padding.top - padding.bottom);
  const zone = (label, primary, fallback, color) => {
    const value = Number.isFinite(primary) ? primary : fallback;
    if (!Number.isFinite(value)) return "";
    return `
      <g>
        <rect x="${padding.left}" y="${y(value) - 5}" width="${width - padding.left - padding.right}" height="10" rx="5" fill="${color}"></rect>
        <text x="${padding.left + 8}" y="${y(value) - 10}" fill="var(--amber)" font-size="11" font-family="var(--mono)">${label}</text>
      </g>
    `;
  };
  const line = (label, value, color, dash = "") =>
    Number.isFinite(value)
      ? `<g>
          <line x1="${padding.left}" y1="${y(value)}" x2="${width - padding.right}" y2="${y(value)}" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""}></line>
          <text x="${width - padding.right + 12}" y="${y(value) + 4}" fill="${color}" font-size="12" font-family="var(--mono)">${label} ${formatPrice(value)}</text>
        </g>`
      : "";
  svg.innerHTML = `
    ${zone("Resistance zone", analysis.nearestResistance, analysis.rangeHigh, "rgba(255,191,95,0.14)")}
    ${zone("Support zone", analysis.nearestSupport, analysis.rangeLow, "rgba(255,191,95,0.14)")}
    ${line("Stop", analysis.stop, "var(--red)")}
    ${line("Entry", analysis.entry, "var(--cyan)")}
    ${line("1R", analysis.oneR, "rgba(255,255,255,0.45)", "5 6")}
    ${line("2R", analysis.twoR, "rgba(255,255,255,0.45)", "5 6")}
    ${line("3R", analysis.threeR, "rgba(255,255,255,0.45)", "5 6")}
    ${line("Take profit", analysis.recommended, "var(--green)")}
    ${line("Current", analysis.current, "var(--text)", "3 5")}
    ${line("Resistance", analysis.nearestResistance, "var(--amber)", "7 7")}
    ${line("Support", analysis.nearestSupport, "var(--amber)", "7 7")}
  `;
};

const renderSwingTradeSection = (payload) => {
  const section = document.getElementById("swingTradeSection");
  if (!section) return;
  const empty = document.getElementById("swingEmptyState");
  const validation = document.getElementById("swingValidation");
  const body = document.getElementById("swingTradeBody");
  const chip = document.getElementById("swingQualityChip");
  const analysis = buildSwingTradeAnalysis(payload);

  if (analysis.state === "empty") {
    empty.classList.remove("hidden");
    validation.classList.add("hidden");
    body.classList.add("hidden");
    chip.textContent = "Optional";
    chip.className = "assessment-chip amber";
    return;
  }

  if (analysis.state === "invalid") {
    empty.classList.add("hidden");
    validation.classList.remove("hidden");
    validation.textContent = analysis.message;
    body.classList.add("hidden");
    chip.textContent = "Invalid";
    chip.className = "assessment-chip red";
    return;
  }

  empty.classList.add("hidden");
  validation.classList.add("hidden");
  body.classList.remove("hidden");
  chip.textContent = `${analysis.quality}/100 • ${analysis.setupType}`;
  chip.className = `assessment-chip ${analysis.tone}`;
  document.getElementById("swingMetricGrid").innerHTML = [
    buildMetricTile("Entry", formatPrice(analysis.entry), `${analysis.direction.toUpperCase()} setup`, "amber"),
    buildMetricTile("Stop loss", formatPrice(analysis.stop), "Invalidation level", "red"),
    buildMetricTile("Risk / share", formatPrice(analysis.riskPerShare), `${formatPercent(analysis.percentRisk)} of entry`, "red"),
    buildMetricTile("1R target", formatPrice(analysis.oneR), "Formula target", "amber"),
    buildMetricTile("2R target", formatPrice(analysis.twoR), "Formula target", "amber"),
    buildMetricTile("3R target", formatPrice(analysis.threeR), "Formula target", "amber"),
    buildMetricTile("Take profit", formatPrice(analysis.recommended), "Realistic target", "green"),
    buildMetricTile("Reward / risk", `${analysis.expectedRr.toFixed(2)}R`, `ATR proxy ${formatPrice(analysis.atrProxy)}`, analysis.expectedRr >= 2 ? "green" : analysis.expectedRr >= 1.3 ? "amber" : "red"),
    buildMetricTile("Trade quality", `${analysis.quality} / 100`, analysis.setupType, analysis.tone),
    buildMetricTile("Support", formatPrice(analysis.nearestSupport), "Nearest relevant level", "green"),
    buildMetricTile("Resistance", formatPrice(analysis.nearestResistance), "Nearest relevant level", "red"),
    buildMetricTile("Position note", analysis.estimatedShares ? formatShares(analysis.estimatedShares) : analysis.positionRisk || "Optional", analysis.maxHoldingPeriod || "Holding period optional", "amber"),
  ].join("");
  renderTradePlanChart(analysis);
  document.getElementById("tradePlanList").innerHTML = analysis.plan.map((item) => `<li>${item}</li>`).join("");
  document.getElementById("tradePlanRationale").textContent = analysis.rationale;
};

const renderReport = (payload) => {
  currentPayload = payload;
  reportRoot.classList.remove("loading");
  reportRoot.innerHTML = reportTemplate.innerHTML;

  const { quote, scoring, chart, cards, narrative, quarterly, sources = [], performance = {}, technical = {}, rating = {} } = payload;
  const riskMeta = describeRiskLabel(scoring.totalScore);

  document.getElementById("companyName").textContent = quote.companyName;
  document.getElementById("companyMeta").textContent = [quote.ticker, quote.exchange || "Exchange unavailable"].filter(Boolean).join(" • ");
  document.getElementById("currentPrice").textContent = formatPrice(quote.currentPrice);
  document.getElementById("dailyMove").textContent = `${arrowForDelta(quote.dailyChangePercent)} ${formatPercent(quote.dailyChangePercent)}`;
  document.getElementById("dailyMove").className = `delta ${quote.dailyChangePercent > 0 ? "positive" : quote.dailyChangePercent < 0 ? "negative" : "neutral"}`;
  document.getElementById("lastUpdated").textContent = quote.updatedAtLabel;
  document.getElementById("headerMarketCap").textContent = formatMoneyShort(quote.marketCap);
  document.getElementById("headerSector").textContent = [quote.sectorLabel, quote.industry].filter(Boolean).join(" / ") || "Data unavailable";
  document.getElementById("sourceList").innerHTML = buildSourceLinks(sources);
  document.getElementById("riskGauge").innerHTML = buildGauge(scoring.totalScore);
  document.getElementById("riskScore").textContent = scoring.totalScore.toFixed(1);
  document.getElementById("riskNarrative").textContent = scoring.summary;
  document.getElementById("riskLabel").textContent = riskMeta.label;
  document.getElementById("riskLabel").className = `assessment-chip ${riskMeta.tone}`;

  document.getElementById("kpiStrip").innerHTML = [
    buildKpiItem("Current price", formatPrice(quote.currentPrice), `${arrowForDelta(quote.dailyChangePercent)} ${formatPercent(quote.dailyChangePercent)} today`, quote.dailyChangePercent >= 0 ? "green" : "red"),
    buildKpiItem("52-week high", formatPrice(quote.fiftyTwoWeekHigh ?? chart.high), "Latest provider range", "amber"),
    buildKpiItem("52-week low", formatPrice(quote.fiftyTwoWeekLow ?? chart.low), "Latest provider range", "green"),
    buildKpiItem("Market cap", formatMoneyShort(quote.marketCap), quote.sectorLabel, "amber"),
    buildKpiItem("P/E", formatRatio(quote.trailingPE), "Trailing earnings multiple", !Number.isFinite(quote.trailingPE) ? "amber" : quote.trailingPE <= 25 ? "green" : quote.trailingPE <= 45 ? "amber" : "red"),
    buildKpiItem("Forward P/E", formatRatio(quote.forwardPE), "Provider consensus estimate", !Number.isFinite(quote.forwardPE) ? "amber" : quote.forwardPE <= 22 ? "green" : quote.forwardPE <= 40 ? "amber" : "red"),
    buildKpiItem("Price-to-sales", formatRatio(quote.priceToSales), "Revenue multiple", !Number.isFinite(quote.priceToSales) ? "amber" : quote.priceToSales <= 4 ? "green" : quote.priceToSales <= 9 ? "amber" : "red"),
    buildKpiItem("EV / EBITDA", formatRatio(quote.enterpriseToEbitda), "Enterprise value multiple", !Number.isFinite(quote.enterpriseToEbitda) ? "amber" : quote.enterpriseToEbitda <= 14 ? "green" : quote.enterpriseToEbitda <= 25 ? "amber" : "red"),
    buildKpiItem("FCF yield", formatPercent(quote.freeCashFlowYield), "Free cash flow / market cap", !Number.isFinite(quote.freeCashFlowYield) ? "amber" : quote.freeCashFlowYield >= 4 ? "green" : quote.freeCashFlowYield >= 0 ? "amber" : "red"),
    buildKpiItem("Debt-to-equity", formatRatio(quote.debtToEquity), quote.netCashLabel, !Number.isFinite(quote.debtToEquity) ? "amber" : quote.debtToEquity <= 0.8 ? "green" : quote.debtToEquity <= 1.8 ? "amber" : "red"),
    buildKpiItem("Revenue growth", formatPercent(quote.revenueGrowth), "Latest provider growth field", !Number.isFinite(quote.revenueGrowth) ? "amber" : quote.revenueGrowth >= 10 ? "green" : quote.revenueGrowth >= 0 ? "amber" : "red"),
    buildKpiItem("Net margin", formatPercent(quote.netMargin), "Net income / revenue", !Number.isFinite(quote.netMargin) ? "amber" : quote.netMargin >= 15 ? "green" : quote.netMargin >= 3 ? "amber" : "red"),
  ].join("");

  document.getElementById("chartSummary").textContent = `12M return ${formatPercent(chart.returnPercent)} • low ${formatPrice(chart.low)} • high ${formatPrice(chart.high)} • ${chart.points.length} trading points`;
  renderChart(chart, chart.events);

  document.getElementById("analysisGrid").innerHTML = cards.map(buildAnalysisCard).join("");
  document.getElementById("breakdownBars").innerHTML = scoring.breakdown.map(buildBreakdownRow).join("");

  renderQuarterlyTable(quarterly);
  document.getElementById("latestUpdate").innerHTML = [
    buildNarrativeBlock("Latest earnings update", narrative.latestSummary, narrative.latestMeta),
    buildNarrativeBlock("Latest delivery / operating note", narrative.deliverySummary, narrative.deliveryMeta),
    buildNarrativeBlock("Important dates", narrative.importantDates || "Upcoming company-specific dates were unavailable from the fetched data."),
  ].join("");

  document.getElementById("companyOverview").innerHTML = [
    buildNarrativeBlock("What the company does", narrative.companyOverview),
    buildNarrativeBlock("Revenue sources and competitors", narrative.competitorSummary),
    buildNarrativeBlock("Recent news context", narrative.newsContext),
  ].join("");

  document.getElementById("performanceGrid").innerHTML = [
    buildMetricTile("Current price", formatPrice(quote.currentPrice), "Latest quoted price", "amber"),
    buildMetricTile("52-week range", `${formatPrice(quote.fiftyTwoWeekLow ?? chart.low)} - ${formatPrice(quote.fiftyTwoWeekHigh ?? chart.high)}`, "Provider range / chart fallback", "amber"),
    buildMetricTile("1-month", formatPercent(performance.oneMonth), "Price return", performance.oneMonth >= 0 ? "green" : "red"),
    buildMetricTile("6-month", formatPercent(performance.sixMonth), "Price return", performance.sixMonth >= 0 ? "green" : "red"),
    buildMetricTile("1-year", formatPercent(performance.oneYear), "Price return", performance.oneYear >= 0 ? "green" : "red"),
    buildMetricTile("5-year", formatPercent(performance.fiveYear), "Price return if available", performance.fiveYear >= 0 ? "green" : "red"),
    buildMetricTile("S&P 500 1Y", formatPercent(performance.sp500OneYear), "SPY used as proxy when index fetch is unavailable", "amber"),
    buildMetricTile("Sector ETF 1Y", formatPercent(performance.sectorEtfOneYear), performance.sectorEtf || "Sector proxy unavailable", "amber"),
  ].join("");

  document.getElementById("financialHealth").innerHTML = [
    buildNarrativeBlock("Revenue, income, and cash flow", narrative.financialHealth),
    buildNarrativeBlock("Balance sheet strength", narrative.balanceSheet),
    buildNarrativeBlock("Margins and ROE", narrative.marginSummary),
  ].join("");
  document.getElementById("valuationSection").innerHTML = [
    buildNarrativeBlock("Core multiples", narrative.valuation),
    buildNarrativeBlock("Peer and sector context", narrative.peerValuation),
    buildNarrativeBlock("More reasonable setup", narrative.reasonableValuation),
  ].join("");
  document.getElementById("growthSection").innerHTML = [
    buildNarrativeBlock("Growth outlook", narrative.growthPotential),
    buildNarrativeBlock("Competitive advantages", narrative.competitivePosition),
  ].join("");
  document.getElementById("detailedRiskList").innerHTML = narrative.detailedRisks.map((item) => `<li>${item}</li>`).join("");
  document.getElementById("technicalGrid").innerHTML = [
    buildMetricTile("Trend", technical.trend || "Data unavailable", "Price vs moving averages", technical.trendTone || "amber"),
    buildMetricTile("50-day MA", formatPrice(technical.sma50), "Simple moving average", Number.isFinite(technical.sma50) && quote.currentPrice >= technical.sma50 ? "green" : Number.isFinite(technical.sma50) ? "red" : "amber"),
    buildMetricTile("200-day MA", formatPrice(technical.sma200), "Simple moving average", Number.isFinite(technical.sma200) && quote.currentPrice >= technical.sma200 ? "green" : Number.isFinite(technical.sma200) ? "red" : "amber"),
    buildMetricTile("RSI", Number.isFinite(technical.rsi14) ? technical.rsi14.toFixed(1) : "Data unavailable", technical.rsiLabel || "Neutral", technical.rsiTone || "amber"),
    buildMetricTile("Volume trend", technical.volumeTrend || "Data unavailable", "Latest vs 30-day average", technical.volumeTone || "amber"),
    buildMetricTile("Support", formatPrice(technical.support), "Recent price shelf", "green"),
    buildMetricTile("Resistance", formatPrice(technical.resistance), "Recent overhead level", "red"),
  ].join("");
  document.getElementById("technicalNarrative").textContent = technical.summary || "Technical analysis could not be calculated from the available price history.";
  renderSwingTradeSection(payload);
  document.getElementById("catalystList").innerHTML = narrative.catalysts.map((item) => `<li>${item}</li>`).join("");
  document.getElementById("riskList").innerHTML = narrative.risks.map((item) => `<li>${item}</li>`).join("");
  document.getElementById("bullCase").textContent = narrative.bullCase;
  document.getElementById("bearCase").textContent = narrative.bearCase;
  document.getElementById("ratingChip").textContent = rating.label || "Hold";
  document.getElementById("ratingChip").className = `assessment-chip ${rating.tone || "amber"}`;
  document.getElementById("ratingDetails").innerHTML = [
    buildMetricTile("Rating", rating.label || "Hold", "Educational, not financial advice", rating.tone || "amber"),
    buildMetricTile("Confidence", `${rating.confidence ?? "n/a"} / 10`, "Higher means data coverage is stronger", "amber"),
    buildMetricTile("Investor type", rating.investorType || "Balanced", "Based on risk score and volatility", rating.tone || "amber"),
    buildMetricTile("Time horizon", rating.timeHorizon || "Medium-term", "Suggested monitoring window", "amber"),
  ].join("");
  document.getElementById("ratingBar").style.width = `${rating.barPosition ?? 50}%`;
  document.getElementById("verdictLabel").textContent = rating.label || scoring.verdict;
  document.getElementById("bottomLine").textContent = narrative.bottomLine;
};

const fetchReport = async () => {
  const ticker = getSelectedTicker();
  if (!ticker) return;

  renderLoading();
  setStatus(fetchStatus, `Fetching ${ticker} live data`, "muted");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35_000);

  try {
    const response = await fetch(`/api/report?ticker=${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Unable to load report" }));
      throw new Error(payload.error || "Unable to load report");
    }
    const payload = await response.json();
    renderReport(payload);
    setStatus(fetchStatus, `Updated ${ticker} report`, "success");
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? `Timed out while loading ${ticker}. Try Refresh Report; the app will use fallbacks when sources respond.`
        : error instanceof Error
          ? error.message
          : "Unable to load report";
    renderEmptyState(message);
    setStatus(fetchStatus, message, "error");
  } finally {
    clearTimeout(timeoutId);
  }
};

presetTicker.addEventListener("change", () => {
  manualTicker.value = "";
  fetchReport();
});

manualTicker.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    fetchReport();
  }
});

refreshButton.addEventListener("click", fetchReport);
copyTextButton.addEventListener("click", copyTextReport);
copySummaryButton.addEventListener("click", copySummaryReport);
[tradeDirection, entryPrice, stopLossPrice, preferredRr, maxHoldingPeriod, positionRisk].forEach((element) => {
  element.addEventListener("input", () => {
    if (currentPayload) renderSwingTradeSection(currentPayload);
  });
  element.addEventListener("change", () => {
    if (currentPayload) renderSwingTradeSection(currentPayload);
  });
});

fetchReport();
