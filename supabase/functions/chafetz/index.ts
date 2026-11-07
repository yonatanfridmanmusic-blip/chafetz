import postgres from "npm:postgres@3.4.5";
import webpush from "npm:web-push@3.6.7";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const REPLIES = [
  { text: "חמש דקות אני מגיע", yes: true },
  { text: "גלגל אני בא", yes: true },
  { text: "הלילה מנשקים כוכבים", yes: true },
  { text: "קובי תהיה עדין", yes: true },
  { text: "אין אותי", yes: false },
];
const MAX_GROUPS_PER_DEVICE = 30;
const MAX_MEMBERS_PER_GROUP = 50;
const PRESS_PER_MINUTE = 20;

const clean = (v: unknown, n = 30) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
const JOIN_FAILS_PER_HOUR = 10;
function token(len = 6) {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => abc[x % abc.length]).join("");
}

let cfg: Record<string, string> | null = null;
async function config() {
  if (cfg) return cfg;
  const rows = await sql`select k, v from chafetz.config`;
  cfg = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  webpush.setVapidDetails("mailto:yonatanfridmanmusic@gmail.com", cfg.vapid_public, cfg.vapid_private);
  return cfg;
}

async function send(t: { endpoint: string; sub: unknown }, payload: unknown) {
  try {
    await webpush.sendNotification(t.sub as any, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from chafetz.subs where endpoint = ${t.endpoint}`;
    console.error("push fail", e?.statusCode, e?.body);
    return false;
  }
}

async function device(endpoint: unknown) {
  const ep = String(endpoint ?? "");
  if (!ep) return null;
  const [d] = await sql`select id, name, endpoint, last_press, win_start, win_count, jf_start, jf_count from chafetz.subs where endpoint = ${ep}`;
  return d ?? null;
}

async function myGroups(deviceId: string) {
  const rows = await sql`
    select g.id, g.name, g.invite, m2.device_id as mid, s.name as mname, m2.joined_at
    from chafetz.members m
    join chafetz.groups g on g.id = m.group_id
    join chafetz.members m2 on m2.group_id = g.id
    join chafetz.subs s on s.id = m2.device_id
    where m.device_id = ${deviceId}
    order by m.joined_at, g.id, m2.joined_at`;
  const out: any[] = [];
  const byId = new Map<string, any>();
  for (const r of rows) {
    let g = byId.get(r.id);
    if (!g) { g = { id: r.id, name: r.name, invite: r.invite, members: [] }; byId.set(r.id, g); out.push(g); }
    g.members.push({ id: r.mid, name: r.mname, me: r.mid === deviceId });
  }
  return out;
}

async function others(groupId: string, deviceId: string) {
  return await sql`select s.endpoint, s.sub from chafetz.members m join chafetz.subs s on s.id = m.device_id
    where m.group_id = ${groupId} and m.device_id <> ${deviceId}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const c = await config();
  const a = body.action;

  if (a === "vapid") return json({ key: c.vapid_public });

  if (a === "subscribe") {
    const s = body.subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: "bad_sub" }, 400);
    const name = clean(body.name);
    const old = String(body.oldEndpoint ?? "");
    if (old && old !== s.endpoint) {
      const [moved] = await sql`update chafetz.subs set endpoint = ${s.endpoint}, sub = ${sql.json(s)}, name = coalesce(nullif(${name}, ''), name)
        where endpoint = ${old} and not exists (select 1 from chafetz.subs where endpoint = ${s.endpoint}) returning id`;
      if (moved) return json({ ok: true, id: moved.id });
    }
    const [row] = await sql`insert into chafetz.subs (endpoint, name, sub) values (${s.endpoint}, ${name}, ${sql.json(s)})
      on conflict (endpoint) do update set name = coalesce(nullif(excluded.name, ''), chafetz.subs.name), sub = excluded.sub returning id`;
    return json({ ok: true, id: row.id });
  }

  const me = await device(body.endpoint);
  if (!me) return json({ error: "not_registered" }, 401);

  if (a === "me") return json({ ok: true, id: me.id, name: me.name, groups: await myGroups(me.id) });

  if (a === "rename") {
    const name = clean(body.name);
    if (!name) return json({ error: "empty_name" }, 400);
    await sql`update chafetz.subs set name = ${name} where id = ${me.id}`;
    return json({ ok: true });
  }

  if (a === "create") {
    const name = clean(body.name, 24) || "החבורה";
    const [{ n }] = await sql`select count(*)::int n from chafetz.members where device_id = ${me.id}`;
    if (n >= MAX_GROUPS_PER_DEVICE) return json({ error: "too_many_groups" }, 429);
    let g: any = null;
    for (let i = 0; i < 5 && !g; i++) {
      [g] = await sql`insert into chafetz.groups (name, invite, created_by) values (${name}, ${token()}, ${me.id}) on conflict (invite) do nothing returning id, name, invite`;
    }
    if (!g) return json({ error: "try_again" }, 500);
    await sql`insert into chafetz.members (group_id, device_id) values (${g.id}, ${me.id})`;
    return json({ ok: true, group: g });
  }

  if (a === "join") {
    const jfWindow = me.jf_start && Date.now() - new Date(me.jf_start).getTime() < 3_600_000;
    if (jfWindow && me.jf_count >= JOIN_FAILS_PER_HOUR) return json({ error: "too_many_tries" }, 429);
    const raw = String(body.invite ?? "").slice(0, 500);
    const invite = ((raw.match(/join=([A-Za-z0-9]{4,20})/) || raw.match(/(?<![A-Za-z0-9])([A-Za-z0-9]{6})(?![A-Za-z0-9])/) || [])[1] || "").toUpperCase();
    const [g] = invite ? await sql`select id, name, invite from chafetz.groups where invite = ${invite}` : [];
    if (!g) {
      await sql`update chafetz.subs set jf_start = case when ${!!jfWindow} then jf_start else now() end,
        jf_count = case when ${!!jfWindow} then jf_count + 1 else 1 end where id = ${me.id}`;
      return json({ error: "bad_invite" }, 404);
    }
    const [{ n }] = await sql`select count(*)::int n from chafetz.members where group_id = ${g.id}`;
    if (n >= MAX_MEMBERS_PER_GROUP) return json({ error: "group_full" }, 429);
    const [{ k }] = await sql`select count(*)::int k from chafetz.members where device_id = ${me.id}`;
    if (k >= MAX_GROUPS_PER_DEVICE) return json({ error: "too_many_groups" }, 429);
    const ins = await sql`insert into chafetz.members (group_id, device_id) values (${g.id}, ${me.id}) on conflict do nothing returning 1`;
    if (ins.length) {
      const targets = await others(g.id, me.id);
      await Promise.all(targets.map((t) => send(t as any, {
        type: "joined", group: g.id, groupName: g.name,
        title: `${me.name || "מישהו"} הצטרף ל${g.name} 🥬`, body: "עכשיו אפשר לשאול אותו חפץ?",
      })));
    }
    return json({ ok: true, group: g, already: !ins.length });
  }

  if (a === "leave") {
    const gid = String(body.group ?? "");
    await sql`delete from chafetz.members where group_id = ${gid} and device_id = ${me.id}`;
    await sql`delete from chafetz.groups g where g.id = ${gid} and not exists (select 1 from chafetz.members m where m.group_id = g.id)`;
    return json({ ok: true });
  }

  if (a === "press") {
    if (me.last_press && Date.now() - new Date(me.last_press).getTime() < 1500) return json({ ok: true, throttled: true, sent: 0 });
    const inWindow = me.win_start && Date.now() - new Date(me.win_start).getTime() < 60_000;
    if (inWindow && me.win_count >= PRESS_PER_MINUTE) return json({ ok: false, error: "slow_down" }, 429);
    await sql`update chafetz.subs set last_press = now(),
      win_start = case when ${!!inWindow} then win_start else now() end,
      win_count = case when ${!!inWindow} then win_count + 1 else 1 end where id = ${me.id}`;

    let gid = String(body.group ?? "");
    const [g] = gid
      ? await sql`select g.id, g.name from chafetz.groups g join chafetz.members m on m.group_id = g.id where g.id = ${gid} and m.device_id = ${me.id}`
      : await sql`select g.id, g.name from chafetz.groups g join chafetz.members m on m.group_id = g.id where m.device_id = ${me.id} order by m.joined_at limit 1`;
    if (!g) return json({ ok: false, error: "no_group" }, 400);
    const [{ multi }] = await sql`select count(*) > 1 as multi from chafetz.members where device_id = ${me.id}`;
    const name = me.name || clean(body.name);
    const targets = await others(g.id, me.id);
    const payload = {
      type: "chafetz", from: me.id, name, group: g.id, groupName: g.name,
      title: name ? `${name} 🥬` : "🥬", body: multi ? `חפץ? · ${g.name}` : "חפץ?",
    };
    const res = await Promise.all(targets.map((t) => send(t as any, payload)));
    return json({ ok: true, sent: res.filter(Boolean).length, targets: targets.length });
  }

  if (a === "reply" || a === "approve") {
    const to = String(body.to ?? "");
    const idx = a === "approve" ? 0 : Number(body.reply);
    const r = REPLIES[idx];
    if (!to || !r) return json({ error: "bad_reply" }, 400);
    const gid = String(body.group ?? "");
    const [shared] = await sql`select g.id, g.name from chafetz.members a join chafetz.members b on a.group_id = b.group_id
      join chafetz.groups g on g.id = a.group_id
      where a.device_id = ${me.id} and b.device_id = ${to} and (${gid} = '' or g.id = ${gid}) limit 1`;
    if (!shared) return json({ ok: false, error: "not_in_group" }, 403);
    const [target] = await sql`select endpoint, sub from chafetz.subs where id = ${to}`;
    if (!target) return json({ ok: false, error: "target_gone" });
    const who = me.name || "מישהו";
    const payload = r.yes
      ? { type: "hurray", reply: idx, group: shared.id, title: `${who}: ${r.text} 🎉`, body: "החפץ אושר! הוריייי! 🥬" }
      : { type: "nope", reply: idx, group: shared.id, title: `${who}: ${r.text} 😔`, body: "החפץ נדחה. החסה בוכה 🥬💧" };
    return json({ ok: await send(target as any, payload) });
  }

  return json({ error: "unknown_action" }, 400);
});
