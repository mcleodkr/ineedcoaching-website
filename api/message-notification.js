export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message_id, coach_id, client_email, sender } = body;

    let coachName, coachEmail, clientName, resolvedClientEmail, resolvedSender;

    if (message_id) {
      const mRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_messages?id=eq.${message_id}&select=*,coach_profiles(display_name,user_email)`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const messages = await mRes.json();
      if (!messages.length) return res.status(404).json({ error: 'Message not found' });

      const msg = messages[0];
      const coach = msg.coach_profiles;
      coachName = coach.display_name || 'Your Coach';
      coachEmail = coach.user_email;
      clientName = msg.client_name || msg.client_email;
      resolvedClientEmail = msg.client_email;
      resolvedSender = msg.sender || sender;
    } else {
      if (!coach_id || !client_email || !sender) {
        return res.status(400).json({ error: 'Missing required fields: coach_id, client_email, sender' });
      }

      const cRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coach_id}&select=display_name,user_email`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const coaches = await cRes.json();
      if (!coaches.length) return res.status(404).json({ error: 'Coach not found' });

      coachName = coaches[0].display_name || 'Your Coach';
      coachEmail = coaches[0].user_email;
      clientName = client_email;
      resolvedClientEmail = client_email;
      resolvedSender = sender;
    }

    if (resolvedSender === 'client') {
      // Notify coach
      const subject = `${clientName} sent you a message`;
      const emailBody = `Hi ${coachName},\n\nYou have a new message from ${clientName}.\n\nLog in to your dashboard to read and reply. Staying connected between sessions is one of the things that makes the work last.\n\nhttps://www.ineedcoaching.org/coach-dashboard.html\n\nThe ineedcoaching.org team`;

      console.log('=== COACH MESSAGE NOTIFICATION ===');
      console.log('To:', coachEmail);
      console.log('Subject:', subject);
      console.log('Body:', emailBody);

      return res.status(200).json({ sent: true, to: coachEmail, subject });
    } else {
      // Notify client
      const subject = `${coachName} replied to your message`;
      const emailBody = `Hi ${clientName},\n\n${coachName} sent you a message.\n\nhttps://www.ineedcoaching.org/client-portal.html\n\nThe ineedcoaching.org team`;

      console.log('=== CLIENT MESSAGE NOTIFICATION ===');
      console.log('To:', resolvedClientEmail);
      console.log('Subject:', subject);
      console.log('Body:', emailBody);

      return res.status(200).json({ sent: true, to: resolvedClientEmail, subject });
    }
  } catch (e) {
    console.error('message-notification error:', e);
    return res.status(500).json({ error: e.message });
  }
}
