/**
 * OpenChamber local service for the WakaTime panel.
 *
 * The panel runs in a sandboxed iframe that cannot reach the network, and the
 * host only attaches tokens the user pasted on an Integrations card. So this
 * process, which the OpenChamber host spawns from the extension folder, reads
 * the API key from ~/.wakatime.cfg itself, calls the WakaTime API, and answers
 * the panel over the host's loopback proxy. The key never leaves this process.
 *
 * Contract: packages/sdk/GUEST_SERVICES.md in the OpenChamber repository.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const API_ORIGIN = 'https://api.wakatime.com/api/v1';
const CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const RANKING_LIMIT = 8;

const RANGES = ['today', '7d', '30d'] as const;
type Range = (typeof RANGES)[number];
type ErrorCode = 'invalid-key' | 'rate-limited' | 'network' | 'api';

const RANGE_SPEC: Record<Range, { summary: string; stats: string | null }> = {
  today: { summary: 'Today', stats: null },
  '7d': { summary: 'Last 7 Days', stats: 'last_7_days' },
  '30d': { summary: 'Last 30 Days', stats: 'last_30_days' },
};

type ConfigState = {
  configured: boolean;
  reason?: 'no-file' | 'no-key';
  apiKey?: string;
  configPath: string;
};

type Metric = { seconds: number };
type Ranked = { name: string; seconds: number; percent: number };
type DayPoint = { date: string; seconds: number };
type AiModel = { name: string; lines: number; cost: number };
type AiSummary = {
  cost: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  additions: number;
  deletions: number;
  humanAdditions: number;
  humanDeletions: number;
  models: AiModel[];
};

type SummaryPayload = {
  configured: boolean;
  reason?: 'no-file' | 'no-key';
  configPath: string;
  range: Range;
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  error?: { code: ErrorCode | 'unexpected'; message: string };
  user?: {
    username: string | null;
    displayName: string;
    photo: string | null;
    timezone: string | null;
    lastProject: string | null;
    lastBranch: string | null;
  };
  total?: Metric;
  dailyAverage?: Metric;
  allTime?: { seconds: number; dailyAverageSeconds: number };
  bestDay?: { date: string; seconds: number };
  ai?: AiSummary | null;
  days?: DayPoint[];
  languages?: Ranked[];
  projects?: Ranked[];
  editors?: Ranked[];
  operatingSystems?: Ranked[];
};

class UpstreamError extends Error {
  code: ErrorCode;
  status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

const numberOr = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const stringOrNull = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value : null
);

/** The service env keeps HOME and USERPROFILE; os.homedir() covers the rest. */
const homeDirectory = (): string => {
  const fromEnv = process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : '');
  return fromEnv || os.homedir();
};

const resolveConfigPath = (): string => {
  const override = process.env.OPENCHAMBER_WAKATIME_CONFIG?.trim();
  return override && override.length > 0 ? override : path.join(homeDirectory(), '.wakatime.cfg');
};

/**
 * ~/.wakatime.cfg is INI-like. The key lives in [settings] as `api_key = ...`,
 * but reading every `api_key` line and keeping the last one tolerates the
 * variations different WakaTime plugins write.
 */
const readConfig = (): ConfigState => {
  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { configured: false, reason: 'no-file', configPath };
  }
  let apiKey = '';
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*api_?key\s*=\s*(.*)$/i.exec(line);
    if (match) apiKey = match[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!apiKey) return { configured: false, reason: 'no-key', configPath };
  return { configured: true, apiKey, configPath };
};

type UpstreamResult = { body: any; stale: boolean };

const upstream = async (
  apiKey: string,
  apiPath: string,
  query?: Record<string, string>,
): Promise<UpstreamResult> => {
  const url = new URL(`${API_ORIGIN}${apiPath}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey).toString('base64')}`,
        Accept: 'application/json',
        'User-Agent': 'openchamber-wakatime/1.0.0',
      },
      // WakaTime sometimes answers 302 instead of 429 when it throttles.
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpstreamError('network', `Could not reach WakaTime: ${detail}`, 502);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError('invalid-key', 'WakaTime rejected the stored API key.', 401);
  }
  if (response.status === 429 || (response.status >= 300 && response.status < 400)) {
    throw new UpstreamError('rate-limited', 'WakaTime is throttling this instance. Try again in a moment.', 429);
  }

  const text = await response.text();
  let body: any = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (response.status === 202) return { body, stale: true };
  if (response.status >= 400) {
    const errors = body?.errors;
    const message = Array.isArray(errors) && errors.length > 0
      ? errors.join(', ')
      : typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : `WakaTime answered HTTP ${response.status}.`;
    throw new UpstreamError('api', String(message), 500);
  }
  if (body === null) {
    throw new UpstreamError('api', 'WakaTime returned an unreadable response.', 500);
  }
  return { body, stale: false };
};

const settle = async (promise: Promise<UpstreamResult>): Promise<UpstreamResult | null> => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

const ranked = (items: unknown): Ranked[] => (
  Array.isArray(items)
    ? items
      .filter((item: any) => item && typeof item.name === 'string' && item.name.trim().length > 0)
      .slice(0, RANKING_LIMIT)
      .map((item: any) => ({
        name: String(item.name),
        seconds: numberOr(item.total_seconds, 0),
        percent: numberOr(item.percent, 0),
      }))
    : []
);

/** Fallback when the stats endpoint is unavailable: sum the daily rankings. */
const aggregateRanked = (days: any[], field: string): Ranked[] => {
  const totals = new Map<string, number>();
  for (const day of days) {
    const items = day?.[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      totals.set(name, (totals.get(name) ?? 0) + numberOr(item.total_seconds, 0));
    }
  }
  const sum = Array.from(totals.values()).reduce((total, value) => total + value, 0);
  return Array.from(totals.entries())
    .map(([name, seconds]) => ({ name, seconds, percent: sum > 0 ? (seconds / sum) * 100 : 0 }))
    .sort((left, right) => right.seconds - left.seconds)
    .slice(0, RANKING_LIMIT);
};

const buildAi = (source: any): AiSummary | null => {
  if (!source || typeof source !== 'object') return null;
  const cost = numberOr(source.ai_model_total_cost, 0);
  const additions = numberOr(source.ai_additions, 0);
  const deletions = numberOr(source.ai_deletions, 0);
  const humanAdditions = numberOr(source.human_additions, 0);
  const humanDeletions = numberOr(source.human_deletions, 0);
  const inputTokens = numberOr(source.ai_input_tokens, 0);
  const outputTokens = numberOr(source.ai_output_tokens, 0);
  const cachedInputTokens = numberOr(source.ai_cached_input_tokens, 0);

  const models: AiModel[] = [];
  if (Array.isArray(source.ai_model_breakdown)) {
    for (const model of source.ai_model_breakdown) {
      models.push({
        name: String(model?.name ?? 'Unknown'),
        lines: numberOr(model?.lines, 0),
        cost: numberOr(model?.cost, 0),
      });
    }
  } else {
    const costs = source.ai_model_costs && typeof source.ai_model_costs === 'object' ? source.ai_model_costs : {};
    const lines = source.ai_model_line_changes && typeof source.ai_model_line_changes === 'object'
      ? source.ai_model_line_changes
      : {};
    for (const name of new Set([...Object.keys(costs), ...Object.keys(lines)])) {
      models.push({ name, lines: numberOr(lines[name], 0), cost: numberOr(costs[name], 0) });
    }
  }
  models.sort((left, right) => right.cost - left.cost);

  const active = cost > 0 || additions > 0 || deletions > 0 || inputTokens > 0 || outputTokens > 0 || models.length > 0;
  if (!active) return null;
  return { cost, inputTokens, cachedInputTokens, outputTokens, additions, deletions, humanAdditions, humanDeletions, models };
};

/** Fallback when the stats endpoint is stale: sum the daily AI figures. */
const aggregateAi = (days: any[]): AiSummary | null => {
  let cost = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let additions = 0;
  let deletions = 0;
  let humanAdditions = 0;
  let humanDeletions = 0;
  const costs = new Map<string, number>();
  const lines = new Map<string, number>();

  for (const day of days) {
    const grand = day?.grand_total;
    if (!grand) continue;
    cost += numberOr(grand.ai_model_total_cost, 0);
    inputTokens += numberOr(grand.ai_input_tokens, 0);
    cachedInputTokens += numberOr(grand.ai_cached_input_tokens, 0);
    outputTokens += numberOr(grand.ai_output_tokens, 0);
    additions += numberOr(grand.ai_additions, 0);
    deletions += numberOr(grand.ai_deletions, 0);
    humanAdditions += numberOr(grand.human_additions, 0);
    humanDeletions += numberOr(grand.human_deletions, 0);
    const dayCosts = grand.ai_model_costs;
    if (dayCosts && typeof dayCosts === 'object') {
      for (const [name, value] of Object.entries(dayCosts)) {
        costs.set(name, (costs.get(name) ?? 0) + numberOr(value, 0));
      }
    }
    const dayLines = grand.ai_model_line_changes;
    if (dayLines && typeof dayLines === 'object') {
      for (const [name, value] of Object.entries(dayLines)) {
        lines.set(name, (lines.get(name) ?? 0) + numberOr(value, 0));
      }
    }
  }

  const models: AiModel[] = Array.from(new Set([...costs.keys(), ...lines.keys()]))
    .map((name) => ({ name, lines: lines.get(name) ?? 0, cost: costs.get(name) ?? 0 }));
  models.sort((left, right) => right.cost - left.cost);

  const active = cost > 0 || additions > 0 || deletions > 0 || inputTokens > 0 || outputTokens > 0 || models.length > 0;
  if (!active) return null;
  return { cost, inputTokens, cachedInputTokens, outputTokens, additions, deletions, humanAdditions, humanDeletions, models };
};

/** Use the range aggregate from stats, or rebuild it from the daily summaries. */
const rankingFor = (statItems: unknown, days: any[], field: string): Ranked[] => {
  const fromStats = ranked(statItems);
  return fromStats.length > 0 ? fromStats : aggregateRanked(days, field);
};

const buildSummary = async (range: Range, apiKey: string, configPath: string): Promise<SummaryPayload> => {
  const spec = RANGE_SPEC[range];

  // The user call validates the key, so its errors are not swallowed.
  const [userResult, summaryResult, statsResult, allTimeResult] = await Promise.all([
    upstream(apiKey, '/users/current'),
    settle(upstream(apiKey, '/users/current/summaries', { range: spec.summary })),
    spec.stats ? settle(upstream(apiKey, `/users/current/stats/${spec.stats}`)) : Promise.resolve(null),
    settle(upstream(apiKey, '/users/current/all_time_since_today')),
  ]);

  const userRaw = userResult.body?.data ?? null;
  const daysRaw: any[] = Array.isArray(summaryResult?.body?.data) ? summaryResult.body.data : [];
  const stats = statsResult?.body?.data ?? null;
  const allTimeRaw = allTimeResult?.body?.data ?? null;

  const days: DayPoint[] = daysRaw
    .map((day: any) => ({ date: String(day?.range?.date ?? ''), seconds: numberOr(day?.grand_total?.total_seconds, 0) }))
    .filter((day) => day.date.length > 0);

  const summedSeconds = days.reduce((total, day) => total + day.seconds, 0);
  const totalSeconds = stats ? numberOr(stats.total_seconds, summedSeconds) : summedSeconds;
  const dailyAverageSeconds = stats
    ? numberOr(stats.daily_average, 0)
    : days.length > 0
      ? summedSeconds / days.length
      : totalSeconds;

  const bestDaySource = stats?.best_day ?? null;
  const bestDaySeconds = bestDaySource
    ? numberOr(bestDaySource.total_seconds, 0)
    : days.reduce((best, day) => Math.max(best, day.seconds), 0);
  const bestDayDate = bestDaySource
    ? String(bestDaySource.date ?? '')
    : (days.find((day) => day.seconds === bestDaySeconds)?.date ?? '');
  const bestDay = bestDaySeconds > 0 && bestDayDate
    ? { date: bestDayDate, seconds: bestDaySeconds }
    : undefined;

  const stale = Boolean(summaryResult?.stale)
    || Boolean(statsResult?.stale)
    || stats?.is_up_to_date === false;

  return {
    configured: true,
    configPath,
    range,
    fetchedAt: new Date().toISOString(),
    cached: false,
    stale,
    user: userRaw
      ? {
        username: stringOrNull(userRaw.username),
        displayName: String(userRaw.display_name ?? userRaw.full_name ?? userRaw.username ?? 'WakaTime'),
        photo: stringOrNull(userRaw.photo),
        timezone: stringOrNull(userRaw.timezone),
        lastProject: stringOrNull(userRaw.last_project),
        lastBranch: stringOrNull(userRaw.last_branch),
      }
      : undefined,
    total: { seconds: totalSeconds },
    dailyAverage: { seconds: dailyAverageSeconds },
    allTime: allTimeRaw
      ? {
        seconds: numberOr(allTimeRaw.total_seconds, 0),
        dailyAverageSeconds: numberOr(allTimeRaw.daily_average, 0),
      }
      : undefined,
    bestDay,
    ai: buildAi(stats) ?? aggregateAi(daysRaw),
    days,
    languages: rankingFor(stats?.languages, daysRaw, 'languages'),
    projects: rankingFor(stats?.projects, daysRaw, 'projects'),
    editors: rankingFor(stats?.editors, daysRaw, 'editors'),
    operatingSystems: rankingFor(stats?.operating_systems, daysRaw, 'operating_systems'),
  };
};

const cache = new Map<Range, { at: number; payload: SummaryPayload }>();

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const parseRange = (value: string | null): Range => (
  value && (RANGES as readonly string[]).includes(value) ? (value as Range) : '7d'
);

const handleSummary = async (url: URL, response: http.ServerResponse): Promise<void> => {
  const range = parseRange(url.searchParams.get('range'));
  const refresh = url.searchParams.get('refresh') === '1';
  const config = readConfig();
  const fetchedAt = new Date().toISOString();

  if (!config.configured) {
    json(response, 200, {
      configured: false,
      reason: config.reason ?? 'no-file',
      configPath: config.configPath,
      range,
      fetchedAt,
      cached: false,
      stale: false,
    } satisfies SummaryPayload);
    return;
  }

  const hit = cache.get(range);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    json(response, 200, { ...hit.payload, cached: true, fetchedAt });
    return;
  }

  try {
    const payload = await buildSummary(range, config.apiKey ?? '', config.configPath);
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
        error: { code: error.code, message: error.message },
      } satisfies SummaryPayload);
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
      error: { code: 'unexpected', message: detail },
    } satisfies SummaryPayload);
  }
};

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: { code: 'unauthorized', message: 'unauthorized' } });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(response, 200, { ok: true });
    return;
  }
  if (url.pathname === '/summary') {
    void handleSummary(url, response);
    return;
  }
  json(response, 404, { error: { code: 'not-found', message: 'not-found' } });
});

server.listen(port, '127.0.0.1');
