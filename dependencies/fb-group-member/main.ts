/**
 * Facebook 小组成员采集：打开小组成员页 → 滚动最近加入区域 → 采集主页/名称/加入时间。
 * 定位优先 href / listitem 结构；加入时间用相对时间特征（数字+前/ago 等已观察形态），不依赖「Joined/加入」整词。
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

/**
 * 解析任务组 id：env → 分发写入的 `_gid` → 任务快照。
 * 桌面跑子任务时未必注入 TASK_GROUP_ID；缺 gid 时采集页按组过滤会空白。
 */
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

const MEMBER_LINK = 'a[href*="/groups/"][href*="/user/"]';

const memberLinkPath = nodePath().css(MEMBER_LINK).many();
const scrollRootPath = nodePath().css('body').one();

/** 从小组首页或任意 /groups/... URL 拼出成员列表页。 */
function toMembersUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().includes('facebook.com')) return null;
  const m = url.pathname.match(/\/groups\/([^/]+)/i);
  if (!m?.[1]) return null;
  const groupId = m[1];
  return `https://www.facebook.com/groups/${groupId}/members`;
}

function isLoginUrl(u: string): boolean {
  return /\/login\b|\/checkpoint\b/i.test(u);
}

/**
 * 页面内抽取最近加入成员。
 * - 成员锚点：a[href*="/groups/"][href*="/user/"]（语言无关）
 * - 加入时间：listitem 内短行 + 相对时间特征（现场中文「3 分钟前」「约 1 小时前加入」；英文 Joined…）
 *   不强制「加入」二字，避免漏采「N 分钟前」。
 */
const EXTRACT_MEMBERS_JS = `(() => {
  const isJoinTimeLine = (line) => {
    const t = (line || '').trim();
    if (!t || t.length > 48) return false;
    if (/^Joined\\b/i.test(t)) return true;
    if (/^(刚刚|剛剛|just now)\\b/i.test(t)) return true;
    // 数字 + 相对时间标记：覆盖「3 分钟前」「2 hours ago」「约 1 小时前加入」
    if (/\\d/.test(t) && /(前|ago)/i.test(t)) return true;
    return false;
  };
  const out = [];
  const seen = new Set();
  const items = document.querySelectorAll('div[role="listitem"]');
  for (const item of items) {
    const links = item.querySelectorAll('a[href*="/groups/"][href*="/user/"]');
    let name = '';
    let href = '';
    for (const a of links) {
      const t = (a.textContent || '').trim();
      const h = a.getAttribute('href') || '';
      if (t && h && !/contributions/i.test(h)) {
        name = t;
        href = h;
        break;
      }
    }
    if (!href || !name) continue;
    const m = href.match(/\\/groups\\/[^/]+\\/user\\/(\\d+)/);
    if (!m) continue;
    const userId = m[1];
    if (seen.has(userId)) continue;

    let joined = '';
    // 结构优先：span[dir=auto] 下短 div（现场加入时间节点形态）
    const timeDivs = item.querySelectorAll('span[dir="auto"] div');
    for (const d of timeDivs) {
      const t = (d.textContent || '').trim();
      if (isJoinTimeLine(t)) {
        joined = t;
        break;
      }
    }
    if (!joined) {
      const lines = (item.innerText || '').split(/\\n/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (line === name) continue;
        if (isJoinTimeLine(line)) {
          joined = line;
          break;
        }
      }
    }
    if (!joined) continue;
    seen.add(userId);
    const url = 'https://www.facebook.com/profile.php?id=' + userId;
    out.push({ member_name: name, member_url: url, joined_at: joined });
  }
  return JSON.stringify(out);
})()`;

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

async function extractMembers(client: XportBrowserClient): Promise<IntermediateDataRow[]> {
  const [ok, msg, raw] = await client.evaluateInPage(0, EXTRACT_MEMBERS_JS);
  if (!ok || !raw) {
    client.taskLog(`extractMembers evaluate failed: ${msg || 'empty'}`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as IntermediateDataRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    client.taskLog(`extractMembers JSON parse failed: ${String(e)}`);
    return [];
  }
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfigWire,
  manifest: Awaited<ReturnType<typeof loadAutomationManifest>>,
): Promise<AutomationRunResult> {
  const host = String(taskConfig.host ?? '').trim();
  const maxCount = parsePositiveIntConfig(taskConfig.max_count, 50);
  client.taskLog(`host=${host || '(empty)'} max_count=${maxCount}`);

  if (!host) {
    return automationFailWithContext('请填写 Facebook 小组主页地址', {
      code: 'UNKNOWN',
      step: 'validate_host',
    });
  }

  const membersUrl = toMembersUrl(host);
  if (!membersUrl) {
    return automationFailWithContext('小组地址无效，请填写含 /groups/ 的 Facebook 小组链接', {
      code: 'UNKNOWN',
      step: 'validate_host',
      labels: { host },
    });
  }

  try {
    const [goOk, goMsg] = await client.pageGoTo(0, { url: membersUrl, timeoutMs: 60_000 });
    if (!goOk) {
      return await failStep(client, goMsg || '打开小组成员页失败', {
        code: 'NAV_FAILED',
        step: 'open_members',
        labels: { host, membersUrl },
      });
    }

    // 导航后只等成员锚点出现（勿用 networkIdle；FB 长连接易拖超时）
    await Bun.sleep(800);

    const [urlOk, urlMsg, pageUrl] = await client.getPageUrl();
    if (!urlOk || !pageUrl) {
      return await failStep(client, urlMsg || '无法读取当前页面 URL', {
        code: 'UNKNOWN',
        step: 'verify_page_url',
        labels: { host },
      });
    }
    if (isLoginUrl(pageUrl)) {
      return await failStep(client, '浏览器未登录 Facebook，请先在该浏览器登录后再试', {
        code: 'NOT_LOGGED_IN',
        step: 'check_login',
        labels: { host, pageUrl },
      });
    }

    const [waitOk] = await client.waitForSelector(0, {
      selector: MEMBER_LINK,
      timeoutMs: 25_000,
      visible: true,
    });
    if (!waitOk) {
      const [countOk, , count] = await client.getNodeCount(0, memberLinkPath);
      if (!countOk || !count) {
        return await failStep(client, '未找到小组成员列表，请确认账号有权限查看该组成员', {
          code: 'ELEMENT_NOT_FOUND',
          step: 'wait_members_list',
          labels: { host, membersUrl },
        });
      }
    }

    const collected: IntermediateDataRow[] = [];
    const seenUrls = new Set<string>();
    let stagnantRounds = 0;
    const maxRounds = Math.max(20, Math.ceil(maxCount / 3) + 10);

    for (let round = 0; round < maxRounds && collected.length < maxCount; round++) {
      const batch = await extractMembers(client);
      let added = 0;
      for (const row of batch) {
        const url = String(row.member_url ?? '').trim();
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        collected.push(row);
        added += 1;
        if (collected.length >= maxCount) break;
      }
      client.taskLog(`round=${round + 1} batch=${batch.length} added=${added} total=${collected.length}`);

      if (collected.length >= maxCount) break;
      if (added === 0) {
        stagnantRounds += 1;
        if (stagnantRounds >= 4) {
          client.taskLog('no new members after scrolls; stopping');
          break;
        }
      } else {
        stagnantRounds = 0;
      }

      const [wheelOk, wheelMsg] = await client.mouseWheel(0, scrollRootPath, { deltaX: 0, deltaY: 1400 });
      if (!wheelOk) client.taskLog(`mouseWheel: ${wheelMsg}`);
      const [quietOk, quietMsg] = await client.waitForDomQuiet(0, {
        selector: MEMBER_LINK,
        stableMs: 600,
        timeoutMs: 4_000,
      });
      if (!quietOk) client.taskLog(`waitForDomQuiet: ${quietMsg}`);
      await Bun.sleep(500);
    }

    if (collected.length === 0) {
      return await failStep(client, '未采集到带加入时间的成员，请确认账号可查看该组「最近加入」成员列表', {
        code: 'ELEMENT_NOT_FOUND',
        step: 'collect_members',
        labels: { host, membersUrl },
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
        step: 'ingest_members',
        labels: { host, count: String(toIngest.length), gid: String(gid ?? 0) },
      });
    }

    const [, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: `已采集 ${toIngest.length} 位成员`,
      data: {
        host,
        collected_count: toIngest.length,
        final_url: finalUrl || membersUrl,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await failStep(client, `采集过程异常: ${msg}`, {
      code: 'UNKNOWN',
      step: 'unexpected',
      labels: { host },
    });
  }
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    process.exit(
      await XportBrowserClient.run(async () =>
        automationFailWithContext(prepMsg || 'prepareIntermediateStorage failed', {
          code: 'UNKNOWN',
          step: 'prepare_storage',
        }),
      ),
    );
  }
}

const taskConfig = await loadTaskRunConfig<TaskRunConfigWire>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig, manifest)));
