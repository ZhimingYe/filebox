(() => {
  try {
    if (self.__fileboxForwardWorkerShim) return;
    const match = self.location.pathname.match(/^\/_fwd\/[^/]+\/\d+/);
    if (!match) return;
    self.__fileboxForwardWorkerShim = true;
    const prefix = match[0];
    const port = Number(prefix.split('/').pop());
    const fix = value => {
      try {
        const url = new URL(value, self.location.href);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return value;
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80)) === port;
        const local = loopback || url.origin === self.location.origin || (['ws:', 'wss:'].includes(url.protocol) && url.host === self.location.host);
        if (!local) return value;
        if (!url.pathname.startsWith('/_fwd/') && url.pathname !== prefix) url.pathname = prefix + url.pathname;
        if (loopback) { url.host = self.location.host; url.port = self.location.port; url.protocol = ['ws:', 'wss:'].includes(url.protocol) ? (self.location.protocol === 'https:' ? 'wss:' : 'ws:') : self.location.protocol; }
        return url.href;
      } catch (_) { return value; }
    };
    const patch = (object, key, wrap) => {
      try { if (typeof object[key] === 'function') object[key] = wrap(object[key]); } catch (_) {}
    };
    patch(self, 'Request', original => new Proxy(original, {
      construct(target, args, newTarget) {
        try { if (!(args[0] instanceof original)) args[0] = fix(args[0]); } catch (_) {}
        return Reflect.construct(target, args, newTarget);
      }
    }));
    patch(self, 'fetch', original => function (input, ...rest) {
      try { if (!(input instanceof Request)) input = fix(input); } catch (_) {}
      return Reflect.apply(original, this, [input, ...rest]);
    });
    if (self.XMLHttpRequest) patch(XMLHttpRequest.prototype, 'open', original => function (method, url, ...rest) {
      return Reflect.apply(original, this, [method, fix(url), ...rest]);
    });
    for (const key of ['WebSocket', 'EventSource']) patch(self, key, original => new Proxy(original, {
      construct(target, args, newTarget) { try { args[0] = fix(args[0]); } catch (_) {} return Reflect.construct(target, args, newTarget); }
    }));
    patch(self, 'importScripts', original => function (...urls) { return Reflect.apply(original, this, urls.map(fix)); });
  } catch (_) {}
})();
