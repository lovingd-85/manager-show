/* Manager Show 登录页：已登录则回首页；提交密码并处理 401/429/网络错误。 */
'use strict';

(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) location.href = '/';
  } catch { /* 未登录或网络异常：停留登录页 */ }
})();

const form = document.getElementById('login-form');
const errEl = document.getElementById('login-error');
const btn = document.getElementById('login-btn');
const input = document.getElementById('password');
const pwToggle = document.getElementById('pw-toggle');

// autofocus 在某些恢复场景下不生效：确保焦点落在密码框，便于直接键入
if (document.activeElement === document.body) input.focus();

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = false;
  input.classList.add('invalid');
  // 错误抖动提示（styles.css 中已对 prefers-reduced-motion 关闭动画）
  input.classList.remove('shake');
  void input.offsetWidth; /* 重置动画 */
  input.classList.add('shake');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  input.classList.remove('invalid');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) { location.href = '/'; return; }
    const j = await res.json().catch(() => null);
    showError((j && j.error) || `登录失败（${res.status}）`);
    input.select();
  } catch {
    showError('网络错误，请重试');
  }
  btn.disabled = false;
});

pwToggle.addEventListener('click', () => {
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  pwToggle.textContent = hidden ? '隐藏' : '显示';
  input.focus();
});
