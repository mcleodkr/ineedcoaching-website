// Floating bug-report widget (Phase 1.P).
//
// Single-file, self-contained, no deps. Injects a fixed bottom-right
// pill button on every page that loads this script. Clicking the button
// opens a modal with a textarea + optional email. Submitting POSTs to
// https://www.ineedcoaching.org/api/submit-bug-report (cross-origin
// allowlisted server-side).
//
// Loaded via <script src="/bug-report-widget.js" defer></script>.
//
// Site detection from hostname picks the accent color and the
// posted_from_site enum sent to the backend. Supabase session detection
// is dual-path: supabase-js v2 storage key first, legacy sb_access_token
// second. Both fail silently — the widget keeps working for anon users.
//
// Double-init guard: if #bug-report-widget-root already exists, bail.

(function () {
  'use strict';

  if (document.getElementById('bug-report-widget-root')) return;

  var API_ENDPOINT = 'https://www.ineedcoaching.org/api/submit-bug-report';
  var SUPABASE_URL = 'https://qroizygknxdjsstkezsf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyb2l6eWdrbnhkanNzdGtlenNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTQ3MTEsImV4cCI6MjA5MDI5MDcxMX0.ZnSxf8LIDe_HPedgMPTwRpVE_VJmYSSFecwqrlNvjQ4';
  var SB_V2_STORAGE_KEY = 'sb-qroizygknxdjsstkezsf-auth-token';
  var SB_LEGACY_KEY = 'sb_access_token';

  function detectSite() {
    var host = (window.location.hostname || '').toLowerCase();
    if (host.indexOf('ineedcoaching') !== -1) return { id: 'coaching', accent: '#1a3a52' };
    if (host.indexOf('ineedtherapy') !== -1) return { id: 'therapy', accent: '#1a7a8a' };
    if (host.indexOf('ineedrecovery') !== -1) return { id: 'recovery', accent: '#1a3a52' };
    return { id: 'unknown', accent: '#333333' };
  }

  // Resolve the logged-in email asynchronously. Caches the result so the
  // modal can pre-fill instantly when opened. Falls back through:
  //   1. supabase-js v2 storage key (JSON blob with currentSession.user.email)
  //   2. Legacy sb_access_token + /auth/v1/user network call
  var resolvedEmail = null;
  function resolveLoggedInEmail() {
    try {
      var blob = localStorage.getItem(SB_V2_STORAGE_KEY);
      if (blob) {
        try {
          var parsed = JSON.parse(blob);
          var email = parsed && parsed.user && parsed.user.email
            || parsed && parsed.currentSession && parsed.currentSession.user && parsed.currentSession.user.email;
          if (email) { resolvedEmail = String(email).toLowerCase(); return; }
        } catch (e) { /* fall through */ }
      }
    } catch (e) { /* localStorage blocked */ }

    try {
      var legacy = localStorage.getItem(SB_LEGACY_KEY);
      if (!legacy) return;
      fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + legacy }
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) { if (u && u.email) resolvedEmail = String(u.email).toLowerCase(); })
        .catch(function () { /* silent */ });
    } catch (e) { /* silent */ }
  }

  function injectStyles(accent) {
    var css =
      '.brw-button{position:fixed;right:20px;bottom:20px;z-index:9998;background:' + accent + ';color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:0.78rem;font-weight:600;padding:10px 16px;border-radius:50px;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.18);transition:transform 0.15s ease,box-shadow 0.15s ease;line-height:1.2;}' +
      '.brw-button:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,0.22);}' +
      '.brw-button:focus{outline:2px solid ' + accent + ';outline-offset:2px;}' +
      '@media (max-width:600px){.brw-button{font-size:0.72rem;padding:8px 14px;right:14px;bottom:14px;}}' +
      '.brw-overlay{display:none;position:fixed;inset:0;background:rgba(15,25,38,0.55);z-index:9999;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '.brw-overlay.brw-open{display:flex;}' +
      '.brw-modal{background:#fff;border-radius:12px;padding:28px 28px 24px;max-width:480px;width:100%;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.25);color:#1a1a2e;box-sizing:border-box;max-height:calc(100vh - 48px);overflow-y:auto;}' +
      '.brw-modal *,.brw-modal *::before,.brw-modal *::after{box-sizing:border-box;}' +
      '.brw-close{position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.3rem;color:#6b6b60;cursor:pointer;line-height:1;padding:6px 10px;border-radius:6px;}' +
      '.brw-close:hover{background:#f5f3ee;color:#1a1a2e;}' +
      '.brw-title{font-family:"Cormorant Garamond",Georgia,serif;font-size:1.5rem;font-weight:600;margin:0 0 6px;color:' + accent + ';line-height:1.2;}' +
      '.brw-sub{font-size:0.85rem;color:#6b6b60;margin:0 0 20px;line-height:1.5;}' +
      '.brw-label{display:block;font-size:0.72rem;font-weight:700;color:#1a1a2e;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;}' +
      '.brw-textarea{width:100%;padding:11px 14px;border:1px solid #e0ddd5;border-radius:8px;font-family:inherit;font-size:0.92rem;color:#1a1a2e;background:#fff;resize:vertical;min-height:140px;line-height:1.55;display:block;}' +
      '.brw-textarea:focus{outline:none;border-color:' + accent + ';box-shadow:0 0 0 3px ' + accent + '22;}' +
      '.brw-input{width:100%;padding:11px 14px;border:1px solid #e0ddd5;border-radius:8px;font-family:inherit;font-size:0.92rem;color:#1a1a2e;background:#fff;display:block;}' +
      '.brw-input:focus{outline:none;border-color:' + accent + ';box-shadow:0 0 0 3px ' + accent + '22;}' +
      '.brw-field{margin-bottom:14px;}' +
      '.brw-context{font-size:0.75rem;color:#6b6b60;font-style:italic;margin:-4px 0 18px;line-height:1.5;}' +
      '.brw-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px;}' +
      '.brw-btn{padding:10px 20px;border-radius:8px;font-family:inherit;font-size:0.85rem;font-weight:600;cursor:pointer;border:none;transition:background 0.15s ease;}' +
      '.brw-btn-cancel{background:#fff;color:#6b6b60;border:1px solid #e0ddd5;}' +
      '.brw-btn-cancel:hover{border-color:#1a1a2e;color:#1a1a2e;}' +
      '.brw-btn-submit{background:' + accent + ';color:#fff;}' +
      '.brw-btn-submit:hover{filter:brightness(0.92);}' +
      '.brw-btn-submit:disabled{opacity:0.55;cursor:not-allowed;}' +
      '.brw-error{font-size:0.82rem;color:#c44;margin:8px 0 4px;min-height:1.2em;}' +
      '.brw-success{text-align:center;padding:18px 8px;}' +
      '.brw-success-icon{font-size:2rem;margin-bottom:8px;}' +
      '.brw-success-title{font-family:"Cormorant Garamond",Georgia,serif;font-size:1.4rem;font-weight:600;color:' + accent + ';margin:0 0 8px;}' +
      '.brw-success-sub{font-size:0.9rem;color:#6b6b60;margin:0 0 18px;line-height:1.5;}';
    var style = document.createElement('style');
    style.setAttribute('data-bug-report-widget', '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildDom(site) {
    var root = document.createElement('div');
    root.id = 'bug-report-widget-root';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'brw-button';
    button.setAttribute('aria-label', 'Report a bug');
    button.textContent = '🐛 Report bug';

    var overlay = document.createElement('div');
    overlay.className = 'brw-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'brw-title');

    overlay.innerHTML =
      '<div class="brw-modal" role="document">' +
      '<button type="button" class="brw-close" aria-label="Close">×</button>' +
      '<div class="brw-body">' +
      '<h2 id="brw-title" class="brw-title">Report a bug</h2>' +
      '<p class="brw-sub">Something not working? Tell us what happened. We will look into it.</p>' +
      '<div class="brw-field">' +
        '<label class="brw-label" for="brw-description">What happened?</label>' +
        '<textarea id="brw-description" class="brw-textarea" rows="6" maxlength="1500" placeholder="Describe the bug. What you tried, what went wrong, what you expected."></textarea>' +
      '</div>' +
      '<div class="brw-field">' +
        '<label class="brw-label" for="brw-email">Your email <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#6b6b60;">(optional, so we can follow up)</span></label>' +
        '<input id="brw-email" class="brw-input" type="email" placeholder="you@example.com" />' +
      '</div>' +
      '<p class="brw-context">We will also send: this page URL, your browser type, and screen size.</p>' +
      '<div class="brw-error" id="brw-error"></div>' +
      '<div class="brw-actions">' +
        '<button type="button" class="brw-btn brw-btn-cancel" id="brw-cancel">Cancel</button>' +
        '<button type="button" class="brw-btn brw-btn-submit" id="brw-submit">Submit</button>' +
      '</div>' +
      '</div>' +
      '</div>';

    root.appendChild(button);
    root.appendChild(overlay);
    document.body.appendChild(root);

    return { root: root, button: button, overlay: overlay };
  }

  function openModal(overlay) {
    overlay.classList.add('brw-open');
    // Pre-fill email if we've resolved it
    var emailInput = overlay.querySelector('#brw-email');
    if (emailInput && !emailInput.value && resolvedEmail) emailInput.value = resolvedEmail;
    var descInput = overlay.querySelector('#brw-description');
    if (descInput) {
      try { descInput.focus(); } catch (e) { /* silent */ }
    }
  }

  function closeModal(overlay) {
    overlay.classList.remove('brw-open');
  }

  function resetModalToForm(overlay) {
    // Re-render the form body in case it was replaced by the success state.
    var modal = overlay.querySelector('.brw-modal');
    if (!modal) return;
    var existingBody = modal.querySelector('.brw-body');
    if (existingBody) return; // already in form state
    // Otherwise rebuild: easier to just close — keep things simple
    closeModal(overlay);
  }

  function showSuccess(overlay, accent) {
    var modal = overlay.querySelector('.brw-modal');
    if (!modal) return;
    modal.innerHTML =
      '<button type="button" class="brw-close" aria-label="Close">×</button>' +
      '<div class="brw-success">' +
      '<div class="brw-success-icon">✓</div>' +
      '<h2 class="brw-success-title">Thanks. We have got it.</h2>' +
      '<p class="brw-success-sub">A real person will look at this. If you left an email, expect a reply from admin@sprixle.com.</p>' +
      '<button type="button" class="brw-btn brw-btn-submit" id="brw-success-close">Close</button>' +
      '</div>';
    var closeBtn = modal.querySelector('.brw-close');
    var doneBtn = modal.querySelector('#brw-success-close');
    var dismiss = function () { closeModal(overlay); };
    if (closeBtn) closeBtn.addEventListener('click', dismiss);
    if (doneBtn) doneBtn.addEventListener('click', dismiss);
    setTimeout(dismiss, 4000);
  }

  function init() {
    var site = detectSite();
    injectStyles(site.accent);
    resolveLoggedInEmail();
    var els = buildDom(site);

    els.button.addEventListener('click', function () { openModal(els.overlay); });

    var closeBtn = els.overlay.querySelector('.brw-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { closeModal(els.overlay); });

    var cancelBtn = els.overlay.querySelector('#brw-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { closeModal(els.overlay); });

    els.overlay.addEventListener('click', function (e) {
      if (e.target === els.overlay) closeModal(els.overlay);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.overlay.classList.contains('brw-open')) closeModal(els.overlay);
    });

    var submitBtn = els.overlay.querySelector('#brw-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var descEl = els.overlay.querySelector('#brw-description');
        var emailEl = els.overlay.querySelector('#brw-email');
        var errEl = els.overlay.querySelector('#brw-error');
        var description = descEl ? descEl.value.trim() : '';
        var reporterEmail = emailEl ? emailEl.value.trim() : '';

        if (!description) {
          if (errEl) errEl.textContent = 'Please describe the bug.';
          if (descEl) try { descEl.focus(); } catch (e) {}
          return;
        }
        if (errEl) errEl.textContent = '';
        submitBtn.disabled = true;
        var originalLabel = submitBtn.textContent;
        submitBtn.textContent = 'Sending...';

        var payload = {
          description: description,
          reporter_email: reporterEmail || null,
          page_url: window.location.href,
          posted_from_site: site.id,
          user_agent: navigator.userAgent || null,
          screen_size: (window.screen && window.screen.width) ? window.screen.width + 'x' + window.screen.height : null,
          logged_in_email: resolvedEmail || null
        };

        fetch(API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function () {
            showSuccess(els.overlay, site.accent);
          })
          .catch(function (e) {
            console.error('[bug-report-widget] submit failed:', e);
            if (errEl) errEl.textContent = 'Could not send. Please try again or email admin@sprixle.com directly.';
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          });
      });
    }
  }

  // defer attribute means we run after parse, but DOMContentLoaded may
  // not have fired yet on some browsers. Be safe.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
