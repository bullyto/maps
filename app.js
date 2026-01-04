/* Apéro de Nuit • Suivi — App bootstrap (SW + install + force update) */
(() => {
  const statusEl = document.getElementById('status');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const btnInstall = document.getElementById('btnInstall');

  const setStatus = (t) => { if(statusEl) statusEl.textContent = t; };

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) btnInstall.hidden = false;
  });

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btnInstall.hidden = true;
    });
  }

  if (!('serviceWorker' in navigator)) {
    setStatus('Service Worker non supporté');
    return;
  }

  let reg = null;

  async function registerSW() {
    try {
      reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      setStatus('Prêt');

      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });

      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        setStatus('Mise à jour…');
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        setStatus('Application MAJ…');
        setTimeout(() => location.reload(), 120);
      });

      if (reg.update) reg.update();
    } catch (e) {
      console.error(e);
      setStatus('Erreur SW');
    }
  }

  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', async () => {
      if (!reg) return;
      setStatus('Recherche MAJ…');
      await reg.update();
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
  }

  registerSW();
})();
