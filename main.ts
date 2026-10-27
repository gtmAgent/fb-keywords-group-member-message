/**
 * 账号巡检 → 按可用浏览器×每账号条数，从关键词池随机搜小组并采成员 → 健康账号轮询私信。
 * 成员池按目标人数 × 倍数多采备用；私信失败则换下一个成员，同一账号连续失败达上限则跳过该账号。
 * 同阶段任务批量 enqueueTask，再 Promise.all(waitForTask)；调度器按浏览器并行。
 */
import type { WorkflowRunConfig } from './config.types';
import {
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  type AutomationRunResult,
  type AutomationStepResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

const GROUPS_PER_KEYWORD_MIN = 1;
const GROUPS_PER_KEYWORD_MAX = 3;
/** 相对「可用账号 × 每账号条数」多采集的倍数，供私信失败时换人。 */
const MEMBER_POOL_FACTOR = 3;
/** 同一账号连续私信失败次数达到该值后跳过该账号（不再发剩余额度）。 */
const MAX_CONSEC_DM_FAILS_PER_ACCOUNT = 2;

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 多条文案用 ==sep== 分隔（与 fb-auto-message 一致）。 */
function splitMessages(raw: string): string[] {
  return String(raw ?? '')
    .split('==sep==')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function parseImageMd5s(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((s) => s.trim());
}

function toPositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function randomIntInclusive(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** 将 total 随机拆到 buckets 份，各份 ≥0，总和 = total。 */
function distributeQuota(total: number, buckets: number): number[] {
  if (buckets <= 0) return [];
  if (total <= 0) return Array.from({ length: buckets }, () => 0);
  const base = Math.floor(total / buckets);
  let rem = total % buckets;
  const quotas = Array.from({ length: buckets }, () => base);
  const order = shuffleInPlace(Array.from({ length: buckets }, (_, i) => i));
  for (let i = 0; i < rem; i++) {
    quotas[order[i]!]! += 1;
  }
  return quotas;
}

function rowText(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function collectRowsForTask(
  ctx: WorkflowContext,
  cmd: string,
  taskId: number,
): Promise<Record<string, unknown>[]> {
  const [ok, msg, all] = await ctx.fetchAllAutomationData(cmd, { taskId });
  if (!ok || !all) {
    ctx.workflowLog(`fetchAllAutomationData ${cmd} task=${taskId}: ${msg || 'empty'}`);
    return [];
  }
  return all.rows ?? [];
}

type BatchJob<T> = {
  meta: T;
  cmd: string;
  deviceId: number;
  config: Record<string, unknown>;
};

/**
 * 同阶段批量入队后并行等待。入队本身串行（HTTP 快），等待用 Promise.all，
 * 调度器会让不同浏览器并行跑；同一浏览器一次只跑一个任务。
 */
async function enqueueBatchAndWait<T>(
  ctx: WorkflowContext,
  jobs: BatchJob<T>[],
): Promise<Array<{ meta: T; step: AutomationStepResult }>> {
  if (jobs.length === 0) return [];

  type Pending =
    | { meta: T; taskId: number }
    | { meta: T; failMsg: string };

  const pending: Pending[] = [];
  for (const job of jobs) {
    const [ok, msg, data] = await ctx.enqueueTask({
      cmd: job.cmd,
      deviceId: job.deviceId,
      target: 'browser',
      config: job.config,
    });
    if (!ok || !data) {
      ctx.workflowLog(`enqueue failed ${job.cmd} device=${job.deviceId}: ${msg || 'unknown'}`);
      pending.push({ meta: job.meta, failMsg: msg || 'enqueue failed' });
      continue;
    }
    ctx.workflowLog(`enqueued ${job.cmd} task #${data.taskId} device=${job.deviceId}`);
    pending.push({ meta: job.meta, taskId: data.taskId });
  }

  return Promise.all(
    pending.map(async (p) => {
      if ('failMsg' in p) {
        return {
          meta: p.meta,
          step: { succ: false, msg: p.failMsg, data: {}, taskId: 0 } satisfies AutomationStepResult,
        };
      }
      const step = await ctx.waitForTask(p.taskId);
      return { meta: p.meta, step };
    }),
  );
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const keywords = splitLines(cfg.keywords);
  const messages = splitMessages(cfg.messages);
  const browserIds = parseBrowserIds(cfg.browsers);
  const images = parseImageMd5s(cfg.images);
  const perAccount = toPositiveInt(cfg.messages_per_account, 0);
  const publicOnly: 0 | 1 = cfg.public_only === 0 ? 0 : 1;

  if (keywords.length === 0) return { succ: false, msg: '请填写至少一个行业关键词' };
  if (messages.length === 0) return { succ: false, msg: '请填写至少一条私信文案' };
  if (browserIds.length === 0) return { succ: false, msg: '请选择至少一个浏览器' };
  if (perAccount <= 0) return { succ: false, msg: '每个账号发送条数须为正整数' };

  ctx.workflowLog(
    `plan: browsers=${browserIds.length} perAccount=${perAccount} keywords=${keywords.length} messages=${messages.length} images=${images.length}`,
  );

  // —— 1) 全部浏览器批量巡检；仅未打问题标签（valid）的账号进入后续采集与私信 ——
  const checkJobs: BatchJob<{ deviceId: number }>[] = browserIds.map((deviceId) => ({
    meta: { deviceId },
    cmd: 'fb-auto-check',
    deviceId,
    config: {
      ensure_english: 1,
    },
  }));
  ctx.workflowLog(`check batch enqueue count=${checkJobs.length}`);
  const checkResults = await enqueueBatchAndWait(ctx, checkJobs);

  const healthyBrowserIds: number[] = [];
  let browsersChecked = 0;
  let browsersTagged = 0;
  let browsersCheckFailed = 0;

  for (const { meta, step } of checkResults) {
    const deviceId = meta.deviceId;
    browsersChecked += 1;
    const status = String(step.data?.accountStatus ?? '').trim().toLowerCase();
    const labels = String(step.data?.labels ?? '').trim();
    if (!step.succ) {
      browsersCheckFailed += 1;
      ctx.workflowLog(`check failed device=${deviceId}: ${step.msg} — skip`);
      continue;
    }
    if (status === 'valid') {
      healthyBrowserIds.push(deviceId);
      ctx.workflowLog(`check ok device=${deviceId} status=valid labels=${labels || '(none)'}`);
      continue;
    }
    browsersTagged += 1;
    ctx.workflowLog(`check tagged device=${deviceId} status=${status || '?'} labels=${labels || '(none)'} — skip`);
  }

  if (healthyBrowserIds.length === 0) {
    return {
      succ: false,
      msg: `巡检后无可用账号（巡检 ${browsersChecked}，打标签 ${browsersTagged}，巡检失败 ${browsersCheckFailed}）`,
      data: {
        groups_collected: 0,
        members_collected: 0,
        browsers_checked: browsersChecked,
        browsers_healthy: 0,
        browsers_tagged: browsersTagged,
        messages_sent: 0,
        messages_failed: 0,
        messages_skipped: 0,
        summary: '全部账号已打标签或巡检失败，未采集未私信',
      },
    };
  }

  // 目标发送条数 = 可用浏览器数 × 每账号条数；成员池按倍数多采备用
  const totalNeed = healthyBrowserIds.length * perAccount;
  const collectNeed = totalNeed * MEMBER_POOL_FACTOR;
  ctx.workflowLog(
    `after check: healthy=${healthyBrowserIds.length}/${browsersChecked} totalNeed=${totalNeed} collectNeed=${collectNeed} (×${MEMBER_POOL_FACTOR})`,
  );

  // —— 2) 关键词打乱后按批搜小组 + 采成员，凑满 collectNeed（含备用）即停 ——
  const shuffledKeywords = shuffleInPlace([...keywords]);
  const groupUrlSet = new Set<string>();
  const groupUrls: string[] = [];
  const memberUrlSet = new Set<string>();
  const memberUrls: string[] = [];
  let searchOk = 0;
  let searchFail = 0;
  let memberTaskFail = 0;
  let keywordCursor = 0;
  let batchNo = 0;

  while (memberUrls.length < collectNeed && keywordCursor < shuffledKeywords.length) {
    batchNo += 1;
    const batchSize = Math.min(healthyBrowserIds.length, shuffledKeywords.length - keywordCursor);
    const batchKeywords = shuffledKeywords.slice(keywordCursor, keywordCursor + batchSize);
    keywordCursor += batchSize;

    const searchJobs: BatchJob<{ keyword: string; maxGroups: number }>[] = batchKeywords.map(
      (keyword, ki) => {
        const maxGroups = randomIntInclusive(GROUPS_PER_KEYWORD_MIN, GROUPS_PER_KEYWORD_MAX);
        const deviceId = healthyBrowserIds[ki % healthyBrowserIds.length]!;
        return {
          meta: { keyword, maxGroups },
          cmd: 'fb-group-search',
          deviceId,
          config: {
            keyword,
            max_count: maxGroups,
            public_only: publicOnly,
          },
        };
      },
    );
    ctx.workflowLog(
      `search batch #${batchNo} enqueue count=${searchJobs.length} remainCollect=${collectNeed - memberUrls.length}`,
    );
    const searchResults = await enqueueBatchAndWait(ctx, searchJobs);

    const newGroupUrls: string[] = [];
    for (const { meta, step } of searchResults) {
      if (!step.succ) {
        searchFail += 1;
        ctx.workflowLog(`search failed keyword="${meta.keyword}": ${step.msg}`);
        continue;
      }
      searchOk += 1;
      const rows = await collectRowsForTask(ctx, 'fb-group-search', step.taskId);
      for (const row of rows) {
        const url = normalizeUrl(rowText(row, 'group_url'));
        if (!url || groupUrlSet.has(url)) continue;
        groupUrlSet.add(url);
        groupUrls.push(url);
        newGroupUrls.push(url);
      }
    }

    const remainCollect = collectNeed - memberUrls.length;
    if (newGroupUrls.length === 0 || remainCollect <= 0) {
      ctx.workflowLog(
        `search batch #${batchNo}: newGroups=0 remainCollect=${remainCollect} — continue keywords`,
      );
      continue;
    }

    const quotas = distributeQuota(remainCollect, newGroupUrls.length);
    ctx.workflowLog(
      `members batch #${batchNo}: newGroups=${newGroupUrls.length} quotas=${quotas.join(',')}`,
    );

    const memberJobs: BatchJob<{ host: string; ask: number }>[] = [];
    for (let gi = 0; gi < newGroupUrls.length; gi++) {
      const host = newGroupUrls[gi]!;
      const quota = quotas[gi] ?? 0;
      if (quota <= 0) continue;
      const deviceId = healthyBrowserIds[gi % healthyBrowserIds.length]!;
      memberJobs.push({
        meta: { host, ask: quota },
        cmd: 'fb-group-member',
        deviceId,
        config: {
          host,
          max_count: quota,
        },
      });
    }

    if (memberJobs.length === 0) continue;

    const memberResults = await enqueueBatchAndWait(ctx, memberJobs);
    for (const { meta, step } of memberResults) {
      if (!step.succ) {
        memberTaskFail += 1;
        ctx.workflowLog(`members failed host=${meta.host}: ${step.msg}`);
        continue;
      }
      const rows = await collectRowsForTask(ctx, 'fb-group-member', step.taskId);
      for (const row of rows) {
        if (memberUrls.length >= collectNeed) break;
        const url = normalizeUrl(rowText(row, 'member_url'));
        if (!url || memberUrlSet.has(url)) continue;
        memberUrlSet.add(url);
        memberUrls.push(url);
      }
    }

    ctx.workflowLog(
      `after batch #${batchNo}: members=${memberUrls.length}/${collectNeed} groups=${groupUrls.length} keywordsUsed=${keywordCursor}/${shuffledKeywords.length}`,
    );
  }

  if (groupUrls.length === 0) {
    return {
      succ: false,
      msg: `未采集到任何小组（搜索成功 ${searchOk}，失败 ${searchFail}；已用关键词 ${keywordCursor}）`,
      data: {
        groups_collected: 0,
        members_collected: 0,
        browsers_checked: browsersChecked,
        browsers_healthy: healthyBrowserIds.length,
        browsers_tagged: browsersTagged,
        messages_sent: 0,
        messages_failed: 0,
        messages_skipped: 0,
        summary: '小组采集为空，已中止',
      },
    };
  }

  if (memberUrls.length === 0) {
    return {
      succ: false,
      msg: `未采集到任何成员（小组 ${groupUrls.length}，成员任务失败 ${memberTaskFail}）`,
      data: {
        groups_collected: groupUrls.length,
        members_collected: 0,
        browsers_checked: browsersChecked,
        browsers_healthy: healthyBrowserIds.length,
        browsers_tagged: browsersTagged,
        messages_sent: 0,
        messages_failed: 0,
        messages_skipped: 0,
        summary: '成员采集为空，已中止',
      },
    };
  }

  ctx.workflowLog(
    `memberPool=${memberUrls.length} (need=${totalNeed} collectNeed=${collectNeed}) groups=${groupUrls.length} keywordsUsed=${keywordCursor}/${keywords.length} memberTaskFail=${memberTaskFail}`,
  );

  // —— 3) 健康账号按额度发私信：失败换下一个成员；同一账号连续失败达上限则跳过该账号 ——
  type AccDmState = {
    deviceId: number;
    sent: number;
    consecFail: number;
    active: boolean;
  };

  const accStates: AccDmState[] = healthyBrowserIds.map((deviceId) => ({
    deviceId,
    sent: 0,
    consecFail: 0,
    active: true,
  }));

  let poolIdx = 0;
  let msgSeq = 0;
  let messagesSent = 0;
  let messagesFailed = 0;
  let messagesSkipped = 0;
  let accountsSkippedDm = 0;
  let dmWave = 0;

  while (true) {
    const waveJobs: BatchJob<{ acc: AccDmState; host: string }>[] = [];
    for (const acc of accStates) {
      if (!acc.active || acc.sent >= perAccount) continue;
      if (poolIdx >= memberUrls.length) break;
      const host = memberUrls[poolIdx++]!;
      const message = messages[msgSeq % messages.length]!;
      const image = images.length > 0 ? images[msgSeq % images.length]! : null;
      msgSeq += 1;
      waveJobs.push({
        meta: { acc, host },
        cmd: 'fb-auto-message',
        deviceId: acc.deviceId,
        config: {
          host,
          message,
          image,
        },
      });
    }

    if (waveJobs.length === 0) break;

    dmWave += 1;
    ctx.workflowLog(
      `dm wave #${dmWave} enqueue=${waveJobs.length} poolLeft=${memberUrls.length - poolIdx} activeAcc=${accStates.filter((a) => a.active && a.sent < perAccount).length}`,
    );
    const waveResults = await enqueueBatchAndWait(ctx, waveJobs);

    for (const { meta, step } of waveResults) {
      const { acc, host } = meta;
      if (step.succ) {
        acc.sent += 1;
        acc.consecFail = 0;
        messagesSent += 1;
        ctx.workflowLog(`message ok device=${acc.deviceId} host=${host} sent=${acc.sent}/${perAccount}`);
        continue;
      }

      messagesFailed += 1;
      acc.consecFail += 1;
      ctx.workflowLog(
        `message failed device=${acc.deviceId} host=${host} consecFail=${acc.consecFail}/${MAX_CONSEC_DM_FAILS_PER_ACCOUNT}: ${step.msg} — skip member`,
      );

      if (acc.consecFail >= MAX_CONSEC_DM_FAILS_PER_ACCOUNT) {
        const remain = Math.max(0, perAccount - acc.sent);
        messagesSkipped += remain;
        acc.active = false;
        accountsSkippedDm += 1;
        ctx.workflowLog(
          `skip account device=${acc.deviceId} after ${acc.consecFail} consecutive dm fails; abandon remain=${remain}`,
        );
      }
    }
  }

  const unusedMembers = Math.max(0, memberUrls.length - poolIdx);
  if (unusedMembers > 0) {
    ctx.workflowLog(`member pool unused=${unusedMembers}`);
  }

  const summary = [
    `关键词已用 ${keywordCursor}/${keywords.length}`,
    `小组 ${groupUrls.length}`,
    `成员池 ${memberUrls.length}（目标 ${totalNeed}）`,
    `可用账号 ${healthyBrowserIds.length}/${browsersChecked}`,
    `私信成功 ${messagesSent}`,
    `私信失败 ${messagesFailed}`,
    accountsSkippedDm > 0 ? `跳过账号 ${accountsSkippedDm}` : '',
    messagesSkipped > 0 ? `放弃额度 ${messagesSkipped}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const allQuotaMet = messagesSent >= totalNeed && messagesFailed === 0;
  return {
    succ: messagesSent > 0,
    msg: allQuotaMet ? `完成：${summary}` : `部分完成：${summary}`,
    data: {
      groups_collected: groupUrls.length,
      members_collected: memberUrls.length,
      browsers_checked: browsersChecked,
      browsers_healthy: healthyBrowserIds.length,
      browsers_tagged: browsersTagged,
      messages_sent: messagesSent,
      messages_failed: messagesFailed,
      messages_skipped: messagesSkipped,
      summary,
    },
  };
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)));
