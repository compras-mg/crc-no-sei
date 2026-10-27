// SEI 5: id_protocolo identifica o processo apenas em procedimento_trabalhar.
// Em páginas de documento, id_protocolo não deve ser usado como ID de processo.
function seiProcessUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      ['www.sei.mg.gov.br', 'sei.mg.gov.br'].includes(url.hostname) &&
      /\/controlador\.php$/.test(url.pathname) &&
      url.searchParams.get('acao') === 'procedimento_trabalhar' &&
      /^[1-9]\d*$/.test((url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) || '') ? url : null;
  } catch { return null; }
}

function isPanelSender(sender) {
  try {
    const url = new URL(sender.url);
    const own = new URL(chrome.runtime.getURL('panel.html'));
    return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) &&
      sender.tab.id >= 0 && Number.isInteger(sender.frameId) && sender.frameId > 0 &&
      url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
  } catch { return false; }
}

async function panelContext(sender) {
  if (!isPanelSender(sender)) throw new Error('Abra o painel pelo botão CRC do SEI.');
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!seiProcessUrl(tab.url)) throw new Error('Abra um processo no SEI/MG e tente novamente.');
  return { tabId: sender.tab.id };
}

// O ícone do navegador aciona o mesmo painel dentro da aba.
chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab?.id)) return;
  try {
    if (!seiProcessUrl(tab.url)) throw new Error('not-a-process');
    await chrome.tabs.sendMessage(tab.id, { type: 'crc-show-embedded-panel' }, { frameId: 0 });
    await chrome.action.setTitle({ tabId: tab.id, title: 'CRC no SEI — abrir painel' });
  } catch {
    await chrome.action.setTitle({ tabId: tab.id, title: 'Abra um processo no SEI e atualize a página para usar o painel CRC.' }).catch(() => {});
  }
});

// Somente o controlador do processo pode solicitar a abertura. O contexto do
// iframe vem da aba informada pelo navegador, nunca de parâmetros ?tab= da página.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['crc-open-assistant', 'crc-panel-context', 'crc-panel-hide'].includes(message?.type)) return false;
  (async () => {
    if (message.type === 'crc-open-assistant') {
      const source = seiProcessUrl(sender.url);
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
          !Number.isInteger(sender.tab?.id) || sender.tab.id < 0 || !source) {
        throw new Error('Abra um processo no SEI/MG e tente novamente.');
      }
      const current = seiProcessUrl((await chrome.tabs.get(sender.tab.id)).url);
      if (!current || current.origin !== source.origin ||
          (current.searchParams.get('id_procedimento') || (current.searchParams.get('acao') === 'procedimento_trabalhar' ? current.searchParams.get('id_protocolo') : null)) !== (source.searchParams.get('id_procedimento') || (source.searchParams.get('acao') === 'procedimento_trabalhar' ? source.searchParams.get('id_protocolo') : null))) {
        throw new Error('O processo da aba mudou. Atualize a página do SEI.');
      }
      // Um painel novo ainda não tem ouvinte. Um painel existente revalida a aba;
      // se estiver ocupado, fica visível com a operação atual preservada.
      await chrome.runtime.sendMessage({ type: 'crc-assistant-activate', tabId: sender.tab.id }).catch(() => null);
      return { ok: true, tabId: sender.tab.id };
    }
    if (message.type === 'crc-panel-context' && isPanelSender(sender)) {
      // Esta mensagem comprova que o app está executando; load não é suficiente.
      // Mesmo um erro de contexto precisa aparecer dentro do app já carregado.
      const viewId = new URL(sender.url).searchParams.get('view') || '';
      if (/^[a-f0-9-]{36}$/.test(viewId)) {
        await chrome.tabs.sendMessage(sender.tab.id, { type: 'crc-embedded-ready', viewId }, { frameId: 0 }).catch(() => {});
      }
    }
    const context = await panelContext(sender);
    if (message.type === 'crc-panel-hide') {
      await chrome.tabs.sendMessage(context.tabId, { type: 'crc-hide-embedded-panel' }, { frameId: 0 });
      return { ok: true };
    }
    return { ok: true, ...context };
  })().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

// Apenas preferências da interface; documentos e PDFs não são persistidos.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
});

// Serialize inclusion receipts across assistant panels. These session-only
// records contain metadata, never document text or PDF bytes.
let receiptQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isPanelSender(sender) ||
      !['receipt-acquire', 'receipt-update', 'receipt-get', 'receipt-release'].includes(message?.type)) return false;
  receiptQueue = receiptQueue.catch(() => {}).then(async () => {
    const key = message.key;
    if (typeof key !== 'string' || !/^crc-receipt:[A-Za-z0-9._:-]{1,220}$/.test(key)) throw new Error('Identificação de operação inválida.');
    const stored = (await chrome.storage.session.get(key))[key];
    if (message.type === 'receipt-get') return { ok: true, receipt: stored || null };
    if (message.type === 'receipt-acquire') {
      if (stored && (stored.stage !== 'complete' || stored.sha256 === message.receipt?.sha256)) return { ok: false, receipt: stored };
      const record = { ...message.receipt, token: crypto.randomUUID(), updatedAt: Date.now() };
      await chrome.storage.session.set({ [key]: record });
      return { ok: true, receipt: record };
    }
    if (!stored || stored.token !== message.token) throw new Error('Este painel não possui a operação de inclusão.');
    if (message.type === 'receipt-release') { await chrome.storage.session.remove(key); return { ok: true }; }
    const record = { ...stored, ...message.changes, token: stored.token, updatedAt: Date.now() };
    await chrome.storage.session.set({ [key]: record });
    return { ok: true, receipt: record };
  }).then((result) => { respond(result); }).catch((error) => { respond({ ok: false, error: error.message }); });
  return true;
});
