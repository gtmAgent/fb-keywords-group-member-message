/**
 * 任务组分发：
 * - 每个主页链接生成一条任务
 * - 浏览器 / 文案（==sep==）/ 图片 均按任务序号轮询
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayEndSec,
  localDayStartSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  splitConfigLines,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

/** 文案分隔符：单条可含换行，多条用 ==sep== 隔开。 */
const CONTENT_SEP = '==sep==';

function splitContentsBySep(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return text
    .split(CONTENT_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeImagePool(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

function rollBrowserToNextDay(baseSec: number, st: PerBrowserScheduleState, dayStartMin: number): void {
  st.dayOffset += 1;
  st.usedInDay = 0;
  st.cursorSec = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
}

/** 为「当前这条」任务准备可排期时刻：超结束时间、开始+间隔超结束、或超单日上限则滚到下一天。 */
function prepareSlotForCurrentTask(
  baseSec: number,
  st: PerBrowserScheduleState,
  dailyLimit: number,
  duringMin: number,
  dayStartMin: number,
  dayEndMin: number,
): void {
  const maxDayRolls = 366;
  let dayRolls = 0;
  for (;;) {
    const dayStart = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
    const dayEnd = localDayEndSec(baseSec, st.dayOffset, dayEndMin);
    if (st.cursorSec < dayStart) st.cursorSec = dayStart;
    const exceedsDayEnd = st.cursorSec > dayEnd || st.cursorSec + duringMin > dayEnd;
    if (st.usedInDay >= dailyLimit || exceedsDayEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check daily_limit / during_min / time window)');
      }
      rollBrowserToNextDay(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const hosts = splitConfigLines(groupConfig.hosts);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const messages = splitContentsBySep(groupConfig.messages);
  const images = normalizeImagePool(groupConfig.images);

  if (hosts.length === 0) {
    return { succ: false, msg: 'no hosts in group config' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }
  if (messages.length === 0) {
    return { succ: false, msg: 'no messages in group config (separate with ==sep==)' };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];

  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]!;
    const browserId = browserIds[i % browserIds.length]!;
    const message = messages[i % messages.length]!;
    const image = images.length > 0 ? images[i % images.length]! : null;

    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ??
      ({
        dayOffset: 0,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
      } satisfies PerBrowserScheduleState);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config: {
        host,
        message,
        image,
      },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);

    perBrowserSchedule.set(browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / hosts / browsers)' };
  }

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
