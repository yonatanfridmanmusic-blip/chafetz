const API = "https://vndqjbatptgircjgsvdu.supabase.co/functions/v1/chafetz";

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function tellClients(msg) {
  const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach(c => c.postMessage(msg));
  return all;
}

self.addEventListener('push', e => {
  let d = { type: 'chafetz', title: '🥬', body: 'חפץ?' };
  try { d = { ...d, ...e.data.json() }; } catch {}
  const opts = {
    body: d.body,
    icon: 'icon-192.png',
    badge: 'badge.png',
    tag: d.type,
    renotify: true,
    dir: 'rtl',
    lang: 'he',
    data: d
  };
  if (d.type === 'chafetz') {
    opts.image = 'lettuce.png';
    opts.vibrate = [80, 40, 80];
    if (d.from) opts.actions = [{ action: 'r1', title: 'גלגל אני בא ✌🏼' }, { action: 'r4', title: 'אין אותי 🙅' }];
  } else if (d.type === 'hurray') {
    opts.vibrate = [100, 50, 100, 50, 300];
  } else if (d.type === 'joined') {
    opts.vibrate = [60];
  } else if (d.type === 'nope') {
    opts.vibrate = [400];
  }
  e.waitUntil(Promise.all([self.registration.showNotification(d.title, opts), tellClients(d)]));
});

async function reply(to, idx, group) {
  const sub = await self.registration.pushManager.getSubscription();
  await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reply', reply: idx, to, group: group || '', endpoint: sub ? sub.endpoint : '' })
  });
}

self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    if (/^r\d$/.test(e.action) && d.from) return reply(d.from, Number(e.action.slice(1)), d.group);
    let q = '';
    if (d.type === 'chafetz' && d.from) q = '?approve=' + encodeURIComponent(d.from) + '&n=' + encodeURIComponent(d.name || '') + '&g=' + encodeURIComponent(d.group || '') + '&gn=' + encodeURIComponent(d.groupName || '');
    if (d.type === 'hurray') q = '?hurray=1';
    if (d.type === 'nope') q = '?nope=1';
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      all[0].postMessage({ type: 'open', ...d });
      return all[0].focus();
    }
    return clients.openWindow('./' + q);
  })());
});
