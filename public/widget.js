// Ezicon embeddable widget — one script tag installs the concierge on any site.
// Loads a floating chat button in the bottom-right that expands to an iframe
// pointing at /widget-ui with the hotel id set by data-hotel-id on the script tag.
//
// Install:
//   <script src="https://eazicon.onrender.com/widget.js" data-hotel-id="your-id" async></script>
//
// Design decisions:
//   - Everything scoped under #ezicon-* ids to avoid clashing with host site CSS
//   - Iframe (not shadow DOM) for maximum browser support and hard isolation
//   - Position and colors baked in — configurable via data-* attrs on script tag
//   - No external dependencies, works on any page including plain HTML

(function () {
  // Prevent double-injection if the script is included twice
  if (window.__eziconLoaded) return;
  window.__eziconLoaded = true;

  // Resolve hotelId and API base from the script tag itself
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) if (scripts[i].src.includes('widget.js')) return scripts[i];
    return null;
  })();
  if (!currentScript) return;

  const hotelId = currentScript.getAttribute('data-hotel-id');
  if (!hotelId) {
    console.warn('[ezicon] widget.js needs data-hotel-id on the script tag');
    return;
  }

  // Derive API base from where widget.js was served — same origin as the backend
  const src = new URL(currentScript.src);
  const apiBase = `${src.protocol}//${src.host}`;
  const position = currentScript.getAttribute('data-position') || 'bottom-right';
  const primaryColor = currentScript.getAttribute('data-color') || '#0a2e4a';
  const accentColor = currentScript.getAttribute('data-accent') || '#a6f5c0';

  // ---- Inject styles ----
  const style = document.createElement('style');
  style.textContent = `
    #ezicon-launcher {
      position: fixed; ${position.includes('bottom') ? 'bottom: 20px;' : 'top: 20px;'}
      ${position.includes('right') ? 'right: 20px;' : 'left: 20px;'}
      width: 60px; height: 60px; border-radius: 50%;
      background: ${primaryColor}; color: #fff; border: none;
      cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483000; transition: transform 0.2s ease, box-shadow 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #ezicon-launcher:hover { transform: scale(1.08); box-shadow: 0 12px 30px rgba(0,0,0,0.24); }
    #ezicon-launcher svg { width: 26px; height: 26px; stroke: ${accentColor}; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    #ezicon-launcher .close-icon { display: none; }
    #ezicon-launcher.open .chat-icon { display: none; }
    #ezicon-launcher.open .close-icon { display: block; }

    #ezicon-frame-wrap {
      position: fixed; ${position.includes('bottom') ? 'bottom: 96px;' : 'top: 96px;'}
      ${position.includes('right') ? 'right: 20px;' : 'left: 20px;'}
      width: 380px; height: min(600px, calc(100vh - 130px));
      background: #fff; border-radius: 16px; overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,0.22);
      z-index: 2147482999; display: none;
      opacity: 0; transform: translateY(12px);
      transition: opacity 0.25s ease, transform 0.25s ease;
    }
    #ezicon-frame-wrap.open { display: block; }
    #ezicon-frame-wrap.shown { opacity: 1; transform: translateY(0); }
    #ezicon-frame { width: 100%; height: 100%; border: none; }

    @media (max-width: 480px) {
      #ezicon-frame-wrap {
        width: calc(100vw - 20px); height: calc(100vh - 100px);
        ${position.includes('right') ? 'right: 10px;' : 'left: 10px;'}
        ${position.includes('bottom') ? 'bottom: 86px;' : 'top: 86px;'}
      }
    }
  `;
  document.head.appendChild(style);

  // ---- Inject launcher button ----
  const launcher = document.createElement('button');
  launcher.id = 'ezicon-launcher';
  launcher.setAttribute('aria-label', 'Open concierge chat');
  launcher.innerHTML = `
    <svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    <svg class="close-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  `;
  document.body.appendChild(launcher);

  // ---- Inject iframe wrapper (lazy load — only build the iframe once, on first open) ----
  const wrap = document.createElement('div');
  wrap.id = 'ezicon-frame-wrap';
  document.body.appendChild(wrap);

  let iframeLoaded = false;
  function ensureIframe() {
    if (iframeLoaded) return;
    const iframe = document.createElement('iframe');
    iframe.id = 'ezicon-frame';
    iframe.title = 'Concierge chat';
    iframe.src = `${apiBase}/widget-ui?hotelId=${encodeURIComponent(hotelId)}`;
    iframe.allow = 'microphone';
    wrap.appendChild(iframe);
    iframeLoaded = true;
  }

  launcher.addEventListener('click', () => {
    const isOpen = launcher.classList.toggle('open');
    if (isOpen) {
      ensureIframe();
      wrap.classList.add('open');
      // Force a paint before adding the transition class for a smooth entrance
      requestAnimationFrame(() => wrap.classList.add('shown'));
      launcher.setAttribute('aria-label', 'Close concierge chat');
    } else {
      wrap.classList.remove('shown');
      setTimeout(() => wrap.classList.remove('open'), 250);
      launcher.setAttribute('aria-label', 'Open concierge chat');
    }
  });
})();
