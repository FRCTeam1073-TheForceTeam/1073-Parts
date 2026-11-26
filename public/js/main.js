// Entry point: login / first-run setup, tabs, and boot.
import {
  h, api, toast, prefs, state, ROLE_LABEL, registerView, refresh, render, field,
  setUnauthorizedHandler, closeModal,
} from './core.js';
import { renderOrders } from './orders.js';
import { renderInventory } from './inventory.js';
import { renderBoard } from './board.js';
import { renderCarts } from './carts.js';
import { renderBudget } from './budget.js';
import { renderSettings } from './settings.js';

registerView('orders', renderOrders);
registerView('board', renderBoard);
registerView('inventory', renderInventory);
registerView('carts', renderCarts);
registerView('budget', renderBudget);
registerView('settings', renderSettings);

const topbar = document.querySelector('.topbar');
const tabs = document.getElementById('tabs');
const userBox = document.getElementById('user-box');

// The top-left name text node sits after the "1073" logo span.
function setBrandName(name) {
  topbar.querySelector('.brand').lastChild.textContent = ` ${name}`;
}

function showSignedOut() {
  closeModal();
  topbar.classList.add('signed-out');
  document.body.classList.remove('login-screen', 'fading');
  setBrandName('Parts');
  userBox.replaceChildren();
}

function authScreen(title, subtitle, fields, submitLabel, onSubmit, { brandName = 'Parts', onSuccess } = {}) {
  showSignedOut();
  const error = h('div', { class: 'auth-error', role: 'alert' });
  const button = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await onSubmit();
      if (onSuccess) await onSuccess();
      boot();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  } },
  h('div', { class: 'brand big' }, h('span', { class: 'logo' }, '1073'), ` ${brandName}`),
  h('h2', {}, title),
  subtitle ? h('p', { class: 'note' }, subtitle) : null,
  fields, error, button);
  document.getElementById('view').replaceChildren(h('div', { class: 'auth-wrap' }, form));
  form.querySelector('input')?.focus();
}

// After a successful sign-in: swap the card for the message, fade the message and the moon out, then continue.
function celebrateLogin() {
  document.querySelector('#view .auth-wrap').replaceChildren(h('div', { class: 'no-moon', role: 'status' }, "That's no moon!"));
  document.body.classList.add('fading');
  return new Promise((resolve) => setTimeout(resolve, 3000));
}

function showLogin() {
  const username = h('input', { type: 'text', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  authScreen('Sign in', 'Ask a mentor or admin if you need an account.',
    [field('Username', username), field('Password', password)], 'Sign in',
    () => api('POST', '/api/login', { username: username.value.trim(), password: password.value }),
    { brandName: 'The Moon', onSuccess: celebrateLogin });
  document.body.classList.add('login-screen');
  setBrandName('The Moon');
}

function showSetup(needsCode) {
  const display = h('input', { type: 'text', autocomplete: 'name', required: true, placeholder: 'e.g. Pat Smith' });
  const username = h('input', { type: 'text', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'At least 8 characters' });
  const confirmPw = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const code = h('input', { type: 'text', autocomplete: 'off', required: true, placeholder: 'From the server settings' });
  authScreen('Create the admin account',
    'First time here. This account can add the rest of the team (students, mentors, other admins) from Settings.',
    [needsCode ? field('Setup code', code) : null, field('Your name', display), field('Username', username), field('Password', password), field('Confirm password', confirmPw)],
    'Create account',
    async () => {
      if (password.value !== confirmPw.value) throw new Error('Passwords do not match.');
      await api('POST', '/api/setup', { display_name: display.value.trim(), username: username.value.trim(), password: password.value, setup_code: code.value.trim() });
    });
}

function showUser() {
  topbar.classList.remove('signed-out');
  if (document.body.classList.contains('login-screen')) {
    // Coming straight from the sign-in screen: fade the app in, then clear the class.
    document.body.classList.add('app-fade-in');
    document.body.addEventListener('animationend', () => document.body.classList.remove('app-fade-in'), { once: true });
  }
  document.body.classList.remove('login-screen', 'fading');
  setBrandName('Parts');
  userBox.replaceChildren(
    h('span', { class: 'user-name' }, state.user.display_name, h('span', { class: 'role-tag' }, ROLE_LABEL[state.user.role])),
    h('button', { class: 'btn small', onclick: async () => {
      await api('POST', '/api/logout').catch(() => {});
      boot();
    } }, 'Sign out'));
}

tabs.addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (!view) return;
  state.view = view;
  prefs.set('view', view);
  render();
});

setUnauthorizedHandler(() => boot());

async function boot() {
  try {
    const auth = await fetch('/api/auth').then((r) => r.json());
    if (auth.setup) return showSetup(auth.setupNeedsCode);
    if (!auth.user) return showLogin();
    await refresh();
    showUser();
  } catch (err) {
    toast(err.message, true);
  }
}

boot();
