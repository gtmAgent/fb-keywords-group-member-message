/**
 * 任务组分发：多行关键词轮询分配给所选浏览器。
 *
 * 试跑：`{BUN} --no-env-file distribute.ts`
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
  const keywords = splitConfigLines(groupConfig.keywords);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const maxCount = parsePositiveIntConfig(groupConfig.max_count, 50);
  const publicOnly = Number(groupConfig.public_only) === 1 ? 1 : 0;

  if (keywords.length === 0) {
    return { succ: false, msg: '请至少填写一个搜索关键词' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请选择至少一台浏览器' };
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

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]!;
    const browserId = browserIds[i % browserIds.length]!;
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
      config: { keyword, max_count: maxCount, public_only: publicOnly, _gid: gid },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);

    perBrowserSchedule.set(browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / keywords / browsers)' };
  }

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
