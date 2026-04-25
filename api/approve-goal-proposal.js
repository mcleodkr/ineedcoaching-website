// POST { proposal_id, booking_id, coach_id, client_email, action, edits? }
// action: 'approve' | 'edit' | 'dismiss'
// edits: { title?, description?, target_date?, proposed_status? }
//
// Resolves a pending goal_proposal or goal_status_update from
// post_session_analysis on the source session, mutates coach_goals
// accordingly, logs goal_revisions, and marks the proposal handled in
// the JSONB so it disappears from the dashboard's pending list.

const PROPOSAL_KIND = { goal: 'goal_proposal', status: 'goal_status_update' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { proposal_id, booking_id, coach_id, client_email, action } = body;
    const edits = body.edits || {};

    if (!proposal_id || !booking_id || !coach_id || !action) {
      return res.status(400).json({ error: 'Missing required fields: proposal_id, booking_id, coach_id, action' });
    }
    if (!['approve','edit','dismiss'].includes(action)) {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // ── Load source session and locate the proposal ─────────────────────
    const noteRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${booking_id}&select=id,booking_id,post_session_analysis&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const noteRows = await noteRes.json();
    if (!Array.isArray(noteRows) || noteRows.length === 0) {
      return res.status(404).json({ error: 'Source session not found' });
    }
    const note = noteRows[0];
    const psa = note.post_session_analysis || {};
    const proposals = Array.isArray(psa.goal_proposals) ? psa.goal_proposals : [];
    const statusUpdates = Array.isArray(psa.goal_status_updates) ? psa.goal_status_updates : [];

    let kind = null;
    let proposal = proposals.find(p => p && p.id === proposal_id);
    if (proposal) kind = PROPOSAL_KIND.goal;
    if (!proposal) {
      proposal = statusUpdates.find(p => p && p.id === proposal_id);
      if (proposal) kind = PROPOSAL_KIND.status;
    }
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found on source session' });
    }
    if (proposal.handled === true) {
      return res.status(409).json({ error: 'Proposal already handled' });
    }

    const nowIso = new Date().toISOString();
    let createdGoalId = null;
    let revisionRow = null;

    if (action === 'dismiss') {
      revisionRow = {
        goal_id: kind === PROPOSAL_KIND.status ? (proposal.goal_id || null) : null,
        revision_type: 'proposal_dismissed',
        before_value: proposal,
        after_value: null,
        reasoning: 'Coach dismissed AI proposal',
        proposed_by: 'ai',
        approved_by: coach_id,
        approved_at: nowIso,
        session_booking_id: booking_id,
        source_proposal_id: proposal_id,
        product_context: 'coaching',
      };
    } else if (kind === PROPOSAL_KIND.goal) {
      // Approve / edit a net-new goal proposal → insert into coach_goals
      const goalRow = {
        coach_id,
        client_email: client_email || null,
        title: (edits.title ?? proposal.title) || 'Untitled goal',
        description: edits.description ?? proposal.description ?? null,
        target_date: edits.target_date ?? proposal.target_date_suggestion ?? null,
        status: 'active',
        source: 'coach_clarity',
        created_by: 'coach',
        proposed_by: 'ai',
        approved_by: coach_id,
        approved_at: nowIso,
        product_context: 'coaching',
      };
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_goals`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(goalRow),
      });
      const insertedRows = await insertRes.json();
      if (!insertRes.ok) {
        console.error('[approve-goal-proposal] coach_goals insert failed:', insertedRows);
        return res.status(500).json({ error: 'Failed to create goal', detail: insertedRows });
      }
      createdGoalId = Array.isArray(insertedRows) ? insertedRows[0]?.id : insertedRows?.id;
      revisionRow = {
        goal_id: createdGoalId,
        revision_type: 'proposal_approved',
        before_value: proposal,
        after_value: { id: createdGoalId, ...goalRow },
        reasoning: action === 'edit' ? 'Coach edited and approved AI proposal' : 'Coach approved AI proposal',
        proposed_by: 'ai',
        approved_by: coach_id,
        approved_at: nowIso,
        session_booking_id: booking_id,
        source_proposal_id: proposal_id,
        product_context: 'coaching',
      };
    } else {
      // kind === goal_status_update → update existing coach_goals row
      const targetGoalId = proposal.goal_id;
      if (!targetGoalId) {
        return res.status(400).json({ error: 'goal_status_update proposal is missing goal_id' });
      }
      const newStatus = edits.proposed_status ?? proposal.proposed_status;
      const patchBody = { status: newStatus };
      if (newStatus === 'completed') patchBody.completed_at = nowIso;

      const beforeRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_goals?id=eq.${targetGoalId}&select=id,status,title`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const beforeRows = await beforeRes.json();
      const before = Array.isArray(beforeRows) ? beforeRows[0] : null;

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_goals?id=eq.${targetGoalId}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(patchBody),
        }
      );
      if (!patchRes.ok) {
        const errBody = await patchRes.text();
        console.error('[approve-goal-proposal] coach_goals patch failed:', errBody);
        return res.status(500).json({ error: 'Failed to update goal status', detail: errBody.slice(0, 300) });
      }

      revisionRow = {
        goal_id: targetGoalId,
        revision_type: 'status_change',
        before_value: before ? { status: before.status, title: before.title } : null,
        after_value: { status: newStatus },
        reasoning: proposal.reasoning || (action === 'edit' ? 'Coach edited and approved status flip' : 'Coach approved AI status flip'),
        proposed_by: 'ai',
        approved_by: coach_id,
        approved_at: nowIso,
        session_booking_id: booking_id,
        source_proposal_id: proposal_id,
        product_context: 'coaching',
      };
    }

    // ── Persist goal_revisions row ──────────────────────────────────────
    const revRes = await fetch(`${SUPABASE_URL}/rest/v1/goal_revisions`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(revisionRow),
    });
    if (!revRes.ok) {
      const errBody = await revRes.text();
      console.error('[approve-goal-proposal] goal_revisions insert failed:', errBody);
      // non-fatal: action already applied; surface but don't roll back
    }

    // ── Mark proposal handled inside post_session_analysis JSONB ────────
    const updatedProposals = proposals.map(p =>
      p && p.id === proposal_id ? { ...p, handled: true, handled_action: action, handled_at: nowIso } : p
    );
    const updatedStatusUpdates = statusUpdates.map(p =>
      p && p.id === proposal_id ? { ...p, handled: true, handled_action: action, handled_at: nowIso } : p
    );
    const newPsa = { ...psa, goal_proposals: updatedProposals, goal_status_updates: updatedStatusUpdates };

    await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${booking_id}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ post_session_analysis: newPsa }),
      }
    );

    return res.status(200).json({
      ok: true,
      action,
      kind,
      created_goal_id: createdGoalId,
      proposal_id,
    });
  } catch (e) {
    console.error('[approve-goal-proposal] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
