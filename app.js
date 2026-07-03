// ===========================
//  CREDIFY — APP.JS
// ===========================

// ── Screen navigation ──────────────────────────────────────────
function goto(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ── Filter pills (History screen) ──────────────────────────────
function setFilter(el) {
  const parent = el.closest('.filter-row');
  parent.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

// ── Auto-advance loading screen ────────────────────────────────
document.querySelectorAll('.screen').forEach(screen => {
  new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.target.id === 'screen-loading' && m.target.classList.contains('active')) {
        setTimeout(() => goto('screen-result-high'), 3200);
      }
    });
  }).observe(screen, { attributes: true, attributeFilter: ['class'] });
});

// ── Animate credibility bars on result screens ──────────────────
function animateBars() {
  document.querySelectorAll('.cred-fill, .trend-bar-fill').forEach(bar => {
    const target = bar.style.width;
    bar.style.width = '0';
    setTimeout(() => { bar.style.width = target; }, 80);
  });
}
document.querySelectorAll('[id^="screen-result"], #screen-trends').forEach(screen => {
  new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.target.classList.contains('active')) animateBars();
    });
  }).observe(screen, { attributes: true, attributeFilter: ['class'] });
});

// ──────────────────────────────────────────────────────────────
//  SMART COMPOSER
// ──────────────────────────────────────────────────────────────

// Auto-resize textarea as the user types
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// Detect what kind of input was pasted / typed and show a badge
const URL_RE = /^https?:\/\/\S+/i;
const URL_IN = /https?:\/\/\S+/i;

function detectInputType(value, badgeId = 'type-badge') {
  const badge = document.getElementById(badgeId);
  if (!badge) return;

  const trimmed = value.trim();
  if (!trimmed) {
    badge.textContent = '';
    badge.classList.remove('visible');
    return;
  }

  let label = '';
  if (URL_RE.test(trimmed)) {
    label = '🔗 URL detected';
  } else if (URL_IN.test(trimmed)) {
    label = '🔗 Contains URL';
  } else if (trimmed.length > 0) {
    label = '📝 Text claim';
  }

  badge.textContent = label;
  badge.classList.add('visible');
}

// Submit on Enter (Shift+Enter = newline)
function handleComposerKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    goto('screen-loading');
  }
}

// ── File attachment ────────────────────────────────────────────

function triggerFileUpload(inputId = 'file-upload', previewId = 'attachments-preview') {
  const input = document.getElementById(inputId);
  if (input) {
    // Store which preview container to use
    input._previewId = previewId;
    input.click();
  }
}

function handleFileUpload(input, previewId) {
  // Support being called with just the input element (onchange handler)
  const resolvedPreviewId = previewId || input._previewId || 'attachments-preview';
  const preview = document.getElementById(resolvedPreviewId);
  if (!preview || !input.files) return;

  Array.from(input.files).forEach(file => {
    addAttachmentChip(file, preview);
  });

  // Reset so the same file can be re-selected
  input.value = '';
}

function addAttachmentChip(file, container) {
  const isImage = file.type.startsWith('image/');
  const isPDF = file.type === 'application/pdf';

  const chip = document.createElement('div');
  chip.className = 'attachment-chip';

  const icon = isImage
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
    : isPDF
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  const name = document.createElement('span');
  name.className = 'attachment-chip-name';
  name.textContent = file.name;
  name.title = file.name;

  const remove = document.createElement('button');
  remove.className = 'attachment-remove';
  remove.innerHTML = '×';
  remove.title = 'Remove';
  remove.onclick = () => chip.remove();

  chip.innerHTML = icon;
  chip.appendChild(name);
  chip.appendChild(remove);
  container.appendChild(chip);
}

// ── Handle paste events for URLs / images ──────────────────────
document.addEventListener('paste', function (e) {
  const active = document.querySelector('.screen.active');
  if (!active) return;

  const textarea = active.querySelector('.composer-textarea');
  if (!textarea) return;

  // If an image is on the clipboard, treat it as a file attachment
  const items = e.clipboardData && e.clipboardData.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          // Find the matching preview container for this textarea
          const previewId = textarea.id === 'auth-textarea'
            ? 'auth-attachments-preview'
            : 'attachments-preview';
          const preview = document.getElementById(previewId);
          if (preview) addAttachmentChip(file, preview);
        }
      }
    }
  }
});

// ── Password utilities ─────────────────────────────────────────

function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  // Swap eye icon
  btn.innerHTML = isText
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

function checkStrength(value) {
  const fill = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  if (!fill || !label) return;

  let score = 0;
  if (value.length >= 8) score++;
  if (/[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  const levels = [
    { pct: '0%',   color: 'transparent', text: '' },
    { pct: '25%',  color: '#F87171',     text: 'Weak' },
    { pct: '50%',  color: '#FACC15',     text: 'Fair' },
    { pct: '75%',  color: '#A78BFA',     text: 'Good' },
    { pct: '100%', color: '#4ADE80',     text: 'Strong' },
  ];

  const lvl = levels[score];
  fill.style.width = lvl.pct;
  fill.style.background = lvl.color;
  label.textContent = lvl.text;
  label.style.color = lvl.color;
}

// ── Update avatar/profile UI after login ───────────────────────
function updateAvatar(email) {
  const initial = email.charAt(0).toUpperCase();
  const name = Auth.user?.user_metadata?.account_name || email;

  document.querySelectorAll('.avatar').forEach(el => el.innerHTML = initial);
  document.querySelectorAll('.profile-avatar').forEach(el => el.innerHTML = initial);
  document.querySelectorAll('.profile-name').forEach(el => el.innerHTML = name);
  document.querySelectorAll('.profile-email').forEach(el => el.innerHTML = email);
}

// authentication

async function getToken() {
  const { data } = await sbClient.auth.getSession();
  return data?.session?.access_token || Auth.token;
}
// ── Auth state — kept in memory ────────────────────────────────
// Stores the logged-in user's token and info after login
// ── Config ─────────────────────────────────────────────────────

// ── Config ─────────────────────────────────────────────────────
const SUPABASE_URL = "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth state ─────────────────────────────────────────────────
const Auth = {
  token: null,
  user: null,
  isLoggedIn() { return !!this.token; }
};

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = message;
}

function clearError(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = '';
}

// ── Register ───────────────────────────────────────────────────
async function handleRegister() {
  const account_name = document.querySelector('#screen-register input[type="text"]').value.trim();
  const email        = document.querySelector('#screen-register input[type="email"]').value.trim();
  const password     = document.getElementById('reg-pass').value;
  const confirm      = document.getElementById('confirm-pass').value;

  clearError('register-error');

  if (!account_name || !email || !password) {
    showError('register-error', 'Please fill in all fields.'); return;
  }
  if (password !== confirm) {
    showError('register-error', 'Passwords do not match.'); return;
  }
  if (password.length < 6) {
    showError('register-error', 'Password must be at least 6 characters.'); return;
  }

  const btn = document.querySelector('#screen-register .btn-submit');
  btn.textContent = 'Creating account…';
  btn.disabled = true;

  try {
    const { data, error } = await sbClient.auth.signUp({
      email,
      password,
      options: { data: { account_name } }
    });

    if (error) {
      showError('register-error', error.message); return;
    }

    goto('screen-login');
    showError('login-error', '✓ Account created! Please sign in.');
  } catch (err) {
    showError('register-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.textContent = 'Create account';
    btn.disabled = false;
  }
}

// ── Login ──────────────────────────────────────────────────────
async function handleLogin() {
  const email    = document.querySelector('#screen-login input[type="email"]').value.trim();
  const password = document.getElementById('login-pass').value;

  clearError('login-error');

  if (!email || !password) {
    showError('login-error', 'Please enter your email and password.'); return;
  }

  const btn = document.querySelector('#screen-login .btn-submit');
  btn.textContent = 'Signing in…';
  btn.disabled = true;

  try {
    const { data, error } = await sbClient.auth.signInWithPassword({ email, password });

    if (error) {
      showError('login-error', error.message); return;
    }

    Auth.token = data.session.access_token;
    Auth.user  = data.user;
    updateAvatar(data.user.email);
    goto('screen-home-auth');

  } catch (err) {
    showError('login-error', 'Could not connect to Supabase. Is it running?');
  } finally {
    btn.textContent = 'Sign in';
    btn.disabled = false;
  }
}

// ── Logout ─────────────────────────────────────────────────────
async function handleLogout() {
  try {
    await sbClient.auth.signOut();
  } catch (err) {
    console.log("logout error:", err);
  } finally {
    Auth.token = null;
    Auth.user  = null;
    goto('screen-login');
  }
}

// ── Change Email ───────────────────────────────────────────────
async function changeEmail(newEmail) {
  console.log("attempting to change email")
  const token = await getToken()
  const res = await fetch("http://127.0.0.1:8000/account/email", {
    method: 'PUT',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ email: newEmail })
  });

  const data = await res.json();
  console.log(data);
  if (!res.ok) showError('settings-error', data.detail || 'Failed to update email.');
  else 
    showError('settings-error', '✓ Email updated!')
    updateAvatar(newEmail)
  ;
}

// ── Change Password ────────────────────────────────────────────
async function changePassword(newPassword) {
  const token = await getToken()
  console.log("attempting to change password");
  const res = await fetch("http://127.0.0.1:8000/account/password", {
    method: 'PUT',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ password: newPassword })
  });
  const data = await res.json();
  if (!res.ok) showError('settings-error', data.detail || 'Failed to update password.');
  else showError('settings-error', '✓ Password updated!');
}

// ── Delete Account ─────────────────────────────────────────────
async function deleteAccount() {
  console.log("trying to delete account");
  const token = await getToken()
  const res = await fetch("http://127.0.0.1:8000/account", {
    method: 'DELETE',
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });
  if (!res.ok) { showError('settings-error', 'Failed to delete account.'); return; }
  await sbClient.auth.signOut();
  Auth.token = null;
  Auth.user  = null;
  goto('screen-login');
}



//OLd auth
// const SUPABASE_URL = "http://127.0.0.1:54321";
// const SUPABASE_ANON_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
// const AUTH = `${SUPABASE_URL}/auth/v1`;

// const HEADERS = {
//   "Content-Type": "application/json",
//   "apikey": SUPABASE_ANON_KEY,
// };

// // ── Auth state ─────────────────────────────────────────────────
// const Auth = {
//   token: null,
//   user: null,
//   isLoggedIn() { return !!this.token; }
// };

// // ── Register ───────────────────────────────────────────────────
// async function handleRegister() {
//   const account_name = document.querySelector('#screen-register input[type="text"]').value.trim();
//   const email        = document.querySelector('#screen-register input[type="email"]').value.trim();
//   const password     = document.getElementById('reg-pass').value;
//   const confirm      = document.getElementById('confirm-pass').value;

//   clearError('register-error');

//   if (!account_name || !email || !password) {
//     showError('register-error', 'Please fill in all fields.'); return;
//   }
//   if (password !== confirm) {
//     showError('register-error', 'Passwords do not match.'); return;
//   }
//   if (password.length < 6) {
//     showError('register-error', 'Password must be at least 6 characters.'); return;
//   }

//   const btn = document.querySelector('#screen-register .btn-submit');
//   btn.textContent = 'Creating account…';
//   btn.disabled = true;

//   try {
//     const res = await fetch(`${AUTH}/signup`, {
//       method: 'POST',
//       headers: HEADERS,
//       body: JSON.stringify({
//         email,
//         password,
//         data: { account_name }   // stored in user_metadata
//       })
//     });

//     const data = await res.json();

//     if (!res.ok) {
//       showError('register-error', data.msg || data.error_description || 'Registration failed.');
//       return;
//     }

//     goto('screen-login');
//     showError('login-error', '✓ Account created! Please sign in.');
//   } catch (err) {
//     showError('register-error', 'Could not connect to Supabase. Is it running? (sbClient start)');
//   } finally {
//     btn.textContent = 'Create account';
//     btn.disabled = false;
//   }
// }

// // ── Login ──────────────────────────────────────────────────────
// async function handleLogin() {
//   const email    = document.querySelector('#screen-login input[type="email"]').value.trim();
//   const password = document.getElementById('login-pass').value;

//   clearError('login-error');

//   if (!email || !password) {
//     showError('login-error', 'Please enter your email and password.'); return;
//   }

//   const btn = document.querySelector('#screen-login .btn-submit');
//   btn.textContent = 'Signing in…';
//   btn.disabled = true;

//   try {
//     const res = await fetch(`${AUTH}/token?grant_type=password`, {
//       method: 'POST',
//       headers: HEADERS,
//       body: JSON.stringify({ email, password })
//     });

//     const data = await res.json();
//     console.log("Supabase error:", data);
//     if (!res.ok) {
//       showError('login-error', data.error_description || 'Invalid email or password.');
//       return;
//     }

//     Auth.token = data.access_token;
//     Auth.user  = data.user;
//     const username = data.user.user_metadata?.account_name;
//     updateAvatar(data.user.email, username);
//     goto('screen-home-auth');

//   } catch (err) {
//     showError('login-error', 'Could not connect to Supabase. Is it running? (sbClient start)');
//   } finally {
//     btn.textContent = 'Sign in';
//     btn.disabled = false;
//   }
// }

// // ── Logout ─────────────────────────────────────────────────────
// async function handleLogout() {
//   try {
//     await fetch(`${AUTH}/logout`, {
//       method: 'POST',
//       headers: { ...HEADERS, "Authorization": `Bearer ${Auth.token}` }
//     });
//   } finally {
//     Auth.token = null;
//     Auth.user  = null;
//     goto('screen-login');
//   }
// }

// // change email
// async function changeEmail(newEmail) {
//   const res = await fetch(`${AUTH}/user`, {
//     method: 'PUT',
//     headers: {
//       "Content-Type": "application/json",
//       "apikey": SUPABASE_ANON_KEY,
//       "Authorization": `Bearer ${Auth.token}`
//     },
//     body: JSON.stringify({ email: newEmail })
//   });
//   const data = await res.json();
//   console.log("new email: ", Auth.user.id)
//   if (!res.ok) showError('settings-error', data.msg || 'Failed to update email.');
//   else showError('settings-error', '✓ Email updated!');
//   console.log("success email(?)")
// }

// //change password
// async function changePassword(newPassword) {
//   console.log("trying to change password")
//   const res = await fetch(`${AUTH}/user`, {
//     method: 'PUT',
//     headers: { ...HEADERS, "Authorization": `Bearer ${Auth.token}` },
//     body: JSON.stringify({ password: newPassword })
//   });
//   const data = await res.json();
//   if (!res.ok) showError('settings-error', data.msg || 'Failed to update password.');
//   else showError('settings-error', '✓ Password updated!');
//    console.log("success password(?)")
// }

// async function deleteAccount() {
//   console.log("trying to delete account")
//   const res = await fetch(`http://127.0.0.1:8000/account`, {
//     method: 'DELETE',
//     headers: { "Authorization": `Bearer ${Auth.token}` }
//   });
//   if (res.ok) {
//     Auth.token = null;
//     Auth.user = null;
//     goto('screen-login');
//   }
//    console.log("success delete(?)")
// }


// // ── Update avatar initials after login ─────────────────────────
// function updateAvatar(email, name) {
//   const initial = email.charAt(0).toUpperCase();
//   document.querySelectorAll('.avatar').forEach(el => el.textContent = initial);
//   document.querySelectorAll(".profile-avatar").forEach(el => el.innerHTML = initial);
//   document.querySelectorAll(".profile-name").forEach(el => el.innerHTML = name);
//   document.querySelectorAll(".profile-email").forEach(el => el.innerHTML = email);
//   console.log("HELP ME")
// }