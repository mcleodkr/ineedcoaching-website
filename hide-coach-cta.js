// Hide "List Your Practice" CTAs from logged-in coaches.
//
// Reads sb_access_token (set by coach-dashboard's login flow), validates
// it via /auth/v1/user, then queries coach_profiles by the authed email.
// If a coach profile exists for that email, hides every /coach-signup.html
// anchor whose visible text is "List Your Practice".
//
// Anon visitors (no token) and logged-in clients (token but no
// coach_profile row) are unaffected — they remain the intended audience
// for the CTA. Fails silently on any auth/network/JSON error: the CTA
// stays visible rather than the page raising an unhandled rejection.
//
// Loaded via <script src="/hide-coach-cta.js" defer></script> on every
// page that contains the CTA. defer guarantees the DOM is fully parsed
// before the IIFE runs, so document.querySelectorAll picks up every
// matching anchor without needing a DOMContentLoaded handler.

(function () {
  try {
    var token = localStorage.getItem('sb_access_token');
    if (!token) return;
    var SB = 'https://qroizygknxdjsstkezsf.supabase.co';
    var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyb2l6eWdrbnhkanNzdGtlenNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ3MTEsImV4cCI6MjA5MDI5MDcxMX0.ZnSxf8LIDe_HPedgMPTwRpVE_VJmYSSFecwqrlNvjQ4';
    fetch(SB + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: KEY },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (!u || !u.email) return null;
        return fetch(
          SB + '/rest/v1/coach_profiles?user_email=eq.' + encodeURIComponent(u.email.toLowerCase()) + '&select=id&limit=1',
          { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
        ).then(function (r) { return r.ok ? r.json() : []; });
      })
      .then(function (rows) {
        if (!Array.isArray(rows) || rows.length === 0) return;
        document.querySelectorAll('a[href="/coach-signup.html"]').forEach(function (a) {
          if ((a.textContent || '').trim().toLowerCase() === 'list your practice') {
            a.style.display = 'none';
          }
        });
      })
      .catch(function () { /* fail silently — CTA stays visible on error */ });
  } catch (e) { /* fail silently */ }
})();
