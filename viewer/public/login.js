const SELECTED_PERIOD_STORAGE_KEY = 'kpi.selectedPeriod';

const elements = {
  form: document.getElementById('login-form'),
  loginInput: document.getElementById('login-input'),
  passwordInput: document.getElementById('password-input'),
  submitButton: document.getElementById('login-submit'),
  status: document.getElementById('login-status'),
};

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `form-status ${kind}`.trim();
}

function getStoredPeriodCode() {
  try {
    return String(window.localStorage.getItem(SELECTED_PERIOD_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

async function submitLogin(event) {
  event.preventDefault();

  const login = elements.loginInput.value.trim();
  const password = elements.passwordInput.value;
  const periodCode = getStoredPeriodCode();

  elements.submitButton.disabled = true;
  setStatus('Выполняется вход...');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        login,
        password,
        periodCode,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    window.location.replace(payload.redirectTo || '/index.html');
  } catch (error) {
    setStatus(error.message, 'is-error');
    elements.submitButton.disabled = false;
    elements.passwordInput.focus();
    elements.passwordInput.select();
  }
}

async function boot() {
  try {
    elements.form.addEventListener('submit', (event) => {
      void submitLogin(event);
    });

    setStatus('');
    elements.loginInput.focus();
  } catch (error) {
    setStatus(error.message, 'is-error');
  }
}

void boot();
