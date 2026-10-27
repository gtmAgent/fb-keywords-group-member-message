/**
 * Facebook 私信：打开对方会话 → 可选 E2EE PIN（固定 123456）→ 输入文案 → 可选附图 → 发送。
 * 定位优先语言无关结构（role / contenteditable / 稳定 id / Enter）；门槛 CTA 用几何点击。
 * 多行文案：用 pasteText / insertText 整段写入（禁止 typeInNode，避免 \n 被当成 Enter 连发多条气泡）。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const HARDCODED_PIN = '123456';

/** 会话底部 Lexical 输入框（语言无关） */
const composerPath = nodePath()
  .css('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]')
  .one();

/** PIN 输入：稳定 id + autocomplete（语言无关） */
const pinInputPath = nodePath()
  .css(
    'input#mw-numeric-code-input-prevent-composer-focus-steal',
    'input[autocomplete="one-time-code"][maxlength="6"]',
  )
  .one();

const logoutFormPath = nodePath().css('form[action*="logout.php"]').one();
const fileInputPath = nodePath().css('input[type="file"]').one();

type NodePathBuilt = ReturnType<typeof nodePath>;

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function nodeCount(client: XportBrowserClient, path: NodePathBuilt): Promise<number> {
  const [ok, , n] = await client.getNodeCount(0, path);
  return ok ? (n ?? 0) : 0;
}

async function evalJson<T>(client: XportBrowserClient, javaScript: string): Promise<T | null> {
  const [ok, , raw] = await client.evaluateInPage(0, javaScript);
  if (!ok || raw == null || raw === '') return null;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/** 将主页 / 用户标识转为 Messenger 会话入口。 */
function toMessagesUrl(host: string, socialHome: string): string | null {
  const raw = host.trim();
  if (!raw) return null;

  const home = (socialHome || 'https://www.facebook.com').replace(/\/+$/, '');

  if (/^https?:\/\//i.test(raw) || raw.includes('facebook.com') || raw.includes('messenger.com')) {
    let url: URL;
    try {
      url = new URL(raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`);
    } catch {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path.includes('/messages/')) {
      return url.toString();
    }
    const id = url.searchParams.get('id');
    if ((path.includes('profile.php') || path.endsWith('/profile.php')) && id) {
      return `${home}/messages/t/${encodeURIComponent(id)}`;
    }
    const segs = path.split('/').filter(Boolean);
    const first = segs[0] ?? '';
    const reserved = new Set([
      'messages',
      'watch',
      'groups',
      'reel',
      'reels',
      'photo',
      'photos',
      'marketplace',
      'gaming',
      'settings',
      'login',
      'checkpoint',
    ]);
    if (first && !reserved.has(first.toLowerCase()) && segs.length <= 2) {
      return `${home}/messages/t/${encodeURIComponent(first)}`;
    }
    return null;
  }

  if (/^\d+$/.test(raw)) {
    return `${home}/messages/t/${raw}`;
  }
  if (/^[\w.]+$/.test(raw)) {
    return `${home}/messages/t/${encodeURIComponent(raw)}`;
  }
  return null;
}

function normalizeImageMd5(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0] ?? '').trim();
  return '';
}

async function markLoggedIn(client: XportBrowserClient): Promise<void> {
  try {
    await client.mutateDeviceLabels({ remove: ['未登录'], add: ['已登录'] });
  } catch (e) {
    client.taskLog(`mutateDeviceLabels: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function markLoggedOut(client: XportBrowserClient): Promise<void> {
  try {
    await client.mutateDeviceLabels({ remove: ['已登录'], add: ['未登录'] });
  } catch (e) {
    client.taskLog(`mutateDeviceLabels: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type PageReadyKind = 'composer' | 'pin' | 'modal' | 'gate' | 'none';

/** 可见性：避免隐藏/零尺寸节点误判（PIN 残留 DOM 会挡住 Continue 门槛）。 */
const VISIBLE_JS = `const __vis = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};
const __topDialog = () => {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"][aria-modal="true"]')).filter(__vis);
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
};
const __labelOf = (el) => ((el.getAttribute('aria-label') || el.innerText || '') + '').replace(/\\s+/g, ' ').trim();
`;

/** 语言无关：用 DOM 结构判断当前态（输入框 / 可见 PIN / 阻塞弹窗 / 底部宽按钮门槛）。 */
async function detectPageReady(client: XportBrowserClient): Promise<PageReadyKind> {
  const state = await evalJson<{ kind: PageReadyKind }>(
    client,
    `(() => {
      ${VISIBLE_JS}
      const pins = Array.from(document.querySelectorAll(
        '#mw-numeric-code-input-prevent-composer-focus-steal, input[autocomplete="one-time-code"][maxlength="6"]'
      )).filter(__vis);
      // 可见 PIN 优先（含恢复历史 PIN）；隐藏 PIN 不挡后续
      if (pins.length > 0) return JSON.stringify({ kind: 'pin' });
      // 聊天历史恢复等 modal 会盖住输入框；即使底层已有 composer 也须先关掉
      if (__topDialog()) return JSON.stringify({ kind: 'modal' });
      const composer = document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
      if (__vis(composer)) return JSON.stringify({ kind: 'composer' });
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      let bestW = 0;
      for (const b of buttons) {
        if (b.closest('div[role="dialog"][aria-modal="true"]')) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 140 || r.height < 30 || r.height > 100) continue;
        if (r.bottom < innerHeight * 0.35 || r.top > innerHeight * 0.99) continue;
        if (r.width > bestW) bestW = r.width;
      }
      if (bestW >= 160) return JSON.stringify({ kind: 'gate' });
      return JSON.stringify({ kind: 'none' });
    })()`,
  );
  return state?.kind ?? 'none';
}

/**
 * 关掉阻塞发信的弹窗（历史恢复 / Sleep mode 等；先关再 Continue）。
 * 文案匹配仅用当场观察过的英文；结构兜底：单主按钮 / Cancel 对侧 / 双按钮左侧 / Close。
 */
async function dismissBlockingDialog(
  client: XportBrowserClient,
): Promise<'dismissed' | 'pin_in_dialog' | 'none' | 'error'> {
  const res = await evalJson<{ action: string; label?: string }>(
    client,
    `(() => {
      ${VISIBLE_JS}
      const dialog = __topDialog();
      if (!dialog) return JSON.stringify({ action: 'none' });

      const pin = dialog.querySelector(
        '#mw-numeric-code-input-prevent-composer-focus-steal, input[autocomplete="one-time-code"][maxlength="6"]'
      );
      if (pin && __vis(pin)) return JSON.stringify({ action: 'pin_in_dialog' });

      const buttons = Array.from(dialog.querySelectorAll('div[role="button"]')).filter(__vis);
      // 优先安全/确认关闭（当场英文证据：Not now / Don't restore / Sleep mode OK）
      const preferExact = ['Not now', "Don't restore messages", 'Don’t restore messages', 'OK'];
      for (const want of preferExact) {
        const hit = buttons.find((b) => __labelOf(b) === want);
        if (hit) {
          hit.click();
          return JSON.stringify({ action: 'prefer', label: want });
        }
      }

      // Continue without restoring? → Cancel 对侧主按钮
      const cancel = buttons.find((b) => /^Cancel$/i.test(__labelOf(b)));
      if (cancel) {
        const actionBtns = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          const dr = dialog.getBoundingClientRect();
          if (r.width < 72 || r.height < 28 || r.height > 90) return false;
          return r.top > dr.top + dr.height * 0.4;
        });
        const other = actionBtns.find((b) => b !== cancel && !/^Close$/i.test(__labelOf(b)));
        if (other) {
          other.click();
          return JSON.stringify({ action: 'vs_cancel', label: __labelOf(other) });
        }
      }

      const close = buttons.find((b) => __labelOf(b) === 'Close');
      if (close) {
        close.click();
        return JSON.stringify({ action: 'close' });
      }

      // 结构兜底：弹窗底部宽按钮
      const bottom = buttons
        .filter((b) => {
          const r = b.getBoundingClientRect();
          const dr = dialog.getBoundingClientRect();
          if (r.width < 80 || r.height < 28 || r.height > 90) return false;
          if (/^Close$/i.test(__labelOf(b))) return false;
          if (/see options/i.test(__labelOf(b))) return false;
          if (/reset chat/i.test(__labelOf(b))) return false;
          return r.top > dr.top + dr.height * 0.45;
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      // 单主按钮（如 Sleep mode）：语言无关点唯一底部 CTA
      if (bottom.length === 1) {
        bottom[0].click();
        return JSON.stringify({ action: 'single_primary', label: __labelOf(bottom[0]) });
      }
      // 两个宽按钮时点左侧（Not now / 次要），避免点 Reset / See options
      if (bottom.length >= 2) {
        bottom[0].click();
        return JSON.stringify({ action: 'left_secondary', label: __labelOf(bottom[0]) });
      }

      return JSON.stringify({ action: 'none' });
    })()`,
  );
  if (!res) return 'error';
  if (res.action === 'pin_in_dialog') return 'pin_in_dialog';
  if (res.action === 'none') return 'none';
  return 'dismissed';
}

/** 可见 PIN 输入数量（与 detect 一致，避免 nodeCount 命中隐藏节点）。 */
async function visiblePinCount(client: XportBrowserClient): Promise<number> {
  const state = await evalJson<{ n: number }>(
    client,
    `(() => {
      ${VISIBLE_JS}
      const pins = Array.from(document.querySelectorAll(
        '#mw-numeric-code-input-prevent-composer-focus-steal, input[autocomplete="one-time-code"][maxlength="6"]'
      )).filter(__vis);
      return JSON.stringify({ n: pins.length });
    })()`,
  );
  return state?.n ?? 0;
}

/** 向可见 PIN 框填入固定码；失败返回 false（调用方应改走 gate，勿硬失败）。 */
async function typeHardcodedPin(client: XportBrowserClient): Promise<boolean> {
  if ((await visiblePinCount(client)) < 1) return false;
  const [clickOk] = await client.clickNode(0, pinInputPath);
  if (!clickOk) return false;
  await sleep(350);
  // 优先整段输入；失败再逐位按键（部分 E2EE 数字框对 typeInNode 不稳定）
  const [typeOk] = await client.typeInNode(0, pinInputPath, HARDCODED_PIN);
  if (typeOk) return true;
  for (const ch of HARDCODED_PIN) {
    const [kOk] = await client.pressKey(0, ch);
    if (!kOk) return false;
    await sleep(80);
  }
  return true;
}

async function waitForMessengerReady(
  client: XportBrowserClient,
  timeoutMs: number,
): Promise<PageReadyKind> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const kind = await detectPageReady(client);
    if (kind !== 'none') return kind;
    if ((await nodeCount(client, logoutFormPath)) >= 1) {
      // 已登录但会话区仍在加载
      await sleep(800);
      continue;
    }
    await sleep(700);
  }
  return detectPageReady(client);
}

/**
 * 语言无关门槛：在尚无输入框时，点击视口下部最宽的 role=button（Continue / Create PIN 等主 CTA）。
 */
/** 关掉最上层 aria-modal 弹窗（Close / Escape），用于恢复历史 PIN 与固定码不符时。 */
async function closeTopDialog(client: XportBrowserClient): Promise<'closed' | 'none'> {
  const res = await evalJson<{ action: string }>(
    client,
    `(() => {
      ${VISIBLE_JS}
      const dialog = __topDialog();
      if (!dialog) return JSON.stringify({ action: 'none' });
      const close = Array.from(dialog.querySelectorAll('div[role="button"]'))
        .filter(__vis)
        .find((b) => __labelOf(b) === 'Close');
      if (close) {
        close.click();
        return JSON.stringify({ action: 'close' });
      }
      return JSON.stringify({ action: 'none' });
    })()`,
  );
  if (res?.action === 'close') return 'closed';
  await client.pressKey(0, 'Escape');
  return 'closed';
}

async function clickPrimaryGateCta(client: XportBrowserClient): Promise<'clicked' | 'none' | 'error'> {
  const res = await evalJson<{ action: string; w?: number }>(
    client,
    `(() => {
      ${VISIBLE_JS}
      if (__topDialog()) return JSON.stringify({ action: 'none' });
      const composer = document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
      if (__vis(composer)) return JSON.stringify({ action: 'none' });
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      let best = null;
      let bestScore = 0;
      for (const b of buttons) {
        if (b.closest('div[role="dialog"][aria-modal="true"]')) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 140 || r.height < 30 || r.height > 100) continue;
        if (r.bottom < innerHeight * 0.35 || r.top > innerHeight * 0.99) continue;
        // 偏好底部宽按钮（Continue / Create PIN）
        const score = r.width * (0.5 + r.bottom / innerHeight);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (!best) return JSON.stringify({ action: 'none' });
      best.click();
      const r = best.getBoundingClientRect();
      return JSON.stringify({ action: 'clicked', w: Math.round(r.width) });
    })()`,
  );
  if (!res) return 'error';
  return res.action === 'clicked' ? 'clicked' : 'none';
}

/** 可选：历史恢复弹窗 / PIN / Continue 门槛；有则处理，无则跳过。 */
async function handleOptionalGates(client: XportBrowserClient): Promise<AutomationRunResult | null> {
  for (let round = 0; round < 10; round++) {
    const kind = await detectPageReady(client);
    if (kind === 'composer') return null;

    if (kind === 'modal') {
      client.taskLog(`modal: dismiss history/restore blocker (round ${round + 1})`);
      const act = await dismissBlockingDialog(client);
      if (act === 'error') {
        return failStep(client, 'dismiss_modal', 'Failed to dismiss Messenger dialog', 'ELEMENT_NOT_FOUND');
      }
      if (act === 'pin_in_dialog') {
        // 恢复历史 PIN 弹窗：先试固定 PIN，失败再关弹窗继续发信
        client.taskLog('modal: PIN inside dialog → try hardcoded pin');
        const typed = await typeHardcodedPin(client);
        if (!typed) {
          client.taskLog('modal: PIN type missed → close dialog');
          await dismissBlockingDialog(client);
        }
        await sleep(1200);
        await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
        continue;
      }
      if (act === 'dismissed') {
        await sleep(1200);
        await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
        continue;
      }
      // 无法识别控件：Escape 再试一轮
      client.taskLog('modal: no known control → Escape');
      await client.pressKey(0, 'Escape');
      await sleep(900);
      continue;
    }

    if (kind === 'pin') {
      client.taskLog(`PIN: enter hardcoded pin (round ${round + 1})`);
      const typed = await typeHardcodedPin(client);
      if (!typed) {
        // 常见：PIN 框刚消失、已切到 Continue；勿 ELEMENT_NOT_FOUND 中止
        client.taskLog('PIN: type missed (field gone?) → try gate CTA / close dialog');
        const act = await clickPrimaryGateCta(client);
        if (act === 'clicked') {
          await sleep(1400);
          await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
          continue;
        }
        // 恢复历史 PIN 弹窗：关窗后仍可发新消息
        await closeTopDialog(client);
        await sleep(900);
        continue;
      }
      await sleep(1000);
      await client.waitForDomQuiet(0, { stableMs: 400, timeoutMs: 6000 });
      const afterPin = await detectPageReady(client);
      // PIN 填完后常出现 Continue：立刻尝试门槛，避免下一轮再误判 PIN
      if (afterPin === 'gate') {
        client.taskLog('gate: after PIN → click primary CTA');
        const act = await clickPrimaryGateCta(client);
        if (act === 'clicked') {
          await sleep(1400);
          await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
        }
        continue;
      }
      // 仍停在 PIN（常见：恢复历史 PIN 与固定 123456 不符）→ 关弹窗继续发信
      if (afterPin === 'pin' && round >= 1) {
        client.taskLog('PIN: still visible after type → close restore dialog');
        await closeTopDialog(client);
        await sleep(1000);
        await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
      }
      continue;
    }

    if (kind === 'gate') {
      client.taskLog('gate: click primary CTA (structure/geometry)');
      const act = await clickPrimaryGateCta(client);
      if (act === 'error') {
        return failStep(client, 'gate_cta', 'Failed to click gate CTA', 'ELEMENT_NOT_FOUND');
      }
      if (act === 'clicked') {
        await sleep(1400);
        await client.waitForDomQuiet(0, { stableMs: 500, timeoutMs: 8000 });
        continue;
      }
    }

    // 仍无输入框时再尝试一次门槛（含 messages/new 过渡态）；有 modal 时勿点
    if (
      (await nodeCount(client, composerPath)) < 1 &&
      (await visiblePinCount(client)) < 1 &&
      (await detectPageReady(client)) !== 'modal'
    ) {
      const act = await clickPrimaryGateCta(client);
      if (act === 'clicked') {
        await sleep(1400);
        continue;
      }
    }
    break;
  }
  return null;
}

async function ensureComposer(client: XportBrowserClient): Promise<AutomationRunResult | null> {
  // 弹窗可能盖住已存在的 composer DOM，先清阻塞
  if ((await detectPageReady(client)) !== 'composer') {
    await handleOptionalGates(client);
  }
  if ((await detectPageReady(client)) === 'composer') return null;
  if ((await nodeCount(client, composerPath)) >= 1 && (await detectPageReady(client)) === 'composer') {
    return null;
  }

  const [waitOk] = await client.waitForSelector(0, {
    selector: 'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
    timeoutMs: 25_000,
    visible: true,
  });
  if (waitOk && (await detectPageReady(client)) === 'composer') return null;

  // 可能仍被门槛/弹窗挡住
  await handleOptionalGates(client);
  if ((await detectPageReady(client)) === 'composer') return null;

  const [waitOk2] = await client.waitForSelector(0, {
    selector: 'div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]',
    timeoutMs: 12_000,
    visible: true,
  });
  if (!waitOk2 || (await detectPageReady(client)) !== 'composer') {
    if ((await detectPageReady(client)) !== 'composer') {
      return failStep(
        client,
        'open_composer',
        'Message box not found. Please confirm the account can message this user.',
        'ELEMENT_NOT_FOUND',
      );
    }
  }
  return null;
}

async function composerHasText(client: XportBrowserClient): Promise<boolean> {
  const state = await evalJson<{ has: boolean }>(
    client,
    `(() => {
      const box = document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
      if (!box) return JSON.stringify({ has: false });
      const text = (box.innerText || '').replace(/\\u200b/g, '').trim();
      return JSON.stringify({ has: text.length > 0 });
    })()`,
  );
  return !!state?.has;
}

async function composerIsEmpty(client: XportBrowserClient): Promise<boolean> {
  return !(await composerHasText(client));
}

/** 清空 Lexical 输入框（粘贴前避免追加到旧草稿）。 */
async function clearComposer(client: XportBrowserClient): Promise<void> {
  await evalJson(
    client,
    `(() => {
      const box = document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
      if (!box) return JSON.stringify({ ok: false });
      box.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      try { document.execCommand('delete'); } catch (_) {}
      return JSON.stringify({ ok: true });
    })()`,
  );
  await sleep(200);
}

/**
 * 将整段 message（可含换行）一次写入输入框，作为一条气泡内容。
 * 优先 pasteText；失败再用 insertText。禁止 typeInNode / typeText（\n 在 Messenger 会触发发送）。
 */
async function fillComposerMessage(
  client: XportBrowserClient,
  message: string,
): Promise<{ ok: boolean; detail: string }> {
  await clearComposer(client);
  await sleep(200);

  const [pasteOk, pasteMsg] = await client.pasteText(0, composerPath, message);
  await sleep(500);
  if (pasteOk && (await composerHasText(client))) {
    return { ok: true, detail: 'pasteText' };
  }
  client.taskLog(`pasteText miss: ok=${pasteOk} msg=${pasteMsg || ''} → try insertText`);

  await client.clickNode(0, composerPath);
  await sleep(300);
  await clearComposer(client);
  const [insOk, insMsg] = await client.insertText(0, message);
  await sleep(500);
  if (insOk && (await composerHasText(client))) {
    return { ok: true, detail: 'insertText' };
  }
  return { ok: false, detail: insMsg || pasteMsg || 'Failed to fill message into composer' };
}

/** 语言无关：点击输入框右侧邻近的发送按钮（纸飞机），作 Enter 的兜底。 */
async function clickSendNearComposer(client: XportBrowserClient): Promise<boolean> {
  const res = await evalJson<{ action: string }>(
    client,
    `(() => {
      const box = document.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
      if (!box) return JSON.stringify({ action: 'none' });
      const br = box.getBoundingClientRect();
      let root = box.parentElement;
      for (let depth = 0; depth < 8 && root; depth++) {
        const buttons = Array.from(root.querySelectorAll('div[role="button"]'));
        const candidates = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          if (r.width < 20 || r.width > 72 || r.height < 20 || r.height > 72) return false;
          if (r.left < br.right - 8) return false;
          if (Math.abs(r.top + r.height / 2 - (br.top + br.height / 2)) > 48) return false;
          return true;
        });
        if (candidates.length > 0) {
          candidates[candidates.length - 1].click();
          return JSON.stringify({ action: 'clicked' });
        }
        root = root.parentElement;
      }
      return JSON.stringify({ action: 'none' });
    })()`,
  );
  return res?.action === 'clicked';
}

async function attachOptionalImage(
  client: XportBrowserClient,
  imageMd5: string,
): Promise<AutomationRunResult | null> {
  if (!imageMd5) return null;
  client.taskLog(`attach image md5=${imageMd5.slice(0, 8)}…`);

  const [clickOk] = await client.clickNode(0, composerPath);
  if (!clickOk) {
    return failStep(client, 'attach_image', 'Failed to focus message box before attach', 'ELEMENT_NOT_FOUND');
  }
  await sleep(500);

  const fileN = await nodeCount(client, fileInputPath);
  if (fileN >= 1) {
    const [upOk, upMsg] = await client.uploadFile(0, fileInputPath, imageMd5);
    if (!upOk) {
      return failStep(client, 'attach_image', upMsg || 'uploadFile failed', 'UNKNOWN');
    }
  } else {
    const [pasteOk, pasteMsg] = await client.pasteClipboardBinary(0, composerPath, imageMd5);
    if (!pasteOk) {
      return failStep(client, 'attach_image', pasteMsg || 'pasteClipboardBinary failed', 'UNKNOWN');
    }
  }
  await sleep(1200);
  await client.waitForDomQuiet(0, { stableMs: 600, timeoutMs: 10_000 });
  return null;
}

async function sendMessage(client: XportBrowserClient): Promise<AutomationRunResult | null> {
  /** 触发一次发送：优先 Enter；按键 API 失败才点纸飞机。本轮默认只触发一次，避免断网连发。 */
  const triggerSendOnce = async (): Promise<boolean> => {
    const [enterOk, enterMsg] = await client.pressKey(0, 'Enter');
    if (enterOk) return true;
    client.taskLog(`press Enter failed: ${enterMsg}; try geometry send`);
    return await clickSendNearComposer(client);
  };

  const waitComposerCleared = async (rounds: number): Promise<boolean> => {
    await sleep(900);
    for (let i = 0; i < rounds; i++) {
      if (await composerIsEmpty(client)) return true;
      await sleep(400);
    }
    return false;
  };

  if (!(await triggerSendOnce())) {
    return failStep(client, 'send_message', 'Failed to trigger send (Enter / send button)', 'ELEMENT_NOT_FOUND');
  }
  if (await waitComposerCleared(20)) return null;

  // 仅当发送被门槛弹窗挡住时，关掉后再触发一次；断网/未清空勿再按 Enter（会重复气泡）
  const blocked = await detectPageReady(client);
  if (blocked === 'modal' || blocked === 'pin') {
    client.taskLog('send: blocker dialog while composer has text → dismiss then send once more');
    await handleOptionalGates(client);
    await sleep(600);
    await client.clickNode(0, composerPath);
    await sleep(400);
    if (!(await triggerSendOnce())) {
      return failStep(client, 'send_message', 'Failed to trigger send after dismissing dialog', 'ELEMENT_NOT_FOUND');
    }
    if (await waitComposerCleared(16)) return null;
  }

  client.taskLog('send: composer still has text after one send — not retrying (avoid duplicate bubbles)');
  return failStep(
    client,
    'verify_sent',
    'Message may not have been sent (composer still has text; not retrying send to avoid duplicates).',
    'UNKNOWN',
  );
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const host = String(taskConfig.host ?? '').trim();
  const message = String(taskConfig.message ?? '').trim();
  const imageMd5 = normalizeImageMd5(taskConfig.image);
  const socialHome = Bun.env.SOCIAL_HOME?.trim() || 'https://www.facebook.com';

  client.taskLog(`host=${host || '(empty)'} messageLen=${message.length} image=${imageMd5 ? 'yes' : 'no'}`);

  if (!host) {
    return automationFailWithContext('Profile URL is required', {
      code: 'UNKNOWN',
      step: 'validate_host',
    });
  }
  if (!message) {
    return automationFailWithContext('Message text is required', {
      code: 'UNKNOWN',
      step: 'validate_message',
    });
  }

  const messagesUrl = toMessagesUrl(host, socialHome);
  if (!messagesUrl) {
    return automationFailWithContext(
      'Unsupported profile URL. Use profile.php?id=… or facebook.com/username',
      { code: 'UNKNOWN', step: 'validate_host', labels: { host } },
    );
  }
  client.taskLog(`messagesUrl=${messagesUrl}`);

  try {
    const [goOk, goMsg] = await client.pageGoTo(0, {
      url: messagesUrl,
      timeoutMs: 75_000,
      wait: 'domcontentloaded',
    });
    if (!goOk) {
      return failStep(client, 'open_messages', goMsg || 'pageGoTo failed', 'NAV_FAILED', { host, messagesUrl });
    }
    await sleep(1500);
    await client.waitForDomQuiet(0, { stableMs: 600, timeoutMs: 12_000 });

    const [urlOk, , pageUrl] = await client.getPageUrl();
    const currentUrl = urlOk && pageUrl ? pageUrl : '';
    if (/\/login|checkpoint|two_factor|auth_platform/i.test(currentUrl)) {
      await markLoggedOut(client);
      return failStep(
        client,
        'check_login',
        'Facebook account not logged in or restricted. Please log in on this browser first.',
        'NOT_LOGGED_IN',
        { host, url: currentUrl },
      );
    }

    let ready = await waitForMessengerReady(client, 35_000);
    const logoutN = await nodeCount(client, logoutFormPath);
    if (ready === 'none' && logoutN < 1) {
      await markLoggedOut(client);
      return failStep(
        client,
        'check_login',
        'Unable to open Messenger. Please confirm the browser is logged in to Facebook.',
        'NOT_LOGGED_IN',
        { host, url: currentUrl },
      );
    }
    await markLoggedIn(client);

    if (ready !== 'composer') {
      const gateFail = await handleOptionalGates(client);
      if (gateFail) return gateFail;
      ready = await detectPageReady(client);
    }

    const composerFail = await ensureComposer(client);
    if (composerFail) return composerFail;

    // 聚焦 + 输入（带一次重试）
    let focused = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const [focusOk, focusMsg] = await client.clickNode(0, composerPath);
      if (!focusOk) {
        if (attempt === 1) {
          return failStep(client, 'focus_composer', focusMsg || 'Failed to click message box', 'ELEMENT_NOT_FOUND');
        }
        await sleep(800);
        continue;
      }
      focused = true;
      break;
    }
    if (!focused) {
      return failStep(client, 'focus_composer', 'Failed to focus message box', 'ELEMENT_NOT_FOUND');
    }
    await sleep(500);

    let fill = await fillComposerMessage(client, message);
    if (!fill.ok) {
      // 偶发未写入：再粘贴一次（仍禁止 typeInNode）
      await client.clickNode(0, composerPath);
      await sleep(400);
      fill = await fillComposerMessage(client, message);
      if (!fill.ok) {
        return failStep(client, 'type_message', fill.detail || 'Message not present in composer', 'ELEMENT_NOT_FOUND');
      }
    }
    client.taskLog(`composer filled via ${fill.detail}`);
    await sleep(700);

    const attachFail = await attachOptionalImage(client, imageMd5);
    if (attachFail) return attachFail;

    if (imageMd5 && !(await composerHasText(client))) {
      await client.clickNode(0, composerPath);
      await sleep(400);
      const refill = await fillComposerMessage(client, message);
      if (!refill.ok) {
        return failStep(client, 'type_message', refill.detail || 'Message lost after attach', 'ELEMENT_NOT_FOUND');
      }
      await sleep(600);
    }

    // 确保焦点仍在输入框再发送（整段只触发一次发送）
    await client.clickNode(0, composerPath);
    await sleep(350);

    const sendFail = await sendMessage(client);
    if (sendFail) return sendFail;

    const [, , finalUrl] = await client.getPageUrl();
    client.taskLog(`sent ok finalUrl=${finalUrl ?? ''}`);

    return {
      succ: true,
      msg: 'Message sent',
      data: {
        host,
        messagesUrl,
        finalUrl: finalUrl ?? '',
        hasImage: imageMd5 ? 'yes' : 'no',
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failStep(client, 'unexpected', reason, 'UNKNOWN', { host });
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
