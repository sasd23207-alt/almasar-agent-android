(() => {
  const byId = (id) => document.getElementById(id);
  let running = false;
  let loopPromise = null;
  let received = 0;
  let lastError = '';
  const native = () => window.AlmasarNative || null;

  function status(message, bad = false) {
    const node = byId('relayStatus');
    if (node) {
      node.textContent = message;
      node.style.color = bad ? 'var(--danger)' : 'var(--accent)';
    }
  }
  function cleanBase(value) { return String(value || '').trim().replace(/\/+$/, ''); }
  function config() {
    const n = native();
    if (n && typeof n.getRelayConfig === 'function') {
      try {
        const raw = n.getRelayConfig();
        if (raw) return JSON.parse(raw);
      } catch (_) {}
    }
    try { return JSON.parse(sessionStorage.getItem('almasar-relay-config') || '{}'); } catch (_) { return {}; }
  }
  function saveConfig(value) {
    const n = native();
    const serialized = JSON.stringify(value);
    if (n && typeof n.setRelayConfig === 'function') n.setRelayConfig(serialized);
    else sessionStorage.setItem('almasar-relay-config', serialized);
  }
  function headers(token) { return { authorization: 'Bearer ' + token, 'content-type': 'application/json' }; }

  async function storeIncoming(envelope) {
    const message = envelope.message || {};
    const waId = String(message.id || envelope.id || '');
    if (!waId) throw new Error('رسالة بلا معرف من واتساب؛ لم يتم تأكيدها.');
    const existing = state.messages.some(item => item.whatsappMessageId === waId);
    if (existing) return false;

    const contact = Array.isArray(message.contacts) ? message.contacts[0] : null;
    const displayName = contact && contact.profile && contact.profile.name
      ? String(contact.profile.name).trim() : '';
    const phone = String(message.from || '').trim();
    const merchantName = displayName || (phone ? '+' + phone : 'تاجر غير معروف');
    let merchant = state.merchants.find(item => item.whatsappPhone === phone && phone);
    if (!merchant) merchant = state.merchants.find(item => item.name.toLocaleLowerCase() === merchantName.toLocaleLowerCase());
    if (!merchant) {
      merchant = { id: newId(), name: merchantName, whatsappPhone: phone, createdAt: new Date().toISOString(), source: 'whatsapp_business' };
      state.merchants.push(merchant);
    } else if (phone && !merchant.whatsappPhone) {
      merchant.whatsappPhone = phone;
    }

    const stamp = Number(message.timestamp || 0);
    const at = stamp > 0 ? new Date(stamp * 1000).toISOString().slice(0, 19) : new Date().toISOString().slice(0, 19);
    const body = typeof message.text === 'string' && message.text
      ? message.text
      : (message.type === 'text' && message.rawMessage?.text?.body) || '[رسالة واتساب من نوع ' + (message.type || 'غير معروف') + ' — محتواها الأصلي محفوظ]';
    state.messages.push({
      id: newId(), merchantId: merchant.id, key: 'whatsapp|' + waId,
      whatsappMessageId: waId, at, sender: displayName || phone,
      text: body, whatsappType: message.type || 'unknown',
      whatsappRaw: message.rawMessage || message,
      source: 'whatsapp_business', analyzed: false
    });
    const ok = saveState();
    if (!ok) throw new Error('تعذر بدء حفظ الرسالة في قاعدة البيانات المحلية.');
    await writeChain;
    if (persistBlocked) throw new Error('قاعدة البيانات المحلية لم تؤكد الحفظ.');
    ui.merchantId = merchant.id;
    renderAll();
    return true;
  }

  async function ack(base, token, id) {
    const response = await fetch(base + '/api/ack/' + encodeURIComponent(id), {
      method: 'POST', headers: headers(token), body: '{}'
    });
    if (!response.ok) throw new Error('حفظ الرسالة محلياً، لكن تأكيد الجسر فشل: HTTP ' + response.status);
  }

  async function pollOnce() {
    const cfg = config();
    const base = cleanBase(cfg.url);
    const token = String(cfg.token || '');
    if (!base || !token) throw new Error('أدخل رابط الجسر ورمز الجهاز ثم احفظ الربط.');
    const response = await fetch(base + '/api/next', { headers: headers(token), cache: 'no-store' });
    if (response.status === 204) return;
    if (!response.ok) throw new Error('تعذر جلب الرسائل: HTTP ' + response.status);
    const envelope = await response.json();
    try {
      const added = await storeIncoming(envelope);
      await ack(base, token, envelope.id);
      if (added) {
        received += 1;
        status('متصل — تم حفظ ' + received + ' رسالة جديدة محلياً وتأكيد استلامها.');
        const owner = byId('ownerNameInput')?.value.trim();
        if (owner && typeof analyzeNewMessages === 'function') {
          const message = state.messages.find(item => item.whatsappMessageId === envelope.id);
          if (message) {
            ui.merchantId = message.merchantId;
            try { await analyzeNewMessages(); } catch (_) {}
          }
        }
      }
    } catch (error) {
      lastError = error.message || String(error);
      status(lastError + ' — لم نؤكد الرسالة للجسر حتى لا تضيع.', true);
      throw error;
    }
  }

  async function runLoop() {
    while (running) {
      try {
        await pollOnce();
        if (running) await new Promise(resolve => setTimeout(resolve, 350));
      } catch (error) {
        lastError = error.message || String(error);
        status(lastError + ' — إعادة المحاولة بعد 3 ثوانٍ.', true);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  async function start() {
    await window.almasarReady;
    const cfg = config();
    const url = cleanBase(byId('relayUrl').value || cfg.url);
    const token = String(byId('relayToken').value || cfg.token || '').trim();
    if (!url || !token) return status('أدخل رابط الجسر ورمز الجهاز.', true);
    saveConfig({ url, token });
    byId('relayUrl').value = url;
    byId('relayToken').value = '';
    if (running) return;
    running = true;
    status('جارٍ الاتصال بالجسر…');
    loopPromise = runLoop();
  }
  function stop() {
    running = false;
    status('تم إيقاف استقبال الرسائل من هذا الجهاز.');
  }

  window.addEventListener('load', async () => {
    await window.almasarReady;
    const cfg = config();
    byId('relayUrl').value = cfg.url || 'https://almasar-whatsapp-relay.onrender.com';
    byId('relaySave').addEventListener('click', () => {
      const url = cleanBase(byId('relayUrl').value);
      const token = String(byId('relayToken').value || cfg.token || '').trim();
      if (!url || !token) return status('أدخل الرابط ورمز الجهاز.', true);
      saveConfig({ url, token });
      byId('relayToken').value = '';
      status('تم حفظ إعدادات الربط على هذا الجهاز.');
    });
    byId('relayStart').addEventListener('click', start);
    byId('relayStop').addEventListener('click', stop);
    status('جاهز للربط — احفظ الإعدادات ثم شغّل الاستقبال.');
  });
  window.addEventListener('beforeunload', stop);
})();
