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
    const { enrollment_id, certificate_id } = body;
    if (!enrollment_id || !certificate_id) {
      return res.status(400).json({ error: 'Missing required fields: enrollment_id, certificate_id' });
    }

    const eRes = await fetch(
      `${SUPABASE_URL}/rest/v1/course_enrollments?id=eq.${enrollment_id}&select=*,courses(title)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const enrollments = await eRes.json();
    if (!enrollments.length) return res.status(404).json({ error: 'Enrollment not found' });

    const enrollment = enrollments[0];
    const studentName = enrollment.student_name || enrollment.student_email;
    const courseName = enrollment.courses?.title || 'your course';

    const subject = 'You did it — your certificate is ready';
    const emailBody = `Hi ${studentName},\n\nYou completed ${courseName}.\n\nThat took intention and follow-through. Not everyone finishes what they start.\n\nYour certificate of completion is available to download:\nhttps://www.ineedcoaching.org/certificate.html?id=${certificate_id}\n\nShare it. You earned it.\n\nThe ineedcoaching.org team`;

    console.log('=== COURSE COMPLETION EMAIL ===');
    console.log('To:', enrollment.student_email);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: enrollment.student_email, subject });
  } catch (e) {
    console.error('course-completion error:', e);
    return res.status(500).json({ error: e.message });
  }
}
