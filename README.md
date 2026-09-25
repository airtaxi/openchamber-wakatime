# OpenChamber WakaTime

A WakaTime panel for [OpenChamber](https://openchamber.dev). It sits on the right-hand rail and shows your coding activity without leaving the editor: today's time, a daily chart, language and project rankings, editors and operating systems, and the AI coding cost WakaTime tracks.

The panel reads the API key from `~/.wakatime.cfg`, the same file the WakaTime plugins write, so there is nothing to paste into OpenChamber.

## Requirements

- OpenChamber `2.0.0` or newer, on web or desktop.
- A `~/.wakatime.cfg` on the machine that runs the OpenChamber server, with an `api_key` in the `[settings]` section. Any official WakaTime plugin creates this file when you sign in.

```ini
[settings]
api_key = waka_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

If that file is missing, the panel shows where it looked and a link to issue a key.

## Install

**From a folder** (for development): open **Settings → Extensions**, paste the absolute path of this folder, and choose **Add**.

**From Git** (for updates): paste `https://github.com/airtaxi/openchamber-wakatime` and choose **Add**. OpenChamber copies the repository into its own data folder, so the built `panel/main.js` and `service/main.js` must be committed. Open **Settings → Extensions** to check for updates.

Either way, OpenChamber shows the permission list once. This extension declares a **local service**, so the dialog warns that the process runs with your user access. Approve it and the WakaTime icon appears on the rail.

## Why a local service

A panel runs in a sandboxed iframe. It cannot reach the network directly, and the host only attaches tokens you pasted on an Integrations card. Reading `~/.wakatime.cfg` and calling `https://api.wakatime.com` therefore needs a small process next to the extension. OpenChamber starts `service/main.js` from this folder with its own runtime, and the panel talks to it through `host.serviceRequest`.

The API key never reaches the panel, and the panel never sees the network. The service listens on `127.0.0.1` and the host proxies to it.

## What the panel shows

- Total, daily average, all-time, and best day for the selected range.
- A daily bar chart for the last 7 or 30 days.
- Rankings for languages, projects, editors, and operating systems.
- **Working on**: the WakaTime project whose name matches the OpenChamber project you have open, with its time and last branch.
- **AI coding**: cost, tokens in and out, cached input tokens, AI versus human line changes, and a per-model cost list.
- A warning when WakaTime is still aggregating a range, a refresh button, and a link to the dashboard.

The UI follows the app language: Korean when the locale starts with `ko`, English otherwise.

## Endpoints used

All calls use `Authorization: Basic base64(api_key)` against `https://api.wakatime.com/api/v1`.

| Panel range | Requests |
| --- | --- |
| Today | `/users/current/status_bar/today` |
| 7 days | `/users/current/summaries?range=Last 7 Days`, `/users/current/stats/last_7_days` |
| 30 days | `/users/current/summaries?range=Last 30 Days`, `/users/current/stats/last_30_days` |
| Always | `/users/current`, `/users/current/all_time_since_today` |

Responses are normalized in the service and cached for 60 seconds. A manual refresh bypasses the cache. When the stats endpoint is still aggregating a range, the service rebuilds the rankings and AI totals from the daily summaries instead of showing empty sections.

## Configuration

| Variable | Effect |
| --- | --- |
| `OPENCHAMBER_WAKATIME_CONFIG` | Overrides the config path. Useful for testing a fake home directory. |

## Development

```bash
bun install
bun run build       # bundles panel/main.js and service/main.js
bun run typecheck   # tsc --noEmit
```

`panel/main.js` is a browser IIFE; `service/main.js` is a Node ESM file. Both are committed, because OpenChamber never builds an extension after install. Edit the TypeScript sources and run `bun run build` again, then reopen the panel.

Run the service on its own to check the WakaTime call without the app:

```bash
OPENCHAMBER_SERVICE_PORT=3999 OPENCHAMBER_SERVICE_TOKEN=test node service/main.js
curl -H "Authorization: Bearer test" "http://127.0.0.1:3999/summary?range=7d"
```

To publish an update, raise `version` in `package.json`, run the build, commit, and push. OpenChamber offers the update the next time the user opens Settings → Extensions.

## License

MIT. Copyright (c) 2026 Howon Lee (airtaxi).

## 한국어 요약

OpenChamber 오른쪽 레일에서 WakaTime 현황을 보여주는 확장입니다. `~/.wakatime.cfg`의 `api_key`를 로컬 서비스가 직접 읽고 WakaTime API를 호출하므로, 별도로 토큰을 붙여넣을 필요가 없습니다. 오늘 누적과 일별 그래프, 언어·프로젝트 순위, 에디터·운영체제 비중, AI 코딩 비용을 보여주고, 현재 열어 둔 OpenChamber 프로젝트와 이름이 같은 WakaTime 프로젝트를 강조합니다. 설치할 때 로컬 서비스 권한을 한 번 승인해야 하며, 이 프로세스는 사용자 권한으로 실행됩니다.
