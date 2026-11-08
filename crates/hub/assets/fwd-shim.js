(() => {
  try {
    if (window.__fileboxForwardShim) return;
    const match = location.pathname.match(/^\/_fwd\/[^/]+\/\d+/);
    if (!match) return;
    window.__fileboxForwardShim = true;
    const prefix = match[0];
    const fix = value => {
      try {
        const url = new URL(value, document.baseURI);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return value;
        const local = url.origin === location.origin ||
          (['ws:', 'wss:'].includes(url.protocol) && url.host === location.host);
        if (local && !url.pathname.startsWith(prefix + '/') && !url.pathname.startsWith('/_fwd/')) {
          url.pathname = prefix + url.pathname;
          return url.href;
        }
      } catch (_) {}
      return value;
    };
    const patch = (object, key, wrap) => {
      try { if (typeof object[key] === 'function') object[key] = wrap(object[key]); } catch (_) {}
    };
    patch(window, 'Request', original => new Proxy(original, {
      construct(target, args, newTarget) {
        try { if (!(args[0] instanceof original)) args[0] = fix(args[0]); } catch (_) {}
        return Reflect.construct(target, args, newTarget);
      }
    }));
    patch(window, 'fetch', original => function (input, ...rest) {
      try {
        // Rebuilding a Request from its body turns fixed uploads into streams,
        // which Chromium cannot send over HTTP/1. Pre-existing Requests use the Referer fallback.
        if (!(input instanceof Request)) input = fix(input);
      } catch (_) {}
      return Reflect.apply(original, this, [input, ...rest]);
    });
    patch(XMLHttpRequest.prototype, 'open', original => function (method, url, ...rest) {
      return Reflect.apply(original, this, [method, fix(url), ...rest]);
    });
    for (const key of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
      patch(window, key, original => new Proxy(original, {
        construct(target, args, newTarget) {
          try { args[0] = fix(args[0]); } catch (_) {}
          return Reflect.construct(target, args, newTarget);
        }
      }));
    }
    for (const key of ['pushState', 'replaceState']) {
      patch(history, key, original => function (state, title, url) {
        return Reflect.apply(original, this, [state, title, url == null ? url : fix(url)]);
      });
    }
    patch(window, 'open', original => function (url, ...rest) {
      return Reflect.apply(original, this, [url == null ? url : fix(url), ...rest]);
    });
    patch(navigator, 'sendBeacon', original => function (url, ...rest) {
      return Reflect.apply(original, this, [fix(url), ...rest]);
    });
    if (navigator.serviceWorker) patch(navigator.serviceWorker, 'register', () => function () {
      return Promise.reject(new Error('Service workers are unavailable through filebox forwarding'));
    });
  } catch (_) {}
})();
