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
    const { enrollment_id, course_id, student_email } = body;

    let studentName, resolvedEmail, courseName, coachName;

    if (enrollment_id) {
      const eRes = await fetch(
        `${SUPABASE_URL}/rest/v1/course_enrollments?id=eq.${enrollment_id}&select=*,courses(title,coach_profiles(display_name))`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const enrollments = await eRes.json();
      if (!enrollments.length) return res.status(404).json({ error: 'Enrollment not found' });

      const enrollment = enrollments[0];
      studentName = enrollment.student_name || enrollment.student_email;
      resolvedEmail = enrollment.student_email;
      courseName = enrollment.courses?.title || 'your course';
      coachName = enrollment.courses?.coach_profiles?.display_name || 'your coach';
    } else {
      if (!course_id || !student_email) {
        return res.status(400).json({ error: 'Missing required fields: course_id, student_email' });
      }

      const cRes = await fetch(
        `${SUPABASE_URL}/rest/v1/courses?id=eq.${course_id}&select=title,coach_profiles(display_name)`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const courses = await cRes.json();
      if (!courses.length) return res.status(404).json({ error: 'Course not found' });

      studentName = student_email;
      resolvedEmail = student_email;
      courseName = courses[0].title || 'your course';
      coachName = courses[0].coach_profiles?.display_name || 'your coach';
    }

    const subject = `You are enrolled in ${courseName}`;
    const emailBody = `Hi ${studentName},\n\nYou are in. Welcome to ${courseName} with ${coachName}.\n\nYour classroom is ready whenever you are.\nhttps://www.ineedcoaching.org/classroom.html\n\nTake it at your own pace. Everything you need is inside.\n\nThe ineedcoaching.org team`;

    console.log('=== COURSE ENROLLMENT EMAIL ===');
    console.log('To:', resolvedEmail);
    console.log('Subject:', subject);
    console.log('Body:', emailBody);

    return res.status(200).json({ sent: true, to: resolvedEmail, subject });
  } catch (e) {
    console.error('course-enrollment error:', e);
    return res.status(500).json({ error: e.message });
  }
}
