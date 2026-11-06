const API = "https://vndqjbatptgircjgsvdu.supabase.co/functions/v1/chafetz";
const CODE = "FKdfq-eUVam0";

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
    if (d.from) opts.actions = [{ action: 'approve', title: 'מאשר חפץ ✅' }];
  } else if (d.type === 'hurray') {
    opts.vibrate = [100, 50, 100, 50, 300];
  }
  e.waitUntil(Promise.all([self.registration.showNotification(d.title, opts), tellClients(d)]));
});

async function approve(to) {
  const sub = await self.registration.pushManager.getSubscription();
  await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE, action: 'approve', to, endpoint: sub ? sub.endpoint : '' })
  });
}

self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    if (e.action === 'approve' && d.from) return approve(d.from);
    let q = '';
    if (d.type === 'chafetz' && d.from) q = '?approve=' + encodeURIComponent(d.from);
    if (d.type === 'hurray') q = '?hurray=1';
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      all[0].postMessage({ type: 'open', ...d });
      return all[0].focus();
    }
    return clients.openWindow('./' + q);
  })());
});
