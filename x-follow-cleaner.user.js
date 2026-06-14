// ==UserScript==
// @name         X Follow Cleaner Local
// @namespace    local.x.follow.cleaner
// @version      0.4.1
// @description  本地优先的 X 互关清理、白名单、批量取关和批量回关工具。
// @author       baor87492-star
// @match        https://x.com/*
// @match        https://twitter.com/*
// @downloadURL  https://cdn.jsdelivr.net/gh/baor87492-star/x-follow-cleaner@main/x-follow-cleaner.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/baor87492-star/x-follow-cleaner@main/x-follow-cleaner.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'x-follow-cleaner-state-v1';
  const UI_ID = 'xfc-panel';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let scanMap = new Map();
  let followBackMap = new Map();
  let scanning = false;
  let unfollowing = false;
  let followingBack = false;

  const zh = {
    followsYou: '\u5173\u6ce8\u4e86\u4f60',
    following: '\u6b63\u5728\u5173\u6ce8',
    followBack: '\u56de\u5173',
    unfollow: '\u53d6\u5173',
    verified: '\u8ba4\u8bc1\u8d26\u53f7',
  };

  function normalizeHandle(value) {
    if (!value) return '';
    const raw = String(value).trim();
    const urlMatch = raw.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
    const handle = urlMatch ? urlMatch[1] : raw.replace(/^@/, '').split(/[,\s]/)[0];
    return handle.replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  }

  function isFollowingPage(url = location.href) {
    try {
      const parsed = new URL(url);
      return /^(x|twitter)\.com$/i.test(parsed.hostname) && /^\/[A-Za-z0-9_]+\/following\/?$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isFollowersPage(url = location.href) {
    try {
      const parsed = new URL(url);
      return /^(x|twitter)\.com$/i.test(parsed.hostname) && /^\/[A-Za-z0-9_]+\/followers\/?$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isVerifiedFollowersPage(url = location.href) {
    try {
      const parsed = new URL(url);
      return /^(x|twitter)\.com$/i.test(parsed.hostname) && /^\/[A-Za-z0-9_]+\/(verified_followers|followers_verified|followers\/verified)\/?$/.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function getFollowingUrl(handle) {
    const clean = normalizeHandle(handle);
    return clean ? `https://x.com/${clean}/following` : '';
  }

  function getFollowersUrl(handle) {
    const clean = normalizeHandle(handle);
    return clean ? `https://x.com/${clean}/followers` : '';
  }

  function getVerifiedFollowersUrl(handle) {
    const clean = normalizeHandle(handle);
    return clean ? `https://x.com/${clean}/verified_followers` : '';
  }

  function inferHandleFromPage() {
    const pathMatch = location.pathname.match(/^\/([A-Za-z0-9_]+)/);
    const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search']);
    if (pathMatch && !reserved.has(pathMatch[1])) return pathMatch[1];
    return '';
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return {
        keep: parsed?.keep || [],
        selected: parsed?.selected || [],
        done: parsed?.done || [],
        followSelected: parsed?.followSelected || [],
        followDone: parsed?.followDone || [],
        view: parsed?.view || '',
        batchSize: parsed?.batchSize || 10,
        delayMs: parsed?.delayMs || 4500,
      };
    } catch {
      return { keep: [], selected: [], done: [], followSelected: [], followDone: [], view: '', batchSize: 10, delayMs: 4500 };
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function stateSets() {
    const state = loadState();
    return {
      state,
      keep: new Set(state.keep.map(normalizeHandle)),
      selected: new Set(state.selected.map(normalizeHandle)),
      done: new Set(state.done.map(normalizeHandle)),
      followSelected: new Set((state.followSelected || []).map(normalizeHandle)),
      followDone: new Set((state.followDone || []).map(normalizeHandle)),
    };
  }

  function persistSets({ keep, selected, done, followSelected, followDone, view, batchSize, delayMs }) {
    const old = loadState();
    saveState({
      keep: [...(keep || old.keep || [])].filter(Boolean).sort(),
      selected: [...(selected || old.selected || [])].filter(Boolean).sort(),
      done: [...(done || old.done || [])].filter(Boolean).sort(),
      followSelected: [...(followSelected || old.followSelected || [])].filter(Boolean).sort(),
      followDone: [...(followDone || old.followDone || [])].filter(Boolean).sort(),
      view: view !== undefined ? view : old.view || '',
      batchSize: Number(batchSize || old.batchSize || 10),
      delayMs: Number(delayMs || old.delayMs || 4500),
    });
  }

  function parseVisibleAccounts() {
    const accounts = [];
    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      const text = cell.innerText || '';
      const link = [...cell.querySelectorAll('a[href^="/"]')].find((anchor) => /^\/[A-Za-z0-9_]+$/.test(anchor.getAttribute('href') || ''));
      if (!link) return;
      const handle = normalizeHandle(link.getAttribute('href'));
      if (!handle) return;
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      const handleIndex = lines.findIndex((line) => normalizeHandle(line) === handle || line.toLowerCase() === `@${handle}`);
      const name = handleIndex > 0 ? lines[handleIndex - 1] : lines[0] || '';
      const buttonTexts = [...cell.querySelectorAll('button[role="button"], div[role="button"]')].map((button) => `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`);
      const canFollowBack = buttonTexts.some((buttonText) => buttonText.includes(zh.followBack) || /follow back/i.test(buttonText));
      const verified = text.includes(zh.verified) || /verified/i.test(text) || Boolean(cell.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified"], svg[aria-label*="\u8ba4\u8bc1"]'));
      accounts.push({
        handle,
        name: name.replace(new RegExp(zh.verified, 'g'), '').trim(),
        followsYou: text.includes(zh.followsYou) || /follows you/i.test(text),
        canFollowBack,
        verified,
      });
    });
    return accounts;
  }

  function mergeAccounts(accounts) {
    accounts.forEach((account) => {
      const handle = normalizeHandle(account.handle);
      if (!handle) return;
      const old = scanMap.get(handle) || { handle, name: '', followsYou: false, canFollowBack: false, verified: false };
      if (account.name && !old.name) old.name = account.name;
      old.followsYou = old.followsYou || Boolean(account.followsYou);
      old.canFollowBack = old.canFollowBack || Boolean(account.canFollowBack);
      old.verified = old.verified || Boolean(account.verified);
      scanMap.set(handle, old);
    });
  }

  function mergeFollowBackAccounts(accounts, mode) {
    accounts.forEach((account) => {
      const handle = normalizeHandle(account.handle);
      if (!handle || !account.canFollowBack) return;
      const old = followBackMap.get(handle) || { handle, name: '', followsYou: false, canFollowBack: false, verified: false, mode };
      if (account.name && !old.name) old.name = account.name;
      old.followsYou = old.followsYou || Boolean(account.followsYou);
      old.canFollowBack = old.canFollowBack || Boolean(account.canFollowBack);
      old.verified = old.verified || Boolean(account.verified) || mode === 'verified';
      old.mode = mode;
      followBackMap.set(handle, old);
    });
  }

  function getNonMutual() {
    const { keep, done } = stateSets();
    return [...scanMap.values()]
      .filter((account) => !account.followsYou)
      .filter((account) => !keep.has(account.handle))
      .filter((account) => !done.has(account.handle))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  function getFollowBackCandidates(mode = '') {
    const { followDone } = stateSets();
    return [...followBackMap.values()]
      .filter((account) => account.canFollowBack)
      .filter((account) => mode !== 'verified' || account.verified || account.mode === 'verified')
      .filter((account) => !followDone.has(account.handle))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  function injectStyles() {
    if (document.querySelector('#xfc-style')) return;
    const style = document.createElement('style');
    style.id = 'xfc-style';
    style.textContent = `
      #${UI_ID}{position:fixed;right:16px;top:78px;z-index:2147483647;width:380px;max-height:82vh;color:#172033;background:#fff;border:1px solid #d8dee8;border-radius:8px;box-shadow:0 12px 36px rgba(15,23,42,.18);font:13px/1.45 Arial,sans-serif;overflow:hidden}
      #${UI_ID}.minimized .xfc-body{display:none} #${UI_ID} *{box-sizing:border-box}
      .xfc-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#172033;color:#fff}.xfc-title{font-weight:700}
      .xfc-head button,.xfc-actions button,.xfc-row button{border:0;border-radius:6px;padding:6px 9px;cursor:pointer;font-weight:700}.xfc-head button{background:#2a3448;color:#fff}
      .xfc-body{padding:12px;display:grid;gap:10px}.xfc-route{display:grid;gap:8px;padding:8px;border:1px solid #f0d58b;background:#fff8e6;border-radius:6px}.xfc-open-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.xfc-open-row input,.xfc-controls input{min-width:0;border:1px solid #d8dee8;border-radius:6px;padding:7px}.xfc-open-row button{border:0;border-radius:6px;padding:7px 10px;background:#1264d8;color:#fff;font-weight:700;cursor:pointer}
      .xfc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.xfc-stat{background:#f5f7fb;border:1px solid #e4e8f0;border-radius:6px;padding:7px}.xfc-stat strong{display:block;font-size:17px}
      .xfc-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}.xfc-controls label{display:grid;gap:4px;font-weight:700}.xfc-actions{display:flex;flex-wrap:wrap;gap:6px}.xfc-actions button{background:#1264d8;color:#fff}.xfc-actions button:disabled{background:#cbd5e1;color:#64748b;cursor:not-allowed}.xfc-actions button.secondary{background:#e9eef8;color:#18375f}.xfc-actions button.danger{background:#c9342f;color:#fff}
      .xfc-list{border:1px solid #e4e8f0;border-radius:6px;max-height:280px;overflow:auto}.xfc-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;padding:8px;border-bottom:1px solid #edf1f7}.xfc-row:last-child{border-bottom:0}.xfc-name{overflow-wrap:anywhere}.xfc-name a{color:#1264d8;text-decoration:none;font-weight:700}.xfc-row button.keep{background:#e9eef8;color:#18375f}.xfc-row button.pick{background:#fff0ef;color:#c9342f;border:1px solid #f2b7b4}.xfc-row button.pick.active{background:#c9342f;color:#fff}.xfc-log{color:#667085;min-height:18px}
    `;
    document.head.append(style);
  }

  function render() {
    injectStyles();
    let panel = document.querySelector(`#${UI_ID}`);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = UI_ID;
      document.body.append(panel);
    }
    const { state, keep, selected } = stateSets();
    const all = [...scanMap.values()];
    const nonMutual = getNonMutual();
    const onFollowingPage = isFollowingPage();
    const onFollowersPage = isFollowersPage();
    const onVerifiedFollowersPage = isVerifiedFollowersPage();
    const activeView = onFollowingPage ? '' : onVerifiedFollowersPage ? 'followBackVerified' : onFollowersPage ? 'followBackAll' : state.view;
    const followMode = activeView === 'followBackVerified' ? 'verified' : activeView === 'followBackAll' ? 'all' : '';
    const followCandidates = getFollowBackCandidates(followMode);
    const followSelected = stateSets().followSelected;
    const inferredHandle = inferHandleFromPage();
    const nonMutualRows = nonMutual.slice(0, 80).map((account) => `
      <div class="xfc-row" data-handle="${account.handle}">
        <div class="xfc-name">${escapeHtml(account.name || '-')}<br><a href="https://x.com/${account.handle}" target="_blank">@${account.handle}</a></div>
        <button class="keep" data-act="keep">保留</button>
        <button class="pick ${selected.has(account.handle) ? 'active' : ''}" data-act="pick">${selected.has(account.handle) ? '已选' : '取关'}</button>
      </div>`).join('');
    const followRows = followCandidates.slice(0, 80).map((account) => `
      <div class="xfc-row" data-handle="${account.handle}">
        <div class="xfc-name">${escapeHtml(account.name || '-')}<br><a href="https://x.com/${account.handle}" target="_blank">@${account.handle}</a></div>
        <button class="keep" data-act="skip-followback">跳过</button>
        <button class="pick ${followSelected.has(account.handle) ? 'active' : ''}" data-act="pick-followback">${followSelected.has(account.handle) ? '已选' : '回关'}</button>
      </div>`).join('');
    const routePrompt = !onFollowingPage && !onFollowersPage && !onVerifiedFollowersPage;

    panel.innerHTML = `
      <div class="xfc-head"><span class="xfc-title">X 互关清理助手</span><button data-act="minimize">收起</button></div>
      <div class="xfc-body">
        ${routePrompt ? `<div class="xfc-route"><div class="xfc-log">输入账号，然后选择要打开的页面。</div><div class="xfc-open-row"><input id="xfc-handle-input" placeholder="@你的用户名" value="${escapeHtml(inferredHandle ? `@${inferredHandle}` : '')}"><button data-act="open-following">正在关注</button><button data-act="open-verified-followers">认证关注者</button><button data-act="open-followers">所有关注者</button></div></div>` : ''}
        <div class="xfc-stats"><div class="xfc-stat"><strong>${all.length}</strong>已扫关注</div><div class="xfc-stat"><strong>${nonMutual.length}</strong>未互关</div><div class="xfc-stat"><strong>${followCandidates.length}</strong>可回关</div></div>
        <div class="xfc-controls"><label>本次数量<input id="xfc-batch" type="number" min="1" max="100" value="${state.batchSize}"></label><label>间隔毫秒<input id="xfc-delay" type="number" min="2000" max="60000" step="500" value="${state.delayMs}"></label></div>
        <div class="xfc-actions"><button class="secondary" data-act="view-following">查看未互关</button><button class="secondary" data-act="view-followback-verified">查看认证回关</button><button class="secondary" data-act="view-followback-all">查看全部回关</button></div>
        <div class="xfc-actions"><button data-act="scan" ${onFollowingPage ? '' : 'disabled'}>扫描正在关注</button><button class="secondary" data-act="select-all">全选未互关</button><button class="secondary" data-act="export-keep">导出白名单</button><button class="secondary" data-act="import-keep">导入白名单</button><button class="secondary" data-act="export-nonmutual">导出未互关</button><button class="danger" data-act="unfollow" ${onFollowingPage ? '' : 'disabled'}>开始取关</button></div>
        <div class="xfc-actions"><button data-act="scan-followback-verified" ${onVerifiedFollowersPage ? '' : 'disabled'}>扫描认证关注者</button><button data-act="scan-followback-all" ${onFollowersPage ? '' : 'disabled'}>扫描所有关注者</button><button class="secondary" data-act="open-verified-followers">打开认证关注者</button><button class="secondary" data-act="open-followers">打开所有关注者</button><button class="secondary" data-act="select-all-followback">全选可回关</button><button data-act="follow-back" ${(onFollowersPage || onVerifiedFollowersPage) ? '' : 'disabled'}>开始回关</button><button class="danger" data-act="stop">停止</button></div>
        <div class="xfc-list">${followMode ? (followRows || '<div class="xfc-row"><div class="xfc-name">还没有扫描到可回关账号。</div></div>') : (nonMutualRows || '<div class="xfc-row"><div class="xfc-name">还没有扫描到未互关账号。</div></div>')}</div>
        <div class="xfc-log" id="xfc-log">${onFollowingPage || onFollowersPage || onVerifiedFollowersPage ? '所有数据只保存在当前浏览器。' : '打开目标页面后才能扫描。'}</div>
      </div>`;
    bindPanel(panel);
  }

  function bindPanel(panel) {
    panel.querySelectorAll('button[data-act]').forEach((button) => button.addEventListener('click', () => handleAction(button.dataset.act, button.closest('[data-handle]')?.dataset.handle)));
    panel.querySelector('#xfc-batch')?.addEventListener('change', persistControlValues);
    panel.querySelector('#xfc-delay')?.addEventListener('change', persistControlValues);
  }

  function persistControlValues() {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    persistSets({ keep, selected, done, followSelected, followDone, batchSize: document.querySelector('#xfc-batch')?.value, delayMs: document.querySelector('#xfc-delay')?.value });
  }

  async function handleAction(action, handle) {
    if (action === 'minimize') return document.querySelector(`#${UI_ID}`)?.classList.toggle('minimized');
    if (action === 'open-following') return openFollowingPage();
    if (action === 'open-followers') return openFollowersPage();
    if (action === 'open-verified-followers') return openVerifiedFollowersPage();
    if (action === 'view-following') return switchView('');
    if (action === 'view-followback-verified') return switchView('followBackVerified');
    if (action === 'view-followback-all') return switchView('followBackAll');
    if (action === 'scan') return scanFollowing();
    if (action === 'scan-followback-all') return scanFollowBack('all');
    if (action === 'scan-followback-verified') return scanFollowBack('verified');
    if (action === 'stop') { scanning = false; unfollowing = false; followingBack = false; return log('已请求停止。'); }
    if (action === 'keep') return keepHandle(handle);
    if (action === 'pick') return togglePick(handle);
    if (action === 'skip-followback') return skipFollowBack(handle);
    if (action === 'pick-followback') return toggleFollowBackPick(handle);
    if (action === 'select-all') return selectAllNonMutual();
    if (action === 'select-all-followback') return selectAllFollowBack();
    if (action === 'export-keep') return downloadJson('x-follow-cleaner-keep.json', stateSets().state.keep);
    if (action === 'import-keep') return importKeepPrompt();
    if (action === 'export-nonmutual') return downloadJson('x-follow-cleaner-non-mutual.json', getNonMutual());
    if (action === 'unfollow') return startUnfollow();
    if (action === 'follow-back') return startFollowBack();
  }

  function openFollowingPage() {
    const input = document.querySelector('#xfc-handle-input')?.value || inferHandleFromPage();
    const url = getFollowingUrl(input);
    if (!url) return log('请输入账号，例如 @Ryan61257127。');
    switchView('', false);
    location.href = url;
  }

  function openFollowersPage() {
    const input = document.querySelector('#xfc-handle-input')?.value || inferHandleFromPage();
    const url = getFollowersUrl(input);
    if (!url) return log('请输入账号，例如 @Ryan61257127。');
    switchView('followBackAll', false);
    location.href = url;
  }

  function openVerifiedFollowersPage() {
    const input = document.querySelector('#xfc-handle-input')?.value || inferHandleFromPage();
    const url = getVerifiedFollowersUrl(input);
    if (!url) return log('请输入账号，例如 @Ryan61257127。');
    switchView('followBackVerified', false);
    location.href = url;
  }

  function switchView(view, shouldRender = true) {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    persistSets({ keep, selected, done, followSelected, followDone, view });
    if (shouldRender) {
      render();
      log(view === 'followBackVerified' ? '已切换到认证关注者回关列表。' : view === 'followBackAll' ? '已切换到所有关注者回关列表。' : '已切换到未互关清理列表。');
    }
  }

  async function scanFollowing() {
    if (scanning) return;
    scanning = true;
    log('正在扫描并自动下滑...');
    let staleRounds = 0;
    let previousSize = scanMap.size;
    for (let round = 0; round < 240 && scanning; round += 1) {
      mergeAccounts(parseVisibleAccounts());
      staleRounds = scanMap.size === previousSize ? staleRounds + 1 : 0;
      previousSize = scanMap.size;
      render();
      log(`扫描中：已发现 ${scanMap.size} 个关注账号，其中 ${getNonMutual().length} 个未互关。`);
      if (staleRounds >= 12 && round > 15) break;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      await sleep(900);
    }
    mergeAccounts(parseVisibleAccounts());
    scanning = false;
    render();
    log(`扫描完成：共 ${scanMap.size} 个关注账号，其中 ${getNonMutual().length} 个未互关。`);
  }

  async function scanFollowBack(mode) {
    if (scanning) return;
    scanning = true;
    persistSets({ ...stateSets(), view: mode === 'verified' ? 'followBackVerified' : 'followBackAll' });
    log(`正在扫描${mode === 'verified' ? '认证关注者' : '所有关注者'}...`);
    let staleRounds = 0;
    let previousSize = followBackMap.size;
    for (let round = 0; round < 240 && scanning; round += 1) {
      mergeFollowBackAccounts(parseVisibleAccounts(), mode);
      staleRounds = followBackMap.size === previousSize ? staleRounds + 1 : 0;
      previousSize = followBackMap.size;
      render();
      log(`扫描中：已发现 ${getFollowBackCandidates(mode).length} 个可回关账号。`);
      if (staleRounds >= 12 && round > 15) break;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      await sleep(900);
    }
    mergeFollowBackAccounts(parseVisibleAccounts(), mode);
    scanning = false;
    render();
    log(`扫描完成：共 ${getFollowBackCandidates(mode).length} 个可回关账号。`);
  }

  function keepHandle(handle) {
    const { keep, selected, done } = stateSets();
    keep.add(normalizeHandle(handle));
    selected.delete(normalizeHandle(handle));
    persistSets({ keep, selected, done });
    render();
  }

  function togglePick(handle) {
    const { keep, selected, done } = stateSets();
    const clean = normalizeHandle(handle);
    selected.has(clean) ? selected.delete(clean) : selected.add(clean);
    persistSets({ keep, selected, done });
    render();
  }

  function selectAllNonMutual() {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    getNonMutual().forEach((account) => selected.add(account.handle));
    persistSets({ keep, selected, done, followSelected, followDone, view: '' });
    render();
  }

  function toggleFollowBackPick(handle) {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    const clean = normalizeHandle(handle);
    followSelected.has(clean) ? followSelected.delete(clean) : followSelected.add(clean);
    persistSets({ keep, selected, done, followSelected, followDone, view: loadState().view || 'followBackAll' });
    render();
  }

  function skipFollowBack(handle) {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    const clean = normalizeHandle(handle);
    followSelected.delete(clean);
    followDone.add(clean);
    persistSets({ keep, selected, done, followSelected, followDone, view: loadState().view || 'followBackAll' });
    render();
  }

  function selectAllFollowBack() {
    const { keep, selected, done, followSelected, followDone } = stateSets();
    const mode = isVerifiedFollowersPage() ? 'verified' : isFollowersPage() ? 'all' : loadState().view === 'followBackVerified' ? 'verified' : 'all';
    getFollowBackCandidates(mode).forEach((account) => followSelected.add(account.handle));
    persistSets({ keep, selected, done, followSelected, followDone, view: mode === 'verified' ? 'followBackVerified' : 'followBackAll' });
    render();
  }

  function importKeepPrompt() {
    const input = prompt('粘贴白名单 JSON，或每行一个 @用户名：');
    if (input == null) return;
    const imported = importKeepList(input);
    const { keep, selected, done } = stateSets();
    imported.forEach((handle) => { keep.add(handle); selected.delete(handle); });
    persistSets({ keep, selected, done });
    render();
    log(`已导入 ${imported.length} 个白名单账号。`);
  }

  function importKeepList(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    let values;
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : parsed.keep || parsed.handles || [];
    } catch {
      values = raw.split(/\r?\n/);
    }
    return [...new Set(values.map(normalizeHandle).filter(Boolean))].sort();
  }

  async function startUnfollow() {
    if (unfollowing) return;
    persistControlValues();
    const { state, selected, done, keep } = stateSets();
    const queue = getNonMutual().filter((account) => selected.has(account.handle)).filter((account) => !done.has(account.handle)).filter((account) => !keep.has(account.handle)).slice(0, Number(state.batchSize || 10));
    if (!queue.length) return log('没有已选择的取关账号，请先选择账号。');
    unfollowing = true;
    for (const account of queue) {
      if (!unfollowing) break;
      const ok = await unfollowHandle(account.handle);
      const latest = stateSets();
      if (ok) { latest.done.add(account.handle); latest.selected.delete(account.handle); persistSets(latest); }
      render();
      log(`${ok ? '已处理' : '没找到取关按钮'} @${account.handle}`);
      await sleep(Number(loadState().delayMs || 4500));
    }
    unfollowing = false;
    render();
    log('本批取关完成。');
  }

  async function startFollowBack() {
    if (followingBack) return;
    persistControlValues();
    const mode = isVerifiedFollowersPage() ? 'verified' : isFollowersPage() ? 'all' : loadState().view === 'followBackVerified' ? 'verified' : 'all';
    const { state, followSelected, followDone } = stateSets();
    const queue = getFollowBackCandidates(mode).filter((account) => followSelected.has(account.handle)).filter((account) => !followDone.has(account.handle)).slice(0, Number(state.batchSize || 10));
    if (!queue.length) return log('没有已选择的回关账号，请先选择账号。');
    followingBack = true;
    for (const account of queue) {
      if (!followingBack) break;
      const ok = await followBackHandle(account.handle);
      const latest = stateSets();
      if (ok) {
        latest.followDone.add(account.handle);
        latest.followSelected.delete(account.handle);
        persistSets({ ...latest, view: mode === 'verified' ? 'followBackVerified' : 'followBackAll' });
      }
      render();
      log(`${ok ? '已回关' : '没找到回关按钮'} @${account.handle}`);
      await sleep(Number(loadState().delayMs || 4500));
    }
    followingBack = false;
    render();
    log('本批回关完成。');
  }

  async function unfollowHandle(handle) {
    const cell = findUserCell(normalizeHandle(handle));
    if (!cell) return false;
    cell.scrollIntoView({ block: 'center' });
    await sleep(600);
    const followButton = [...cell.querySelectorAll('button[role="button"], div[role="button"]')].find((button) => {
      const text = button.innerText || button.getAttribute('aria-label') || '';
      return text.includes(zh.following) || /following/i.test(text);
    });
    if (!followButton) return false;
    followButton.click();
    await sleep(900);
    const confirm = [...document.querySelectorAll('button[role="button"], div[role="button"]')].find((button) => {
      const text = button.innerText || button.getAttribute('aria-label') || '';
      return text.includes(zh.unfollow) || /unfollow/i.test(text);
    });
    if (!confirm) return false;
    confirm.click();
    return true;
  }

  async function followBackHandle(handle) {
    const cell = findUserCell(normalizeHandle(handle));
    if (!cell) return false;
    cell.scrollIntoView({ block: 'center' });
    await sleep(600);
    const button = [...cell.querySelectorAll('button[role="button"], div[role="button"]')].find((candidate) => {
      const text = candidate.innerText || candidate.getAttribute('aria-label') || '';
      return text.includes(zh.followBack) || /follow back/i.test(text);
    });
    if (!button) return false;
    button.click();
    return true;
  }

  function findUserCell(handle) {
    return [...document.querySelectorAll('[data-testid="UserCell"]')].find((cell) => [...cell.querySelectorAll('a[href^="/"]')].some((anchor) => normalizeHandle(anchor.getAttribute('href')) === handle));
  }

  function downloadJson(filename, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  }

  function log(message) {
    const node = document.querySelector('#xfc-log');
    if (node) node.textContent = message;
  }

  render();
})();
