/**
 * WakaTime rail panel for OpenChamber.
 *
 * The panel itself never touches the disk or the network. It asks the
 * extension's local service for a normalized summary through `serviceRequest`,
 * and the service reads ~/.wakatime.cfg and calls the WakaTime API.
 */
import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountSpinner,
  mountTabs,
  type Tone,
} from '@openchamber/sdk/ui';

type Range = 'today' | '7d' | '30d';

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
  error?: { code: string; message: string };
  user?: {
    username: string | null;
    displayName: string;
    photo: string | null;
    timezone: string | null;
    lastProject: string | null;
    lastBranch: string | null;
  };
  total?: { seconds: number };
  dailyAverage?: { seconds: number };
  allTime?: { seconds: number; dailyAverageSeconds: number };
  bestDay?: { date: string; seconds: number };
  ai?: AiSummary | null;
  days?: DayPoint[];
  languages?: Ranked[];
  projects?: Ranked[];
  editors?: Ranked[];
  operatingSystems?: Ranked[];
};

type Disposable = { dispose: () => void };
type ViewState =
  | { kind: 'loading' }
  | { kind: 'host-error'; message: string }
  | { kind: 'api-error'; payload: SummaryPayload }
  | { kind: 'not-configured'; payload: SummaryPayload }
  | { kind: 'data'; payload: SummaryPayload };

const DASHBOARD_URL = 'https://wakatime.com/dashboard';
const API_KEY_URL = 'https://wakatime.com/api-key';
const REFRESH_MS = 5 * 60 * 1000;

const EN: Record<string, string> = {
  refresh: 'Refresh',
  rangeToday: 'Today',
  range7d: '7 days',
  range30d: '30 days',
  loading: 'Loading WakaTime',
  total: 'Total',
  dailyAverage: 'Daily average',
  allTime: 'All time',
  allTimePerDay: '{value} per day',
  bestDay: 'Best day',
  dailyActivity: 'Daily activity',
  workingOn: 'Working on',
  current: 'current',
  languages: 'Languages',
  projects: 'Projects',
  editors: 'Editors',
  operatingSystems: 'Operating systems',
  ai: 'AI coding',
  aiCost: 'Cost',
  aiTokens: 'Tokens',
  aiTokensDetail: 'in {input} · out {output}',
  aiCachedTokens: 'Cached input',
  aiLines: 'AI lines',
  aiLinesDetail: 'human {human}',
  aiModels: 'Models',
  aiNoActivity: 'No AI activity in this range.',
  stale: 'WakaTime is still aggregating this range, so the numbers can change.',
  cachedNote: 'cached',
  updated: 'Updated',
  openDashboard: 'Open wakatime.com',
  notConfiguredTitle: 'WakaTime is not connected',
  notConfiguredFile: 'No config file was found at {path} on the OpenChamber server. Install a WakaTime plugin, or create that file with an api_key in the [settings] section.',
  notConfiguredKey: 'The config at {path} has no api_key. Add one to the [settings] section.',
  getApiKey: 'Get an API key',
  invalidKeyTitle: 'WakaTime rejected the API key',
  invalidKeyBody: 'Check api_key in {path}, or issue a new key and update the file.',
  rateLimitedTitle: 'WakaTime is throttling requests',
  networkTitle: 'Could not reach WakaTime',
  apiErrorTitle: 'WakaTime answered with an error',
  serviceTitle: 'Could not reach the WakaTime service',
  retry: 'Try again',
  noActivity: 'No activity in this range.',
};

const KO: Record<string, string> = {
  refresh: '새로고침',
  rangeToday: '오늘',
  range7d: '7일',
  range30d: '30일',
  loading: 'WakaTime 불러오는 중',
  total: '누적',
  dailyAverage: '일 평균',
  allTime: '전체 누적',
  allTimePerDay: '하루 평균 {value}',
  bestDay: '최고 기록일',
  dailyActivity: '일별 활동',
  workingOn: '작업 중',
  current: '현재',
  languages: '언어',
  projects: '프로젝트',
  editors: '에디터',
  operatingSystems: '운영체제',
  ai: 'AI 코딩',
  aiCost: '비용',
  aiTokens: '토큰',
  aiTokensDetail: '입력 {input} · 출력 {output}',
  aiCachedTokens: '캐시 입력',
  aiLines: 'AI 라인',
  aiLinesDetail: '사람 {human}',
  aiModels: '모델',
  aiNoActivity: '이 기간에 AI 활동이 없습니다.',
  stale: 'WakaTime이 아직 이 기간을 집계 중이라 값이 바뀔 수 있습니다.',
  cachedNote: '캐시됨',
  updated: '갱신',
  openDashboard: 'wakatime.com 열기',
  notConfiguredTitle: 'WakaTime이 연결되지 않았습니다',
  notConfiguredFile: 'OpenChamber 서버의 {path}에서 설정 파일을 찾지 못했습니다. WakaTime 플러그인을 설치하거나, [settings] 섹션에 api_key를 넣어 파일을 만들어 주세요.',
  notConfiguredKey: '{path}에 api_key가 없습니다. [settings] 섹션에 추가해 주세요.',
  getApiKey: 'API 키 발급받기',
  invalidKeyTitle: 'WakaTime이 API 키를 거부했습니다',
  invalidKeyBody: '{path}의 api_key를 확인하거나, 새 키를 발급해 파일을 갱신해 주세요.',
  rateLimitedTitle: 'WakaTime이 요청을 제한하고 있습니다',
  networkTitle: 'WakaTime에 연결하지 못했습니다',
  apiErrorTitle: 'WakaTime이 오류를 반환했습니다',
  serviceTitle: 'WakaTime 서비스에 연결하지 못했습니다',
  retry: '다시 시도',
  noActivity: '이 기간에 활동이 없습니다.',
};

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let locale = 'en';
let directory: string | null = null;
let range: Range = '7d';
let shellBuilt = false;
let view: ViewState = { kind: 'loading' };
let generation = 0;
let loading = false;
const blocks: Disposable[] = [];

let bodyRoot: HTMLElement;
let identityBox: HTMLElement;
let footerNote: HTMLElement;
let tabs: ReturnType<typeof mountTabs>;
let refreshButton: ReturnType<typeof mountButton>;
let footerButton: ReturnType<typeof mountButton>;

/* ---------------------------------------------------------------- helpers */

const t = (key: string, vars?: Record<string, string>): string => {
  const dictionary = locale.startsWith('ko') ? KO : EN;
  const template = dictionary[key] ?? EN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '');
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const duration = (seconds?: number): string => {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const isKo = locale.startsWith('ko');
  if (hours > 0) return isKo ? `${hours}시간 ${minutes}분` : `${hours}h ${minutes}m`;
  if (minutes > 0) return isKo ? `${minutes}분` : `${minutes}m`;
  return isKo ? `${total}초` : `${total}s`;
};

const digital = (seconds?: number): string => {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}`;
};

const compact = (value: number): string => (
  Number.isFinite(value)
    ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : '0'
);

const money = (value: number): string => new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
}).format(Number.isFinite(value) ? value : 0);

const parseDate = (date: string): Date | null => {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDay = (date: string): string => {
  const parsed = parseDate(date);
  return parsed ? parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', weekday: 'short' }) : date;
};

const formatDayShort = (date: string): string => {
  const parsed = parseDate(date);
  return parsed ? parsed.toLocaleDateString(locale, { day: 'numeric' }) : '';
};

const formatTime = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
};

const projectNameFromDirectory = (dir: string | null): string | null => {
  if (!dir) return null;
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]+/);
  const name = parts[parts.length - 1] ?? '';
  return name.length > 0 ? name : null;
};

const findCurrentProject = (projects: Ranked[] | undefined, dir: string | null): Ranked | null => {
  const name = projectNameFromDirectory(dir);
  if (!name || !projects || projects.length === 0) return null;
  const target = name.toLowerCase();
  return projects.find((project) => project.name.toLowerCase() === target)
    ?? projects.find((project) => {
      const candidate = project.name.toLowerCase();
      if (candidate.length < 3) return false;
      return candidate.includes(target) || target.includes(candidate);
    })
    ?? null;
};

/* ------------------------------------------------------------ UI building */

const clearBody = (): void => {
  for (const block of blocks.splice(0)) block.dispose();
  bodyRoot.replaceChildren();
};

const metricCard = (label: string, value: string, sub?: string): HTMLElement => {
  const card = el('div', 'wt-card');
  card.append(el('div', 'wt-card-label', label), el('div', 'wt-card-value', value));
  if (sub) card.append(el('div', 'wt-card-sub', sub));
  return card;
};

const sectionShell = (title: string): HTMLElement => {
  const section = el('section', 'wt-section');
  section.append(el('h3', 'wt-section-title', title));
  return section;
};

const rankingSection = (title: string, items: Ranked[], currentName: string | null): HTMLElement => {
  const section = sectionShell(title);
  const listRoot = el('div');
  section.append(listRoot);
  blocks.push(mountList(listRoot, {
    ariaLabel: title,
    items: items.map((item) => {
      const isCurrent = currentName !== null && item.name.toLowerCase() === currentName.toLowerCase();
      return {
        id: item.name,
        title: item.name,
        subtitle: isCurrent ? t('current') : undefined,
        badge: { label: `${Math.round(item.percent)}%`, tone: (isCurrent ? 'primary' : 'neutral') as Tone },
        meta: duration(item.seconds),
      };
    }),
    onSelect: () => {},
  }));
  return section;
};

const chartSection = (days: DayPoint[]): HTMLElement => {
  const section = sectionShell(t('dailyActivity'));
  if (days.length === 0) {
    section.append(el('p', 'wt-note', t('noActivity')));
    return section;
  }
  const max = Math.max(1, ...days.map((day) => day.seconds));
  const showLabels = days.length <= 10;
  const chart = el('div', 'wt-chart');
  for (const day of days) {
    const column = el('div', 'wt-bar-col');
    const track = el('div', 'wt-bar-track');
    const bar = el('div', 'wt-bar');
    const ratio = day.seconds > 0 ? Math.max(0.03, day.seconds / max) : 0.015;
    bar.style.height = `${Math.round(ratio * 100)}%`;
    bar.dataset.empty = day.seconds > 0 ? 'false' : 'true';
    bar.title = `${formatDay(day.date)} · ${duration(day.seconds)}`;
    track.append(bar);
    column.append(track, el('span', 'wt-bar-label', showLabels ? formatDayShort(day.date) : ''));
    chart.append(column);
  }
  section.append(chart);
  return section;
};

const aiSection = (ai: AiSummary | null | undefined): HTMLElement => {
  const section = sectionShell(t('ai'));
  if (!ai) {
    section.append(el('p', 'wt-note', t('aiNoActivity')));
    return section;
  }
  const metrics = el('div', 'wt-metrics');
  metrics.append(
    metricCard(t('aiCost'), money(ai.cost), ai.models.length > 0 ? `${ai.models.length} ${t('aiModels')}` : undefined),
    metricCard(t('aiTokens'), compact(ai.inputTokens + ai.outputTokens), t('aiTokensDetail', {
      input: compact(ai.inputTokens),
      output: compact(ai.outputTokens),
    })),
    metricCard(t('aiCachedTokens'), compact(ai.cachedInputTokens)),
    metricCard(
      t('aiLines'),
      `+${ai.additions} / -${ai.deletions}`,
      t('aiLinesDetail', { human: `+${ai.humanAdditions} / -${ai.humanDeletions}` }),
    ),
  );
  section.append(metrics);
  if (ai.models.length > 0) {
    const listRoot = el('div');
    section.append(listRoot);
    blocks.push(mountList(listRoot, {
      ariaLabel: t('aiModels'),
      items: ai.models.slice(0, 6).map((model) => ({
        id: model.name,
        title: model.name,
        meta: money(model.cost),
        badge: model.lines !== 0 ? { label: String(model.lines), tone: 'neutral' as Tone } : undefined,
      })),
      onSelect: () => {},
    }));
  }
  return section;
};

const dataView = (payload: SummaryPayload): void => {
  if (payload.stale) {
    blocks.push(mountBanner(bodyRoot, { tone: 'warning', title: t('stale') }));
  }

  const metrics = el('div', 'wt-metrics');
  metrics.append(
    metricCard(t('total'), duration(payload.total?.seconds), digital(payload.total?.seconds)),
    metricCard(t('dailyAverage'), duration(payload.dailyAverage?.seconds)),
  );
  if (payload.allTime) {
    metrics.append(metricCard(
      t('allTime'),
      duration(payload.allTime.seconds),
      t('allTimePerDay', { value: duration(payload.allTime.dailyAverageSeconds) }),
    ));
  }
  if (payload.bestDay) {
    metrics.append(metricCard(t('bestDay'), duration(payload.bestDay.seconds), formatDay(payload.bestDay.date)));
  }
  bodyRoot.append(metrics);

  const currentName = findCurrentProject(payload.projects, directory)?.name ?? null;
  const current = currentName ? (payload.projects ?? []).find((project) => project.name === currentName) : null;
  if (current) {
    const box = el('div', 'wt-current');
    box.append(el('span', 'wt-current-label', t('workingOn')));
    box.append(el('span', 'wt-current-name', current.name));
    box.append(el('span', 'wt-current-time', duration(current.seconds)));
    if (payload.user?.lastBranch) box.append(el('span', 'wt-current-branch', payload.user.lastBranch));
    bodyRoot.append(box);
  }

  bodyRoot.append(chartSection(payload.days ?? []));

  if ((payload.languages ?? []).length > 0) {
    bodyRoot.append(rankingSection(t('languages'), payload.languages ?? [], null));
  }
  if ((payload.projects ?? []).length > 0) {
    bodyRoot.append(rankingSection(t('projects'), payload.projects ?? [], currentName));
  }
  if ((payload.editors ?? []).length > 0) {
    bodyRoot.append(rankingSection(t('editors'), payload.editors ?? [], null));
  }
  if ((payload.operatingSystems ?? []).length > 0) {
    bodyRoot.append(rankingSection(t('operatingSystems'), payload.operatingSystems ?? [], null));
  }

  bodyRoot.append(aiSection(payload.ai));
};

const paintIdentity = (payload: SummaryPayload | null): void => {
  const user = payload?.user;
  if (!user) {
    identityBox.textContent = '';
    identityBox.removeAttribute('title');
    return;
  }
  const parts = [user.displayName];
  if (user.timezone) parts.push(user.timezone);
  identityBox.textContent = parts.join(' · ');
  identityBox.title = identityBox.textContent;
};

const paintFooter = (): void => {
  const payload = view.kind === 'loading' || view.kind === 'host-error' ? null : view.payload;
  footerNote.textContent = payload
    ? `${t('updated')} ${formatTime(payload.fetchedAt)}${payload.cached ? ` · ${t('cachedNote')}` : ''}`
    : '';
  footerButton.update({ label: t('openDashboard') });
};

const paintControls = (): void => {
  tabs.update({
    items: [
      { id: 'today', label: t('rangeToday') },
      { id: '7d', label: t('range7d') },
      { id: '30d', label: t('range30d') },
    ],
    activeId: range,
  });
  refreshButton.update({ label: t('refresh'), loading });
};

const paint = (): void => {
  clearBody();
  switch (view.kind) {
    case 'loading':
      blocks.push(mountSpinner(bodyRoot, { label: t('loading') }));
      break;
    case 'host-error':
      blocks.push(mountBanner(bodyRoot, {
        tone: 'error',
        title: t('serviceTitle'),
        body: view.message,
        action: { label: t('retry'), onClick: () => void load(true) },
      }));
      break;
    case 'api-error': {
      const code = view.payload.error?.code ?? 'api';
      if (code === 'invalid-key') {
        blocks.push(mountEmpty(bodyRoot, {
          title: t('invalidKeyTitle'),
          body: t('invalidKeyBody', { path: view.payload.configPath }),
          action: { label: t('getApiKey'), onClick: () => void host.openUrl(API_KEY_URL) },
        }));
        break;
      }
      const title = code === 'rate-limited'
        ? t('rateLimitedTitle')
        : code === 'network'
          ? t('networkTitle')
          : t('apiErrorTitle');
      blocks.push(mountBanner(bodyRoot, {
        tone: 'error',
        title,
        body: view.payload.error?.message,
        action: { label: t('retry'), onClick: () => void load(true) },
      }));
      break;
    }
    case 'not-configured':
      blocks.push(mountEmpty(bodyRoot, {
        title: t('notConfiguredTitle'),
        body: t(view.payload.reason === 'no-key' ? 'notConfiguredKey' : 'notConfiguredFile', {
          path: view.payload.configPath,
        }),
        action: { label: t('getApiKey'), onClick: () => void host.openUrl(API_KEY_URL) },
      }));
      break;
    case 'data':
      dataView(view.payload);
      break;
  }
  paintIdentity(view.kind === 'data' ? view.payload : null);
  paintFooter();
};

/* ---------------------------------------------------------------- loading */

const describeError = (error: unknown): string => {
  if (error instanceof HostRequestError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

const load = async (force: boolean): Promise<void> => {
  const current = ++generation;
  loading = true;
  paintControls();
  if (view.kind !== 'data') {
    view = { kind: 'loading' };
    paint();
  }
  try {
    const result = await host.serviceRequest({
      method: 'GET',
      path: '/summary',
      query: { range, refresh: force ? '1' : '0' },
    });
    if (current !== generation) return;
    let payload: SummaryPayload;
    try {
      payload = JSON.parse(result.body) as SummaryPayload;
    } catch {
      view = { kind: 'host-error', message: `${result.status}: unreadable service response` };
      paint();
      return;
    }
    if (payload.error) {
      view = { kind: 'api-error', payload };
    } else if (!payload.configured) {
      view = { kind: 'not-configured', payload };
    } else {
      view = { kind: 'data', payload };
    }
    paint();
  } catch (error) {
    if (current !== generation) return;
    view = { kind: 'host-error', message: describeError(error) };
    paint();
  } finally {
    if (current === generation) {
      loading = false;
      paintControls();
    }
  }
};

/* ------------------------------------------------------------------ shell */

const buildShell = (): void => {
  const header = el('div', 'wt-header');
  const titleRow = el('div', 'wt-title-row');
  identityBox = el('span', 'wt-identity');
  titleRow.append(el('span', 'wt-title', 'WakaTime'), identityBox);
  header.append(titleRow);

  const controls = el('div', 'wt-controls');
  const tabsRoot = el('div', 'wt-tabs');
  const actionsRoot = el('div', 'wt-actions');
  controls.append(tabsRoot, actionsRoot);
  header.append(controls);
  root.append(header);

  bodyRoot = el('div', 'wt-body');
  root.append(bodyRoot);

  const footer = el('div', 'wt-footer');
  footerNote = el('span', 'wt-footer-note');
  const footerActions = el('div', 'wt-footer-actions');
  footer.append(footerNote, footerActions);
  root.append(footer);

  tabs = mountTabs(tabsRoot, {
    items: [
      { id: 'today', label: t('rangeToday') },
      { id: '7d', label: t('range7d') },
      { id: '30d', label: t('range30d') },
    ],
    activeId: range,
    trackBackground: true,
    onChange: (id) => {
      if (id !== 'today' && id !== '7d' && id !== '30d') return;
      range = id;
      tabs.update({ activeId: range });
      void load(false);
    },
  });
  refreshButton = mountButton(actionsRoot, {
    label: t('refresh'),
    variant: 'ghost',
    size: 'xs',
    onClick: () => void load(true),
  });
  footerButton = mountButton(footerActions, {
    label: t('openDashboard'),
    variant: 'ghost',
    size: 'xs',
    onClick: () => void host.openUrl(DASHBOARD_URL),
  });
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  const nextLocale = context.locale || 'en';
  const nextDirectory = context.directory ?? null;
  const changed = nextLocale !== locale || nextDirectory !== directory;
  locale = nextLocale;
  directory = nextDirectory;

  if (!shellBuilt) {
    shellBuilt = true;
    buildShell();
    paintControls();
    void load(false);
    window.setInterval(() => {
      if (!document.hidden && shellBuilt) void load(false);
    }, REFRESH_MS);
    return;
  }
  if (changed) {
    paintControls();
    paint();
  }
});
