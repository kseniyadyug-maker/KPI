(function initializeAuthClient() {
  const LOGIN_URL = '/';
  const SESSION_URL = '/api/auth/session';
  const LOGOUT_URL = '/api/auth/logout';
  const nativeFetch = window.fetch.bind(window);
  const KNOWN_PAGES = [
    { path: '/index.html', href: '/', label: 'KPI' },
    { path: '/staff.html', href: '/staff.html', label: 'Сотрудники' },
    { path: '/objects.html', href: '/objects.html', label: 'Объекты' },
    { path: '/upload.html', href: '/upload.html', label: 'Загрузка' },
    { path: '/metrics.html', href: '/metrics.html', label: 'Показатели' },
    { path: '/position-kpi.html', href: '/position-kpi.html', label: 'По должностям' },
    { path: '/users.html', href: '/users.html', label: 'Пользователи' },
    { path: '/logs.html', href: '/logs.html', label: 'Логи' },
  ];
  let logoutStarted = false;
  let sessionPromise = null;

  function normalizePagePath(pathname) {
    if (!pathname || pathname === '/') {
      return '/index.html';
    }

    return pathname;
  }

  function redirectToLogin() {
    window.location.replace(LOGIN_URL);
  }

  function getVisiblePageSet(permissions) {
    return new Set((permissions?.visiblePages || []).map(normalizePagePath));
  }

  function setPermissionVisibility(permissions) {
    document.querySelectorAll('[data-requires-permission]').forEach((node) => {
      const permissionName = node.getAttribute('data-requires-permission');
      const isAllowed = Boolean(permissionName && permissions && permissions[permissionName]);
      node.hidden = !isAllowed;
      if ('disabled' in node) {
        node.disabled = !isAllowed;
      }
    });
  }

  function injectLogoutButton() {
    const nav = document.querySelector('.hero-nav');
    if (!nav) {
      return null;
    }

    const existingButton = nav.querySelector('[data-auth-logout]');
    if (existingButton) {
      return existingButton;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-link nav-link-logout';
    button.textContent = 'Выйти';
    button.setAttribute('data-auth-logout', '1');
    button.addEventListener('click', logout);
    nav.appendChild(button);
    return button;
  }

  function findNavLink(nav, href) {
    return nav.querySelector(`a[href="${href}"]`);
  }

  function syncNavigation(permissions) {
    const nav = document.querySelector('.hero-nav');
    if (!nav) {
      return;
    }

    const visiblePages = getVisiblePageSet(permissions);
    const currentPath = normalizePagePath(window.location.pathname);
    const logoutButton = injectLogoutButton();

    KNOWN_PAGES.forEach((page) => {
      let link = findNavLink(nav, page.href);
      if (!link && page.href === '/') {
        link = findNavLink(nav, page.path);
      }

      if (!link && visiblePages.has(page.path)) {
        link = document.createElement('a');
        link.className = 'nav-link';
        link.href = page.href;
        link.textContent = page.label;
        if (logoutButton) {
          nav.insertBefore(link, logoutButton);
        } else {
          nav.appendChild(link);
        }
      }

      if (!link) {
        return;
      }

      const isVisible = visiblePages.has(page.path);
      link.hidden = !isVisible;
      link.classList.toggle('is-active', isVisible && currentPath === page.path);
    });
  }

  function applySessionState(payload) {
    window.kpiAuth = {
      authenticated: Boolean(payload?.authenticated),
      user: payload?.user || null,
      permissions: payload?.permissions || null,
      logout,
    };

    setPermissionVisibility(window.kpiAuth.permissions);
    syncNavigation(window.kpiAuth.permissions);
    window.dispatchEvent(new CustomEvent('kpi-auth-ready', { detail: window.kpiAuth }));
  }

  async function loadSession(force = false) {
    if (sessionPromise && !force) {
      return sessionPromise;
    }

    sessionPromise = (async () => {
      const response = await nativeFetch(SESSION_URL, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (!response.ok) {
        redirectToLogin();
        throw new Error('Требуется авторизация.');
      }

      const payload = await response.json();
      applySessionState(payload);
      return payload;
    })().catch((error) => {
      redirectToLogin();
      throw error;
    });

    window.kpiAuthReady = sessionPromise;
    return sessionPromise;
  }

  async function logout() {
    if (logoutStarted) {
      return;
    }

    logoutStarted = true;
    try {
      await nativeFetch(LOGOUT_URL, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch {
      // Ignore network errors during logout and always force navigation to login.
    }

    redirectToLogin();
  }

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (response.status === 401) {
      redirectToLogin();
      throw new Error('Требуется авторизация.');
    }

    return response;
  };

  document.addEventListener('DOMContentLoaded', () => {
    void loadSession();
  });

  window.addEventListener('pageshow', () => {
    void loadSession(true);
  });
}());
