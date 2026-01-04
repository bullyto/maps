/* Apéro de Nuit • PWA (démo) — registre SW + forcing update */
(() => {
  const statusEl = document.getElementById('status');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const btnHardReload = document.getElementById('btnHardReload');
  const btnOpenMap = document.getElementById('btnOpenMap');
  const btnInstall = document.getElementById('btnInstall');

  const setStatus = (txt) => { if(statusEl) statusEl.textContent = txt; };

  // Navigation
  if(btnOpenMap){
    btnOpenMap.addEventListener('click', () => { location.href = './map.html'; });
  }

  // Hard reload (bypass caches HTTP, pas SW)
  if(btnHardReload){
    btnHardReload.addEventListener('click', () => {
      setStatus('Hard reload…');
      location.reload(true);
    });
  }

  // Install prompt (Android/Chrome)
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if(btnInstall) btnInstall.hidden = false;
  });

  if(btnInstall){
    btnInstall.addEventListener('click', async () => {
      if(!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btnInstall.hidden = true;
    });
  }

  // Service Worker
  if(!('serviceWorker' in navigator)){
    setStatus('SW non supporté');
    return;
  }

  let reg = null;

  async function registerSW(){
    try{
      reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      setStatus('SW enregistré');

      // Si un SW attend, on le force à prendre la main
      if(reg.waiting){
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      // Détecte les updates
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if(!newWorker) return;
        setStatus('Mise à jour en cours…');
        newWorker.addEventListener('statechange', () => {
          if(newWorker.state === 'installed'){
            if(navigator.serviceWorker.controller){
              // Nouvelle version dispo
              setStatus('Nouvelle version dispo — activation…');
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }else{
              setStatus('Prêt (offline OK)');
            }
          }
        });
      });

      // Quand le SW prend le contrôle, on recharge pour appliquer la version (forcé)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(refreshing) return;
        refreshing = true;
        setStatus('Application de la mise à jour…');
        // Petit délai pour laisser le cache se stabiliser
        setTimeout(() => location.reload(), 150);
      });

      // Messages du SW
      navigator.serviceWorker.addEventListener('message', (evt) => {
        const msg = evt.data || {};
        if(msg.type === 'SW_READY') setStatus('Prêt');
        if(msg.type === 'SW_UPDATED') setStatus('Mis à jour');
      });

      // Check update à l’ouverture (agressif)
      if(reg.update) reg.update();

    }catch(err){
      console.error(err);
      setStatus('Erreur SW');
    }
  }

  if(btnCheckUpdate){
    btnCheckUpdate.addEventListener('click', async () => {
      if(!reg){
        setStatus('SW pas prêt…');
        return;
      }
      setStatus('Recherche MAJ…');
      await reg.update();
      // Si un SW est en attente après update, on force
      if(reg.waiting){
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    });
  }

  registerSW();
})();