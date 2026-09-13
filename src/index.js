import "dotenv/config";
import cron from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG = {
  apiKey: process.env.COINGECKO_API_KEY?.trim() || "",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
  cronSchedule: process.env.CRON_SCHEDULE?.trim() || "*/30 * * * *",
  timezone: process.env.TIMEZONE?.trim() || "Asia/Jakarta",
  runOnce: toBoolean(process.env.RUN_ONCE, false),

  maxMarketRank: toNumber(process.env.MAX_MARKET_RANK, 1_500),
  topLimit: toNumber(process.env.TOP_LIMIT, 30),
  min24hChange: toNumber(process.env.MIN_24H_CHANGE, 5),
  minMarketCap: toNumber(process.env.MIN_MARKET_CAP, 5_000_000),
  minVolume: toNumber(process.env.MIN_VOLUME, 1_000_000),
  pageDelayMs: toNumber(process.env.PAGE_DELAY_MS, 700),

  minAppearances: toNumber(process.env.MIN_APPEARANCES, 3),
  volumeGrowthPercent: toNumber(process.env.VOLUME_GROWTH_PERCENT, 5),
  extremePumpPercent: toNumber(process.env.EXTREME_PUMP_PERCENT, 40),
  alertScore: toNumber(process.env.ALERT_SCORE, 5),
  maxVolumeToMarketCapPercent: toNumber(
    process.env.MAX_VOLUME_TO_MARKET_CAP_PERCENT,
    300,
  ),

  alertCooldownMinutes: toNumber(process.env.ALERT_COOLDOWN_MINUTES, 180),
  maxAlertsPerRun: toNumber(process.env.MAX_ALERTS_PER_RUN, 5),

  excludedSymbols: toSet(process.env.EXCLUDED_SYMBOLS),
  excludedIds: toSet(process.env.EXCLUDED_IDS),

  stateFile: path.resolve(process.env.STATE_FILE?.trim() || "./data/state.json"),
  historyRetentionDays: toNumber(process.env.HISTORY_RETENTION_DAYS, 7),
};

let isRunning = false;

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKeyInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

function localDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: CONFIG.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function fetchJson(url, options = {}, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(25_000),
      });

      if (response.ok) {
        return await response.json();
      }

      const body = await response.text();
      const retryable = response.status === 429 || response.status >= 500;

      if (!retryable) {
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      const backoffMs = 1_500 * 2 ** (attempt - 1);
      console.warn(`Request gagal. Retry ${attempt}/${attempts - 1} dalam ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

async function fetchMarketPage(page) {
  const params = new URLSearchParams({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: "250",
    page: String(page),
    sparkline: "false",
    price_change_percentage: "1h,24h,7d",
    locale: "en",
    precision: "full",
  });

  const headers = {
    accept: "application/json",
  };

  if (CONFIG.apiKey) {
    headers["x-cg-demo-api-key"] = CONFIG.apiKey;
  }

  const url = `https://api.coingecko.com/api/v3/coins/markets?${params}`;
  const data = await fetchJson(url, { headers });

  if (!Array.isArray(data)) {
    throw new Error("Response CoinGecko bukan array.");
  }

  return data;
}

async function fetchMarkets() {
  const perPage = 250;
  const totalPages = Math.ceil(CONFIG.maxMarketRank / perPage);
  const markets = [];

  console.log(
    `Mengambil ${totalPages} halaman CoinGecko untuk rank 1-${CONFIG.maxMarketRank}...`,
  );

  // Sequential requests are intentional to reduce 429/rate-limit errors.
  for (let page = 1; page <= totalPages; page += 1) {
    const pageData = await fetchMarketPage(page);
    markets.push(...pageData);

    console.log(
      `Halaman ${page}/${totalPages}: ${pageData.length} coin diterima.`,
    );

    if (page < totalPages) {
      await sleep(CONFIG.pageDelayMs);
    }

    // Stop early if CoinGecko has no more rows.
    if (pageData.length < perPage) break;
  }

  return markets;
}

async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.stateFile, "utf8");
    const parsed = JSON.parse(raw);

    return {
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      alerts: parsed.alerts && typeof parsed.alerts === "object" ? parsed.alerts : {},
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("State rusak/tidak dapat dibaca. Membuat state baru:", error.message);
    }
    return { snapshots: [], alerts: {} };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(CONFIG.stateFile), { recursive: true });

  const tempFile = `${CONFIG.stateFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempFile, CONFIG.stateFile);
}

function pruneState(state, now) {
  const cutoff = now.getTime() - CONFIG.historyRetentionDays * 24 * 60 * 60 * 1000;

  state.snapshots = state.snapshots.filter((snapshot) => {
    const timestamp = new Date(snapshot.runAt).getTime();
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });

  for (const [coinId, alert] of Object.entries(state.alerts)) {
    const timestamp = new Date(alert.lastAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      delete state.alerts[coinId];
    }
  }
}

function normalizeCoin(raw) {
  return {
    id: String(raw.id || ""),
    symbol: String(raw.symbol || "").toUpperCase(),
    name: String(raw.name || ""),
    marketRank: numberOrNull(raw.market_cap_rank),
    price: numberOrNull(raw.current_price),
    marketCap: numberOrNull(raw.market_cap),
    totalVolume: numberOrNull(raw.total_volume),
    change1h: numberOrNull(raw.price_change_percentage_1h_in_currency),
    change24h:
      numberOrNull(raw.price_change_percentage_24h_in_currency) ??
      numberOrNull(raw.price_change_percentage_24h),
    change7d: numberOrNull(raw.price_change_percentage_7d_in_currency),
    volumeToMarketCapPercent:
      Number.isFinite(Number(raw.total_volume)) &&
      Number.isFinite(Number(raw.market_cap)) &&
      Number(raw.market_cap) > 0
        ? (Number(raw.total_volume) / Number(raw.market_cap)) * 100
        : null,
  };
}

function getPreviousSnapshot(state, coinId) {
  for (let index = state.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = state.snapshots[index];
    if (snapshot.coinId === coinId) return snapshot;
  }
  return null;
}

function countAppearancesToday(state, coinId, dateKey) {
  return state.snapshots.filter(
    (snapshot) =>
      snapshot.coinId === coinId &&
      snapshot.dateKey === dateKey &&
      snapshot.isTopGainer === true,
  ).length;
}

function scoreCandidate({ coin, position, previous, appearancesIncludingCurrent }) {
  let score = position <= 10 ? 2 : 1;
  const positives = [position <= 10 ? "Top 10 gainer" : "Top 30 gainer"];
  const warnings = [];

  const oneHourPositive = Number.isFinite(coin.change1h) && coin.change1h > 0;
  if (oneHourPositive) {
    score += 1;
    positives.push("momentum 1 jam positif");
  }

  const growthRatio = previous?.totalVolume
    ? ((coin.totalVolume - previous.totalVolume) / previous.totalVolume) * 100
    : null;

  const volumeGrowing =
    Number.isFinite(growthRatio) && growthRatio >= CONFIG.volumeGrowthPercent;

  if (volumeGrowing) {
    score += 1;
    positives.push(`volume naik ${growthRatio.toFixed(1)}%`);
  }

  if (appearancesIncludingCurrent >= CONFIG.minAppearances) {
    score += 1;
    positives.push(`muncul ${appearancesIncludingCurrent}x hari ini`);
  }

  const lowVolume =
    !Number.isFinite(coin.totalVolume) || coin.totalVolume < CONFIG.minVolume;

  if (lowVolume) {
    score -= 2;
    warnings.push("volume di bawah batas");
  }

  const volumeWeakening =
    Number.isFinite(growthRatio) && growthRatio <= -CONFIG.volumeGrowthPercent;
  const momentumWeakening = !oneHourPositive || volumeWeakening;
  const extremePump =
    Number.isFinite(coin.change24h) &&
    coin.change24h >= CONFIG.extremePumpPercent;

  if (extremePump && momentumWeakening) {
    score -= 2;
    warnings.push("pump ekstrem mulai melemah");
  }

  const abnormalTurnover =
    Number.isFinite(coin.volumeToMarketCapPercent) &&
    coin.volumeToMarketCapPercent >= CONFIG.maxVolumeToMarketCapPercent;

  if (abnormalTurnover) {
    score -= 1;
    warnings.push(
      `turnover sangat tinggi ${coin.volumeToMarketCapPercent.toFixed(1)}% dari market cap`,
    );
  }

  return {
    score,
    positives,
    warnings,
    growthRatio,
    volumeGrowing,
  };
}

function canSendAlert(state, candidate, now) {
  const previousAlert = state.alerts[candidate.coin.id];
  if (!previousAlert) return true;

  const previousAt = new Date(previousAlert.lastAt).getTime();
  const cooldownMs = CONFIG.alertCooldownMinutes * 60 * 1000;
  const cooldownFinished = now.getTime() - previousAt >= cooldownMs;
  const scoreImproved = candidate.score > Number(previousAlert.score || 0);

  return cooldownFinished || scoreImproved;
}

function buildTelegramMessage(candidates, now) {
  const header = [
    "🚀 <b>REPEATED TOP GAINER SCANNER</b>",
    `<b>Waktu:</b> ${escapeHtml(localDateTime(now))} (${escapeHtml(CONFIG.timezone)})`,
    "<i>Scanner momentum — bukan perintah beli.</i>",
    "",
  ];

  const blocks = candidates.map((candidate, index) => {
    const { coin } = candidate;
    const positives = candidate.positives.join(", ");
    const warnings = candidate.warnings.length
      ? candidate.warnings.join(", ")
      : "belum ada flag utama";

    return [
      `<b>${index + 1}. ${escapeHtml(coin.name)} (${escapeHtml(coin.symbol)})</b>`,
      `Posisi gainer: #${candidate.position} | Rank market: #${coin.marketRank ?? "-"}`,
      `Harga: ${formatMoney(coin.price)}`,
      `1h: ${formatPercent(coin.change1h)} | 24h: ${formatPercent(coin.change24h)} | 7d: ${formatPercent(coin.change7d)}`,
      `Volume 24h: ${formatMoney(coin.totalVolume)}`,
      `Market cap: ${formatMoney(coin.marketCap)}`,
      `Volume/Market cap: ${formatPercent(coin.volumeToMarketCapPercent)}`,
      `Kemunculan hari ini: ${candidate.appearances}`,
      `<b>Score: ${candidate.score}</b>`,
      `✅ ${escapeHtml(positives)}`,
      `⚠️ ${escapeHtml(warnings)}`,
      `https://www.coingecko.com/en/coins/${encodeURIComponent(coin.id)}`,
    ].join("\n");
  });

  return [...header, ...blocks.flatMap((block) => [block, ""]), "Gunakan konfirmasi chart dan batas risiko sebelum entry."].join(
    "\n",
  );
}

async function sendTelegram(text) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    console.warn("Telegram belum dikonfigurasi. Alert hanya tampil di terminal.");
    return false;
  }

  const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!result?.ok) {
    throw new Error(`Telegram gagal: ${JSON.stringify(result)}`);
  }

  return true;
}

function printTable(candidates) {
  const rows = candidates.map((candidate) => ({
    pos: candidate.position,
    coin: `${candidate.coin.name} (${candidate.coin.symbol})`,
    rank: candidate.coin.marketRank,
    "1h": formatPercent(candidate.coin.change1h),
    "24h": formatPercent(candidate.coin.change24h),
    volume: formatMoney(candidate.coin.totalVolume),
    "vol/mcap": formatPercent(candidate.coin.volumeToMarketCapPercent),
    appearances: candidate.appearances,
    score: candidate.score,
    alert: candidate.shouldAlert ? "YES" : "-",
  }));

  console.table(rows);
}

async function runScanner() {
  if (isRunning) {
    console.warn("Scan sebelumnya masih berjalan. Siklus ini dilewati.");
    return;
  }

  isRunning = true;
  const now = new Date();
  const dateKey = dateKeyInTimezone(now);

  try {
    console.log(`\n[${localDateTime(now)}] Mengambil market CoinGecko...`);

    const [rawMarkets, state] = await Promise.all([fetchMarkets(), loadState()]);
    pruneState(state, now);

    const universe = rawMarkets
      .map(normalizeCoin)
      .filter((coin) => {
        const valid =
          coin.id &&
          coin.marketRank &&
          coin.marketRank <= CONFIG.maxMarketRank &&
          Number.isFinite(coin.change24h) &&
          coin.change24h >= CONFIG.min24hChange &&
          Number.isFinite(coin.marketCap) &&
          coin.marketCap >= CONFIG.minMarketCap;

        const excluded =
          CONFIG.excludedSymbols.has(coin.symbol.toLowerCase()) ||
          CONFIG.excludedIds.has(coin.id.toLowerCase());

        return valid && !excluded;
      })
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, CONFIG.topLimit);

    const candidates = universe.map((coin, index) => {
      const position = index + 1;
      const previous = getPreviousSnapshot(state, coin.id);
      const previousAppearances = countAppearancesToday(state, coin.id, dateKey);
      const appearances = previousAppearances + 1;

      const scoreData = scoreCandidate({
        coin,
        position,
        previous,
        appearancesIncludingCurrent: appearances,
      });

      return {
        coin,
        position,
        previous,
        appearances,
        ...scoreData,
      };
    });

    for (const candidate of candidates) {
      candidate.shouldAlert =
        candidate.score >= CONFIG.alertScore &&
        canSendAlert(state, candidate, now);
    }

    printTable(candidates);

    // Save each Top-30 appearance after scoring so the current run counts only once.
    for (const candidate of candidates) {
      state.snapshots.push({
        runAt: now.toISOString(),
        dateKey,
        coinId: candidate.coin.id,
        symbol: candidate.coin.symbol,
        name: candidate.coin.name,
        position: candidate.position,
        marketRank: candidate.coin.marketRank,
        price: candidate.coin.price,
        marketCap: candidate.coin.marketCap,
        totalVolume: candidate.coin.totalVolume,
        volumeToMarketCapPercent: candidate.coin.volumeToMarketCapPercent,
        change1h: candidate.coin.change1h,
        change24h: candidate.coin.change24h,
        change7d: candidate.coin.change7d,
        score: candidate.score,
        isTopGainer: true,
      });
    }

    const alertCandidates = candidates
      .filter((candidate) => candidate.shouldAlert)
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .slice(0, CONFIG.maxAlertsPerRun);

    if (alertCandidates.length > 0) {
      const message = buildTelegramMessage(alertCandidates, now);
      console.log("\n" + message.replace(/<[^>]+>/g, ""));

      const sent = await sendTelegram(message);
      if (sent) console.log(`Telegram alert terkirim untuk ${alertCandidates.length} coin.`);

      for (const candidate of alertCandidates) {
        state.alerts[candidate.coin.id] = {
          lastAt: now.toISOString(),
          score: candidate.score,
        };
      }
    } else {
      console.log("Belum ada kandidat baru yang lolos alert.");
    }

    await saveState(state);
    console.log(`State tersimpan: ${CONFIG.stateFile}`);
  } catch (error) {
    console.error("Scanner gagal:", error);
  } finally {
    isRunning = false;
  }
}

function validateConfig() {
  if (!cron.validate(CONFIG.cronSchedule)) {
    throw new Error(`CRON_SCHEDULE tidak valid: ${CONFIG.cronSchedule}`);
  }

  if (CONFIG.maxMarketRank < 1 || CONFIG.maxMarketRank > 5_000) {
    throw new Error("MAX_MARKET_RANK harus berada di antara 1 dan 5000.");
  }

  if (CONFIG.pageDelayMs < 0) {
    throw new Error("PAGE_DELAY_MS tidak boleh negatif.");
  }

  if (CONFIG.topLimit < 1 || CONFIG.topLimit > 100) {
    throw new Error("TOP_LIMIT harus berada di antara 1 dan 100.");
  }
}

async function main() {
  validateConfig();

  console.log("Crypto Top Gainer Scanner");
  console.log({
    schedule: CONFIG.cronSchedule,
    timezone: CONFIG.timezone,
    maxMarketRank: CONFIG.maxMarketRank,
    apiPages: Math.ceil(CONFIG.maxMarketRank / 250),
    topLimit: CONFIG.topLimit,
    minMarketCap: CONFIG.minMarketCap,
    minVolume: CONFIG.minVolume,
    alertScore: CONFIG.alertScore,
    telegramConfigured: Boolean(CONFIG.telegramToken && CONFIG.telegramChatId),
  });

  await runScanner();

  if (CONFIG.runOnce) {
    process.exit(0);
  }

  cron.schedule(
    CONFIG.cronSchedule,
    () => {
      runScanner().catch((error) => console.error(error));
    },
    { timezone: CONFIG.timezone },
  );

  console.log(`Scheduler aktif: ${CONFIG.cronSchedule} (${CONFIG.timezone})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
