// lib/coach-clients.js — service-role helpers for the coach_clients relationship
// (Phase 3 write layer). Lives in /lib so Vercel does not deploy it as a function.
//
// All writes to coach_clients go through here so the single-active invariant is
// enforced in one place: archive the prior active row BEFORE activating a new one
// (the partial unique index coach_clients_one_active_per_client is the backstop).
// client_email is always stored lowercased to match that index and the
// email-keyed RLS used across the rest of the schema.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sb(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(extra || {}) };
}
function norm(email) {
  return String(email || '').trim().toLowerCase();
}

// The client's current active link, or null. Email is stored lowercased so eq
// is exact — avoids the ilike wildcard hazard (an email local part can contain
// _ or %).
export async function getActiveLink(clientEmail) {
  const email = norm(clientEmail);
  if (!email) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_clients`
      + `?client_email=eq.${encodeURIComponent(email)}&status=eq.active`
      + `&select=id,coach_id,client_email&limit=1`,
    { headers: sb() }
  );
  if (!res.ok) throw new Error(`active link lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function archiveById(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_clients?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: sb({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ status: 'archived', archived_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) throw new Error(`archive failed: ${res.status}`);
}

// Upsert (coach_id, client_email) to active. merge-duplicates so a prior
// archived row for the same pair is reactivated rather than rejected.
async function upsertActive(coachId, email, source) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_clients?on_conflict=coach_id,client_email`,
    {
      method: 'POST',
      headers: sb({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify({
        coach_id: coachId,
        client_email: email,
        status: 'active',
        source,
        connected_at: new Date().toISOString(),
        archived_at: null,
      }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`activate failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : rows;
}

// Connect a client to a coach, or switch them from their current coach. Single
// active coach is preserved: any prior active link (to a different coach) is
// archived first. Idempotent when already active with this coach.
export async function connectOrSwitch(clientEmail, targetCoachId, source = 'self_connect') {
  const email = norm(clientEmail);
  if (!email) throw new Error('missing client email');
  if (!targetCoachId) throw new Error('missing coach id');

  const active = await getActiveLink(email);
  if (active && String(active.coach_id) === String(targetCoachId)) {
    return { action: 'already_active', coach_id: targetCoachId };
  }
  if (active) await archiveById(active.id); // archive prior coach BEFORE activating new
  await upsertActive(targetCoachId, email, source);
  return {
    action: active ? 'switched' : 'connected',
    coach_id: targetCoachId,
    previous_coach_id: active ? active.coach_id : null,
  };
}

// Archive the client's active link. History (all email-keyed data) is untouched.
export async function disconnect(clientEmail) {
  const active = await getActiveLink(clientEmail);
  if (!active) return { action: 'no_active_link' };
  await archiveById(active.id);
  return { action: 'disconnected', coach_id: active.coach_id };
}

// Called when a booking is confirmed. Never steals the active pointer: if the
// client is already active with a DIFFERENT coach, this coach is recorded as an
// archived link rather than silently switching them.
export async function attachOnBooking(coachId, clientEmail) {
  const email = norm(clientEmail);
  if (!coachId || !email) return { action: 'skipped_missing' };

  const active = await getActiveLink(email);
  if (active && String(active.coach_id) === String(coachId)) {
    return { action: 'already_active' };
  }
  if (active) {
    // Different active coach — record (coach, client) as archived, don't switch.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_clients?on_conflict=coach_id,client_email`,
      {
        method: 'POST',
        headers: sb({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body: JSON.stringify({
          coach_id: coachId,
          client_email: email,
          status: 'archived',
          source: 'booking',
          archived_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok && res.status !== 409) {
      const t = await res.text().catch(() => '');
      throw new Error(`archived attach failed: ${res.status} ${t.slice(0, 200)}`);
    }
    return { action: 'recorded_archived' };
  }
  // No active link — make this coach the client's active coach.
  await upsertActive(coachId, email, 'booking');
  return { action: 'activated' };
}
