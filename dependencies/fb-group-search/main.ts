/**
 * Facebook 小组采集：按关键词打开小组搜索结果页 →（可选）公开小组筛选 → 滚动采集主页地址。
 * 定位优先语言无关：直达 /search/groups URL + filters=public_groups；采集靠 /groups/{id} href。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  ingestIntermediateRows,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  parsePositiveIntConfig,
  parseTaskGroupIdFromEnv,
  parseTaskIdFromEnv,
  prepareIntermediateStorage,
  resolveAiDesktopBaseUrl,
  XportBrowserClient,
} from 'xport-browser-sdk';

type TaskRunConfigWire = TaskRunConfig & { _gid?: unknown };

/** Facebook 小组搜索侧栏「公开小组」filters 载荷（语言无关，现场已验证）。 */
const PUBLIC_GROUPS_FILTERS_B64 = Buffer.from(
  JSON.stringify({
    'public_groups:0': '{"name":"public_groups","args":""}',
  }),
).toString('base64');

/**
 * 小组搜索筛选区内 switch 的 DOM 序（现场：城市为 combobox；其后 我附近 / 公开小组 / 我的小组）。
 * 公开小组为第 2 个 switch（下标 1）——语言无关结构定位。
 */
const PUBLIC_GROUPS_SWITCH_INDEX = 1;

const GROUP_LINK_SELECTOR = 'a[href*="/groups/"]';
const FILTER_SWITCH_SELECTOR = 'div[role="region"] [role="switch"]';
const scrollRootPath = nodePath().css('body').one();
const publicSwitchPath = nodePath().css(FILTER_SWITCH_SELECTOR).one(PUBLIC_GROUPS_SWITCH_INDEX);

/**
 * 语言无关采集：用 /groups/{数字 id} 收链；名称优先取无 img 的标题链文本，
 * 再用「较短且为另一 label 前缀」的 aria-label（头像链常为「名称+后缀」），最后回退为 id。
 */
const EXTRACT_GROUPS_JS = `(() => {
  const decode = (s) => {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  };
  const groupIdFromHref = (href) => {
    const m = String(href || '').match(/\\/groups\\/(\\d+)/);
    return m ? m[1] : '';
  };
  const isGroupProfileHref = (href) => {
    const h = String(href || '');
    if (!h) return false;
    if (/\\/(feed|members|search|user|discover|create|joins)\\b/i.test(h)) return false;
    return /\\/groups\\/\\d+/.test(h);
  };
  const preferNameFromLabels = (labels) => {
    const uniq = [];
    const seen = new Set();
    for (const raw of labels) {
      const t = decode(String(raw || '')).trim();
      if (t.length < 2 || seen.has(t)) continue;
      seen.add(t);
      uniq.push(t);
    }
    uniq.sort((a, b) => a.length - b.length);
    for (const short of uniq) {
      if (uniq.some((long) => long !== short && long.startsWith(short))) return short;
    }
    return uniq[0] || '';
  };
  const buckets = new Map();
  for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
    const href = a.getAttribute('href') || a.href || '';
    if (!isGroupProfileHref(href)) continue;
    const id = groupIdFromHref(href);
    if (!id) continue;
    const url = 'https://www.facebook.com/groups/' + id;
    let b = buckets.get(url);
    if (!b) {
      b = { labels: [], texts: [], info: '' };
      buckets.set(url, b);
    }
    const aria = (a.getAttribute('aria-label') || '').trim();
    if (aria) b.labels.push(aria);
    if (!a.querySelector('img')) {
      const text = (a.textContent || '').trim().replace(/\\s+/g, ' ');
      if (text.length >= 2) b.texts.push(decode(text));
    }
    const row = a.closest('[data-visualcompletion="ignore-dynamic"]');
    if (row && !b.info) {
      b.info = (row.innerText || '').replace(/\\s+/g, ' ').trim();
    }
  }
  const out = [];
  for (const [url, b] of buckets) {
    let name = '';
    if (b.texts.length) {
      name = b.texts.reduce((best, t) => (t.length > best.length ? t : best), '');
    }
    if (!name) name = preferNameFromLabels(b.labels);
    if (!name) {
      const m = url.match(/\\/groups\\/(\\d+)/);
      name = m ? m[1] : url;
    }
    out.push({ group_name: name, group_url: url, group_info: b.info });
  }
  return JSON.stringify(out);
})()`;

const READ_PUBLIC_SWITCH_JS = `(() => {
  const switches = document.querySelectorAll(${JSON.stringify(FILTER_SWITCH_SELECTOR)});
  if (switches.length <= ${PUBLIC_GROUPS_SWITCH_INDEX}) return 'missing';
  return switches[${PUBLIC_GROUPS_SWITCH_INDEX}].getAttribute('aria-checked') || 'false';
})()`;

async function resolveTaskGroupId(
  client: XportBrowserClient,
  taskConfig: TaskRunConfigWire,
): Promise<number | undefined> {
  const fromEnv = parseTaskGroupIdFromEnv();
  if (fromEnv != null && fromEnv > 0) return fromEnv;

  const fromConfig = Number(taskConfig._gid);
  if (Number.isInteger(fromConfig) && fromConfig > 0) return fromConfig;

  const taskId = parseTaskIdFromEnv() ?? client.taskId;
  if (taskId == null || taskId <= 0) return undefined;

  try {
    const url = `${resolveAiDesktopBaseUrl()}/automation/failure/task-snapshot?taskId=${taskId}`;
    const resp = await fetch(url);
    const json = (await resp.json()) as { succ?: boolean; data?: unknown };
    if (!json.succ || json.data == null) return undefined;
    let payload: unknown = json.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return undefined;
      }
    }
    const gid = Number((payload as { gid?: unknown })?.gid);
    if (Number.isInteger(gid) && gid > 0) return gid;
  } catch (e) {
    client.taskLog(`resolveTaskGroupId snapshot failed: ${String(e)}`);
  }
  return undefined;
}

function socialHome(): string {
  const home = String(Bun.env.SOCIAL_HOME || '').trim().replace(/\/+$/, '');
  return home || 'https://www.facebook.com';
}

function buildSearchGroupsUrl(keyword: string, publicOnly: boolean): string {
  const base = `${socialHome()}/search/groups/?q=${encodeURIComponent(keyword)}`;
  if (!publicOnly) return base;
  return `${base}&filters=${encodeURIComponent(PUBLIC_GROUPS_FILTERS_B64)}`;
}

function isLoginUrl(u: string): boolean {
  return /\/login\b|\/checkpoint\b/i.test(u);
}

function urlHasPublicGroupsFilter(u: string): boolean {
  if (u.includes(PUBLIC_GROUPS_FILTERS_B64)) return true;
  const m = u.match(/[?&]filters=([^&]+)/i);
  if (!m) return false;
  try {
    const raw = decodeURIComponent(m[1]);
    if (raw === PUBLIC_GROUPS_FILTERS_B64) return true;
    return /public_groups/i.test(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return false;
  }
}

async function failStep(
  client: XportBrowserClient,
  msg: string,
  opts: { code: string; step: string; labels?: Record<string, string> },
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step: opts.step,
    reason: msg,
    code: opts.code,
    labels: opts.labels,
  });
  return automationFailWithContext(msg, {
    code: opts.code,
    step: opts.step,
    incidentId: captured?.incidentId,
    labels: opts.labels,
  });
}

async function readPublicSwitchChecked(client: XportBrowserClient): Promise<'true' | 'false' | 'missing'> {
  const [ok, , raw] = await client.evaluateInPage(0, READ_PUBLIC_SWITCH_JS);
  if (!ok || raw == null) return 'missing';
  const v = String(raw);
  if (v === 'true' || v === 'false' || v === 'missing') return v;
  return 'missing';
}

/**
 * 确保「公开小组」筛选已开：优先依赖直达 filters URL；未生效则按 DOM 序点第 2 个 switch。
 */
async function ensurePublicGroupsFilter(
  client: XportBrowserClient,
  pageUrl: string,
): Promise<{ ok: true } | { ok: false; msg: string }> {
  if (urlHasPublicGroupsFilter(pageUrl)) {
    const checked = await readPublicSwitchChecked(client);
    if (checked === 'true' || checked === 'missing') {
      client.taskLog(`public groups filter via URL (switch=${checked})`);
      return { ok: true };
    }
  }

  let checked = await readPublicSwitchChecked(client);
  if (checked === 'true') {
    client.taskLog('public groups filter already on (switch index)');
    return { ok: true };
  }
  if (checked === 'missing') {
    return { ok: false, msg: '未找到小组搜索筛选开关，请确认已打开小组搜索结果页' };
  }

  const [clickOk, clickMsg] = await client.clickNode(0, publicSwitchPath);
  if (!clickOk) {
    return { ok: false, msg: clickMsg || '点击公开小组筛选失败' };
  }
  await Bun.sleep(900);
  await client.waitForDomQuiet(0, { stableMs: 600, timeoutMs: 8_000 });

  checked = await readPublicSwitchChecked(client);
  if (checked === 'true') {
    client.taskLog('enabled public groups filter via switch index');
    return { ok: true };
  }

  const [, , afterUrl] = await client.getPageUrl();
  if (afterUrl && urlHasPublicGroupsFilter(afterUrl)) {
    client.taskLog('public groups filter confirmed by URL after click');
    return { ok: true };
  }
  return { ok: false, msg: '公开小组筛选未能开启，请稍后重试或检查页面是否完整加载' };
}

async function extractGroups(client: XportBrowserClient): Promise<IntermediateDataRow[]> {
  const [ok, msg, raw] = await client.evaluateInPage(0, EXTRACT_GROUPS_JS);
  if (!ok || !raw) {
    client.taskLog(`extractGroups evaluate failed: ${msg || 'empty'}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as IntermediateDataRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    client.taskLog(`extractGroups JSON parse failed: ${String(e)}`);
    return [];
  }
}

async function settleAfterScroll(client: XportBrowserClient): Promise<void> {
  await Bun.sleep(700);
  const [quietOk, quietMsg] = await client.waitForDomQuiet(0, {
    stableMs: 500,
    timeoutMs: 5_000,
  });
  if (!quietOk) client.taskLog(`waitForDomQuiet: ${quietMsg}`);
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfigWire,
  manifest: Awaited<ReturnType<typeof loadAutomationManifest>>,
): Promise<AutomationRunResult> {
  const keyword = String(taskConfig.keyword ?? '').trim();
  const maxCount = parsePositiveIntConfig(taskConfig.max_count, 50);
  const publicOnly = Number(taskConfig.public_only) === 1;
  client.taskLog(`keyword=${keyword || '(empty)'} max_count=${maxCount} public_only=${publicOnly}`);

  if (!keyword) {
    return automationFailWithContext('请填写搜索关键词', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }

  const searchUrl = buildSearchGroupsUrl(keyword, publicOnly);

  try {
    const [goOk, goMsg] = await client.pageGoTo(0, { url: searchUrl, timeoutMs: 60_000 });
    if (!goOk) {
      return await failStep(client, goMsg || '打开小组搜索结果页失败', {
        code: 'NAV_FAILED',
        step: 'open_search',
        labels: { keyword, searchUrl },
      });
    }
    await Bun.sleep(800);

    const [urlOk, urlMsg, pageUrl] = await client.getPageUrl();
    if (!urlOk || !pageUrl) {
      return await failStep(client, urlMsg || '无法读取当前页面 URL', {
        code: 'UNKNOWN',
        step: 'verify_page_url',
        labels: { keyword },
      });
    }
    if (isLoginUrl(pageUrl)) {
      return await failStep(client, '浏览器未登录 Facebook，请先在该浏览器登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { keyword, pageUrl },
      });
    }

    if (publicOnly) {
      const publicFilter = await ensurePublicGroupsFilter(client, pageUrl);
      if (!publicFilter.ok) {
        return await failStep(client, publicFilter.msg, {
          code: 'ELEMENT_NOT_FOUND',
          step: 'enable_public_filter',
          labels: { keyword, searchUrl },
        });
      }
    }

    const [waitOk] = await client.waitForSelector(0, {
      selector: GROUP_LINK_SELECTOR,
      timeoutMs: 25_000,
      visible: true,
    });
    if (!waitOk) {
      return await failStep(client, '未找到小组搜索结果，请确认关键词有效或稍后重试', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'wait_group_results',
        labels: { keyword, searchUrl },
      });
    }
    await Bun.sleep(500);

    const collected: IntermediateDataRow[] = [];
    const seenUrls = new Set<string>();
    let stagnantRounds = 0;
    const maxRounds = Math.max(20, Math.ceil(maxCount / 5) + 10);

    for (let round = 0; round < maxRounds && collected.length < maxCount; round++) {
      const batch = await extractGroups(client);
      let added = 0;
      for (const row of batch) {
        const url = String(row.group_url ?? '').trim();
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        collected.push({
          keyword,
          group_name: String(row.group_name ?? '').trim(),
          group_url: url,
          group_info: String(row.group_info ?? '').trim(),
        });
        added += 1;
        if (collected.length >= maxCount) break;
      }
      client.taskLog(`round=${round + 1} batch=${batch.length} added=${added} total=${collected.length}`);

      if (collected.length >= maxCount) break;
      if (added === 0) {
        stagnantRounds += 1;
        if (stagnantRounds >= 4) {
          client.taskLog('no new groups after scrolls; stopping');
          break;
        }
      } else {
        stagnantRounds = 0;
      }

      const [wheelOk, wheelMsg] = await client.mouseWheel(0, scrollRootPath, { deltaX: 0, deltaY: 1600 });
      if (!wheelOk) client.taskLog(`mouseWheel: ${wheelMsg}`);
      await settleAfterScroll(client);
    }

    if (collected.length === 0) {
      return await failStep(client, '未采集到小组主页地址，请更换关键词或确认页面已展示小组列表', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'collect_groups',
        labels: { keyword, searchUrl },
      });
    }

    const toIngest = collected.slice(0, maxCount);
    const gid = await resolveTaskGroupId(client, taskConfig);
    client.taskLog(`ingest gid=${gid ?? '(none)'} taskId=${client.taskId} rows=${toIngest.length}`);
    if (client.taskId > 0 && (gid == null || gid <= 0)) {
      client.taskLog('warning: no task group id; data may not show under 采集数据 for a task group');
    }
    const [ingOk, ingMsg] = await ingestIntermediateRows(manifest, toIngest, {
      deviceId: client.id,
      deviceType: 'browser',
      taskId: client.taskId,
      ...(gid != null && gid > 0 ? { gid } : {}),
    });
    if (!ingOk) {
      return await failStep(client, ingMsg || '写入采集数据失败', {
        code: 'UNKNOWN',
        step: 'ingest_groups',
        labels: { keyword, count: String(toIngest.length), gid: String(gid ?? 0) },
      });
    }

    const [, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: `已采集 ${toIngest.length} 个小组`,
      data: {
        keyword,
        collected_count: toIngest.length,
        final_url: finalUrl || searchUrl,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await failStep(client, `采集过程异常: ${msg}`, {
      code: 'UNKNOWN',
      step: 'unexpected',
      labels: { keyword },
    });
  }
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    console.error(`prepareIntermediateStorage failed: ${prepMsg}`);
    process.exit(1);
  }
}
const taskConfig = await loadTaskRunConfig<TaskRunConfigWire>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig, manifest)),
);
