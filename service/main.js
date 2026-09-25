// service/main.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var API_ORIGIN = "https://api.wakatime.com/api/v1";
var CACHE_TTL_MS = 60000;
var UPSTREAM_TIMEOUT_MS = 12000;
var RANKING_LIMIT = 8;
var RANGES = ["today", "7d", "30d"];
var RANGE_SPEC = {
  today: { summary: "Today", stats: null },
  "7d": { summary: "Last 7 Days", stats: "last_7_days" },
  "30d": { summary: "Last 30 Days", stats: "last_30_days" }
};

class UpstreamError extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
  }
}
var numberOr = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
var stringOrNull = (value) => typeof value === "string" && value.trim().length > 0 ? value : null;
var homeDirectory = () => {
  const fromEnv = process.env.HOME || process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : "");
  return fromEnv || os.homedir();
};
var resolveConfigPath = () => {
  const override = process.env.OPENCHAMBER_WAKATIME_CONFIG?.trim();
  return override && override.length > 0 ? override : path.join(homeDirectory(), ".wakatime.cfg");
};
var readConfig = () => {
  const configPath = resolveConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { configured: false, reason: "no-file", configPath };
  }
  let apiKey = "";
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*api_?key\s*=\s*(.*)$/i.exec(line);
    if (match)
      apiKey = match[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!apiKey)
    return { configured: false, reason: "no-key", configPath };
  return { configured: true, apiKey, configPath };
};
var upstream = async (apiKey, apiPath, query) => {
  const url = new URL(`${API_ORIGIN}${apiPath}`);
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`,
        Accept: "application/json",
        "User-Agent": "openchamber-wakatime/1.0.0"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpstreamError("network", `Could not reach WakaTime: ${detail}`, 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError("invalid-key", "WakaTime rejected the stored API key.", 401);
  }
  if (response.status === 429 || response.status >= 300 && response.status < 400) {
    throw new UpstreamError("rate-limited", "WakaTime is throttling this instance. Try again in a moment.", 429);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.status === 202)
    return { body, stale: true };
  if (response.status >= 400) {
    const errors = body?.errors;
    const message = Array.isArray(errors) && errors.length > 0 ? errors.join(", ") : typeof body?.error === "string" && body.error.length > 0 ? body.error : `WakaTime answered HTTP ${response.status}.`;
    throw new UpstreamError("api", String(message), 500);
  }
  if (body === null) {
    throw new UpstreamError("api", "WakaTime returned an unreadable response.", 500);
  }
  return { body, stale: false };
};
var settle = async (promise) => {
  try {
    return await promise;
  } catch {
    return null;
  }
};
var ranked = (items) => Array.isArray(items) ? items.filter((item) => item && typeof item.name === "string" && item.name.trim().length > 0).slice(0, RANKING_LIMIT).map((item) => ({
  name: String(item.name),
  seconds: numberOr(item.total_seconds, 0),
  percent: numberOr(item.percent, 0)
})) : [];
var aggregateRanked = (days, field) => {
  const totals = new Map;
  for (const day of days) {
    const items = day?.[field];
    if (!Array.isArray(items))
      continue;
    for (const item of items) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name)
        continue;
      totals.set(name, (totals.get(name) ?? 0) + numberOr(item.total_seconds, 0));
    }
  }
  const sum = Array.from(totals.values()).reduce((total, value) => total + value, 0);
  return Array.from(totals.entries()).map(([name, seconds]) => ({ name, seconds, percent: sum > 0 ? seconds / sum * 100 : 0 })).sort((left, right) => right.seconds - left.seconds).slice(0, RANKING_LIMIT);
};
var sumLineChanges = (days) => {
  let ai = 0;
  let human = 0;
  for (const day of days) {
    const grand = day?.grand_total;
    if (!grand)
      continue;
    ai += numberOr(grand.ai_additions, 0) + numberOr(grand.ai_deletions, 0);
    human += numberOr(grand.human_additions, 0) + numberOr(grand.human_deletions, 0);
  }
  const total = ai + human;
  return { ai, human, share: total > 0 ? ai / total * 100 : 0 };
};
var aggregateCategories = (days) => {
  const totals = new Map;
  for (const day of days) {
    const items = day?.categories;
    if (!Array.isArray(items))
      continue;
    for (const item of items) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name)
        continue;
      totals.set(name, (totals.get(name) ?? 0) + numberOr(item.total_seconds, 0));
    }
  }
  const sum = Array.from(totals.values()).reduce((total, value) => total + value, 0);
  return Array.from(totals.entries()).map(([name, seconds]) => ({ name, seconds, percent: sum > 0 ? seconds / sum * 100 : 0 })).sort((left, right) => right.seconds - left.seconds);
};
var categorySeconds = (categories, name) => categories.find((entry) => entry.name.toLowerCase() === name)?.seconds ?? 0;
var modelsFromMaps = (costs, lines) => {
  const models = Array.from(new Set([...costs.keys(), ...lines.keys()])).map((name) => ({ name, lines: lines.get(name) ?? 0, cost: costs.get(name) ?? 0 }));
  models.sort((left, right) => right.cost - left.cost);
  return models;
};
var modelsFromSource = (source) => {
  if (Array.isArray(source?.ai_model_breakdown)) {
    const models = source.ai_model_breakdown.map((model) => ({
      name: String(model?.name ?? "Unknown"),
      lines: numberOr(model?.lines, 0),
      cost: numberOr(model?.cost, 0)
    }));
    models.sort((left, right) => right.cost - left.cost);
    return models;
  }
  const costs = new Map;
  const lines = new Map;
  const costMap = source?.ai_model_costs && typeof source.ai_model_costs === "object" ? source.ai_model_costs : {};
  const lineMap = source?.ai_model_line_changes && typeof source.ai_model_line_changes === "object" ? source.ai_model_line_changes : {};
  for (const [name, value] of Object.entries(costMap))
    costs.set(name, numberOr(value, 0));
  for (const [name, value] of Object.entries(lineMap))
    lines.set(name, numberOr(value, 0));
  return modelsFromMaps(costs, lines);
};
var buildAi = (source) => {
  if (!source || typeof source !== "object")
    return null;
  const models = modelsFromSource(source);
  const cost = numberOr(source.ai_model_total_cost, 0);
  const inputTokens = numberOr(source.ai_input_tokens, 0);
  const outputTokens = numberOr(source.ai_output_tokens, 0);
  const cachedInputTokens = numberOr(source.ai_cached_input_tokens, 0);
  const sessions = numberOr(source.ai_sessions, 0);
  const promptEvents = numberOr(source.ai_prompt_events_total, 0);
  const active = cost > 0 || inputTokens > 0 || outputTokens > 0 || sessions > 0 || models.length > 0;
  if (!active)
    return null;
  return {
    cost,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    sessions,
    promptEvents,
    aiCodingSeconds: 0,
    codingSeconds: 0,
    models
  };
};
var aggregateAi = (days) => {
  let cost = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let sessions = 0;
  let promptEvents = 0;
  const costs = new Map;
  const lines = new Map;
  for (const day of days) {
    const grand = day?.grand_total;
    if (!grand)
      continue;
    cost += numberOr(grand.ai_model_total_cost, 0);
    inputTokens += numberOr(grand.ai_input_tokens, 0);
    cachedInputTokens += numberOr(grand.ai_cached_input_tokens, 0);
    outputTokens += numberOr(grand.ai_output_tokens, 0);
    sessions += numberOr(grand.ai_sessions, 0);
    promptEvents += numberOr(grand.ai_prompt_events_total, 0);
    const dayCosts = grand.ai_model_costs;
    if (dayCosts && typeof dayCosts === "object") {
      for (const [name, value] of Object.entries(dayCosts)) {
        costs.set(name, (costs.get(name) ?? 0) + numberOr(value, 0));
      }
    }
    const dayLines = grand.ai_model_line_changes;
    if (dayLines && typeof dayLines === "object") {
      for (const [name, value] of Object.entries(dayLines)) {
        lines.set(name, (lines.get(name) ?? 0) + numberOr(value, 0));
      }
    }
  }
  const models = modelsFromMaps(costs, lines);
  const active = cost > 0 || inputTokens > 0 || outputTokens > 0 || sessions > 0 || models.length > 0;
  if (!active)
    return null;
  return {
    cost,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    sessions,
    promptEvents,
    aiCodingSeconds: 0,
    codingSeconds: 0,
    models
  };
};
var rankingFor = (statItems, days, field) => {
  const fromStats = ranked(statItems);
  return fromStats.length > 0 ? fromStats : aggregateRanked(days, field);
};
var buildSummary = async (range, apiKey, configPath) => {
  const spec = RANGE_SPEC[range];
  const [userResult, summaryResult, statsResult, allTimeResult] = await Promise.all([
    upstream(apiKey, "/users/current"),
    settle(upstream(apiKey, "/users/current/summaries", { range: spec.summary })),
    spec.stats ? settle(upstream(apiKey, `/users/current/stats/${spec.stats}`)) : Promise.resolve(null),
    settle(upstream(apiKey, "/users/current/all_time_since_today"))
  ]);
  const userRaw = userResult.body?.data ?? null;
  const daysRaw = Array.isArray(summaryResult?.body?.data) ? summaryResult.body.data : [];
  const stats = statsResult?.body?.data ?? null;
  const allTimeRaw = allTimeResult?.body?.data ?? null;
  const days = daysRaw.map((day) => ({ date: String(day?.range?.date ?? ""), seconds: numberOr(day?.grand_total?.total_seconds, 0) })).filter((day) => day.date.length > 0);
  const summedSeconds = days.reduce((total, day) => total + day.seconds, 0);
  const totalSeconds = stats ? numberOr(stats.total_seconds, summedSeconds) : summedSeconds;
  const dailyAverageSeconds = stats ? numberOr(stats.daily_average, 0) : days.length > 0 ? summedSeconds / days.length : totalSeconds;
  const bestDaySource = stats?.best_day ?? null;
  const bestDaySeconds = bestDaySource ? numberOr(bestDaySource.total_seconds, 0) : days.reduce((best, day) => Math.max(best, day.seconds), 0);
  const bestDayDate = bestDaySource ? String(bestDaySource.date ?? "") : days.find((day) => day.seconds === bestDaySeconds)?.date ?? "";
  const bestDay = bestDaySeconds > 0 && bestDayDate ? { date: bestDayDate, seconds: bestDaySeconds } : undefined;
  const stale = Boolean(summaryResult?.stale) || Boolean(statsResult?.stale) || stats?.is_up_to_date === false;
  const categories = aggregateCategories(daysRaw);
  const aiBase = buildAi(stats) ?? aggregateAi(daysRaw);
  const aiCodingSeconds = categorySeconds(categories, "ai coding");
  const codingSeconds = categorySeconds(categories, "coding");
  const ai = aiBase ? { ...aiBase, aiCodingSeconds, codingSeconds } : aiCodingSeconds + codingSeconds > 0 ? {
    cost: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    sessions: 0,
    promptEvents: 0,
    aiCodingSeconds,
    codingSeconds,
    models: []
  } : null;
  return {
    configured: true,
    configPath,
    range,
    fetchedAt: new Date().toISOString(),
    cached: false,
    stale,
    user: userRaw ? {
      username: stringOrNull(userRaw.username),
      displayName: String(userRaw.display_name ?? userRaw.full_name ?? userRaw.username ?? "WakaTime"),
      photo: stringOrNull(userRaw.photo),
      timezone: stringOrNull(userRaw.timezone),
      lastProject: stringOrNull(userRaw.last_project),
      lastBranch: stringOrNull(userRaw.last_branch)
    } : undefined,
    total: { seconds: totalSeconds },
    dailyAverage: { seconds: dailyAverageSeconds },
    allTime: allTimeRaw ? {
      seconds: numberOr(allTimeRaw.total_seconds, 0),
      dailyAverageSeconds: numberOr(allTimeRaw.daily_average, 0)
    } : undefined,
    bestDay,
    lines: sumLineChanges(daysRaw),
    ai,
    days,
    languages: rankingFor(stats?.languages, daysRaw, "languages"),
    projects: rankingFor(stats?.projects, daysRaw, "projects"),
    editors: rankingFor(stats?.editors, daysRaw, "editors"),
    operatingSystems: rankingFor(stats?.operating_systems, daysRaw, "operating_systems")
  };
};
var cache = new Map;
var json = (response, status, body) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
};
var parseRange = (value) => value && RANGES.includes(value) ? value : "7d";
var handleSummary = async (url, response) => {
  const range = parseRange(url.searchParams.get("range"));
  const refresh = url.searchParams.get("refresh") === "1";
  const config = readConfig();
  const fetchedAt = new Date().toISOString();
  if (!config.configured) {
    json(response, 200, {
      configured: false,
      reason: config.reason ?? "no-file",
      configPath: config.configPath,
      range,
      fetchedAt,
      cached: false,
      stale: false
    });
    return;
  }
  const hit = cache.get(range);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    json(response, 200, { ...hit.payload, cached: true, fetchedAt });
    return;
  }
  try {
    const payload = await buildSummary(range, config.apiKey ?? "", config.configPath);
    cache.set(range, { at: Date.now(), payload });
    json(response, 200, payload);
  } catch (error) {
    if (error instanceof UpstreamError) {
      json(response, error.status, {
        configured: true,
        configPath: config.configPath,
        range,
        fetchedAt,
        cached: false,
        stale: false,
        error: { code: error.code, message: error.message }
      });
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    json(response, 500, {
      configured: true,
      configPath: config.configPath,
      range,
      fetchedAt,
      cached: false,
      stale: false,
      error: { code: "unexpected", message: detail }
    });
  }
};
var server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: { code: "unauthorized", message: "unauthorized" } });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/summary") {
    handleSummary(url, response);
    return;
  }
  json(response, 404, { error: { code: "not-found", message: "not-found" } });
});
server.listen(port, "127.0.0.1");
