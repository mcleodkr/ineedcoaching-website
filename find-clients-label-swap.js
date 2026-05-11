// Swap "Open Requests" labels to "Find Clients" for logged-in coaches.
//
// Default text on the page is "Open Requests" — the descriptive,
// low-pressure label for anon visitors and clients. This script
// upgrades to "Find Clients" — the action label — when the visitor
// is a verified coach (has a coach_profiles row keyed by their
// authenticated email).
//
// Targets: any <a class="js-open-requests-label" data-coach-label="..."> on
// the page. data-coach-label holds the exact replacement HTML (preserving
// the &rarr; on tab variants vs plain text on nav variants).
//
// Mirrors the auth-detection pattern in hide-coach-cta.js — keep them
// in sync if either updates. Fails silently on any auth/network/parse
// error; the default label stays visible rather than the page raising.
//
// Loaded via <script src="/find-clients-label-swap.js" defer></script>.

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
        document.querySelectorAll('.js-open-requests-label').forEach(function (el) {
          var target = el.getAttribute('data-coach-label');
          if (target) el.innerHTML = target;
        });
      })
      .catch(function () { /* silent — default label stays visible */ });
  } catch (e) { /* silent */ }
})();
