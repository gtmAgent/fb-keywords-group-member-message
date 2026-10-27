/**
 * 任务组分发：多行小组地址按数量平均分给所选浏览器；无频率限制，尽快排期。
 * 例：100 个小组 × 5 台浏览器 → 每台约 20 条（余数依次分给前几台）。
 *
 * 试跑：`{BUN} --no-env-file distribute.ts`
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  splitConfigLines,
  type TaskCreateInput,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

/** 将 hosts 尽量均匀分给各浏览器：前 rem 台各多 1 条。 */
function assignHostsEvenly(
  hosts: string[],
  browserIds: number[],
): Array<{ host: string; browserId: number }> {
  const n = hosts.length;
  const m = browserIds.length;
  const base = Math.floor(n / m);
  const rem = n % m;
  const out: Array<{ host: string; browserId: number }> = [];
  let offset = 0;
  for (let i = 0; i < m; i++) {
    const count = base + (i < rem ? 1 : 0);
    const browserId = browserIds[i]!;
    for (let j = 0; j < count; j++) {
      out.push({ host: hosts[offset + j]!, browserId });
    }
    offset += count;
  }
  return out;
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const hosts = splitConfigLines(groupConfig.hosts);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const maxCount = parsePositiveIntConfig(groupConfig.max_count, 50);

  if (hosts.length === 0) {
    return { succ: false, msg: '请至少填写一个 Facebook 小组主页地址' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请选择至少一台浏览器' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const assignments = assignHostsEvenly(hosts, browserIds);
  const tasks: TaskCreateInput[] = assignments.map(({ host, browserId }) => ({
    gid,
    cmd: manifest.cmd,
    deviceId: browserId,
    target: manifest.target,
    config: { host, max_count: maxCount, _gid: gid },
    planStartAt: nowSec,
  }));

  const base = Math.floor(hosts.length / browserIds.length);
  const rem = hosts.length % browserIds.length;
  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (even split ≈${base}${rem ? `~${base + 1}` : ''} per browser, asap)`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
