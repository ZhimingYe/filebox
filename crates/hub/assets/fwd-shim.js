(() => {
  try {
    if (window.__fileboxForwardShim) return;
    const match = location.pathname.match(/^\/_fwd\/[^/]+\/\d+/);
    if (!match) return;
    window.__fileboxForwardShim = true;
    const prefix = match[0];
    const port = Number(prefix.split('/').pop());
    const fix = value => {
      try {
        const url = new URL(value, document.baseURI);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return value;
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80)) === port;
        const local = loopback || url.origin === location.origin ||
          (['ws:', 'wss:'].includes(url.protocol) && url.host === location.host);
        if (local) {
          if (url.pathname !== prefix && !url.pathname.startsWith('/_fwd/')) url.pathname = prefix + url.pathname;
          if (loopback) { url.host = location.host; url.port = location.port; url.protocol = ['ws:', 'wss:'].includes(url.protocol) ? (location.protocol === 'https:' ? 'wss:' : 'ws:') : location.protocol; }
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
    const attributes = new Set(['src', 'href', 'action', 'formaction', 'poster']);
    const types = ['HTMLScriptElement', 'HTMLLinkElement', 'HTMLImageElement', 'HTMLIFrameElement', 'HTMLAnchorElement', 'HTMLFormElement', 'HTMLSourceElement', 'HTMLVideoElement', 'HTMLAudioElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLBaseElement'];
    const prototypes = types.map(key => window[key]?.prototype).filter(Boolean);
    const supported = element => prototypes.some(prototype => prototype.isPrototypeOf(element));
    const nativeAttribute = window.Element?.prototype.setAttribute;
    const nativeRemoveAttribute = window.Element?.prototype.removeAttribute;
    const manifestJobs = new WeakMap();
    const isManifest = element => element.localName === 'link' && element.rel.split(/\s+/).some(value => value.toLowerCase() === 'manifest');
    const manifestRel = value => String(value).split(/\s+/).some(token => token.toLowerCase() === 'manifest');
    const manifest = (element, value) => {
      try {
        if (!isManifest(element)) { manifestJobs.delete(element); return false; }
        if (!element.hasAttribute('crossorigin')) Reflect.apply(nativeAttribute, element, ['crossorigin', 'use-credentials']);
        const explicit = value !== undefined;
        value = explicit ? value : element.getAttribute('href');
        if (!value) { if (explicit) manifestJobs.delete(element); return false; }
        const url = new URL(fix(value), document.baseURI);
        if (url.origin !== location.origin || !url.pathname.startsWith(prefix + '/')) { manifestJobs.delete(element); return false; }
        if (!explicit && url.searchParams.has('__filebox_manifest')) return true;
        if (manifestJobs.get(element)?.url === url.href) return true;
        const job = { url: url.href };
        manifestJobs.set(element, job);
        Reflect.apply(nativeRemoveAttribute, element, ['href']);
        const endpoint = new URL(prefix + '/__filebox_manifest_token', location.origin);
        endpoint.searchParams.set('url', url.href);
        Promise.resolve(window.fetch(endpoint.href, { credentials: 'same-origin', cache: 'no-store' })).then(async response => {
          if (!response?.ok) throw new Error('Manifest authorization failed');
          const result = await response.json();
          const signed = new URL(result.href);
          if (signed.origin !== location.origin || !signed.pathname.startsWith(prefix + '/') || !signed.searchParams.has('__filebox_manifest')) throw new Error('Invalid manifest authorization');
          if (manifestJobs.get(element) === job && isManifest(element)) Reflect.apply(nativeAttribute, element, ['href', signed.href]);
        }).catch(() => {
          if (manifestJobs.get(element) === job) { manifestJobs.delete(element); element.dispatchEvent(new Event('error')); }
        });
        return true;
      } catch (_) {}
      return false;
    };
    if (window.Element) patch(Element.prototype, 'setAttribute', original => function (name, value) {
      if (String(name).toLowerCase() === 'href' && manifest(this, value)) return;
      const href = this.localName === 'link' && String(name).toLowerCase() === 'rel' && manifestRel(value) ? this.getAttribute('href') : null;
      if (href) Reflect.apply(nativeRemoveAttribute, this, ['href']);
      try { if (supported(this) && attributes.has(String(name).toLowerCase())) value = fix(value); } catch (_) {}
      const result = Reflect.apply(original, this, [name, value]);
      manifest(this, href || undefined);
      return result;
    });
    try {
      const prototype = window.HTMLLinkElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'rel');
      Object.defineProperty(prototype, 'rel', { ...descriptor, set(value) {
        const href = manifestRel(value) ? this.getAttribute('href') : null;
        if (href) Reflect.apply(nativeRemoveAttribute, this, ['href']);
        Reflect.apply(descriptor.set, this, [value]);
        manifest(this, href || undefined);
      } });
    } catch (_) {}
    if (window.Element) patch(Element.prototype, 'removeAttribute', original => function (name) {
      if (String(name).toLowerCase() === 'href') manifestJobs.delete(this);
      return Reflect.apply(original, this, [name]);
    });
    for (const prototype of prototypes) {
      for (const key of ['src', 'href', 'action', 'formAction', 'poster']) {
        try {
          let owner = prototype;
          let descriptor;
          while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) owner = Object.getPrototypeOf(owner);
          if (!descriptor?.set) continue;
          Object.defineProperty(prototype, key, { ...descriptor, set(value) {
            if (key === 'href' && manifest(this, value)) return;
            try { value = fix(value); } catch (_) {}
            return Reflect.apply(descriptor.set, this, [value]);
          } });
        } catch (_) {}
      }
    }
    const fixAttribute = (element, name) => {
      try { if (element?.hasAttribute(name)) element.setAttribute(name, fix(element.getAttribute(name))); } catch (_) {}
    };
    document.addEventListener?.('click', event => {
      try {
        const anchor = event.composedPath().find(node => node?.localName === 'a') || event.target?.closest?.('a');
        fixAttribute(anchor, 'href');
      } catch (_) {}
    }, true);
    const fixForm = (form, submitter) => {
      try {
        if (!form.hasAttribute('action')) form.action = fix(location.href);
        else fixAttribute(form, 'action');
        for (const button of form.querySelectorAll('[formaction]')) fixAttribute(button, 'formaction');
        fixAttribute(submitter, 'formaction');
      } catch (_) {}
    };
    document.addEventListener?.('submit', event => fixForm(event.target, event.submitter), true);
    if (window.HTMLFormElement) {
      for (const key of ['submit', 'requestSubmit']) patch(HTMLFormElement.prototype, key, original => function (...args) {
        fixForm(this, args[0]);
        return Reflect.apply(original, this, args);
      });
    }
    const scan = node => {
      try { manifest(node); for (const link of node.querySelectorAll?.('link[rel]') || []) manifest(link); } catch (_) {}
    };
    for (const prototype of [window.Node?.prototype, window.Element?.prototype, window.Document?.prototype, window.DocumentFragment?.prototype].filter(Boolean)) {
      for (const key of ['appendChild', 'insertBefore', 'replaceChild', 'append', 'prepend', 'replaceChildren', 'insertAdjacentElement']) {
        if (Object.prototype.hasOwnProperty.call(prototype, key)) patch(prototype, key, original => function (...args) {
          for (const node of args) if (node && typeof node === 'object') scan(node);
          return Reflect.apply(original, this, args);
        });
      }
    }
    scan(document);
    if (window.MutationObserver) new MutationObserver(records => {
      for (const record of records) { scan(record.target); for (const node of record.addedNodes || []) scan(node); }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel', 'crossorigin', 'href'] });
    try {
      let prototype = document;
      let descriptor;
      while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, 'cookie'))) prototype = Object.getPrototypeOf(prototype);
      if (descriptor?.get && descriptor?.set) {
        const secure = location.protocol === 'https:';
        Object.defineProperty(document, 'cookie', { configurable: true, get() {
          return Reflect.apply(descriptor.get, this, []).split(';').map(part => {
            const separator = part.indexOf('=');
            if (separator < 0) return part;
            let name = part.slice(0, separator).trim();
            if (name.startsWith('__Secure-fbh-')) name = '__Host-' + name.slice(13);
            else if (name.startsWith('fbs-fbh-')) name = '__Host-' + name.slice(8);
            else if (name.startsWith('fbs-')) name = '__Secure-' + name.slice(4);
            return name + part.slice(separator);
          }).join('; ');
        }, set(value) {
          try {
            const parts = String(value).split(';');
            const separator = parts[0].indexOf('=');
            if (separator >= 0) {
              let name = parts[0].slice(0, separator).trim();
              if (name.startsWith('__Host-')) name = '__Secure-fbh-' + name.slice(7);
              if (!secure && name.startsWith('__Secure-')) name = 'fbs-' + name.slice(9);
              parts[0] = name + parts[0].slice(separator);
            }
            let path = false;
            const result = [parts[0]];
            for (let part of parts.slice(1)) {
              const separator = part.indexOf('=');
              const key = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
              const value = separator < 0 ? '' : part.slice(separator + 1).trim();
              if (key === 'domain' || (!secure && key === 'secure')) continue;
              if (key === 'path') {
                if (path) continue;
                path = true;
                part = 'Path=' + (value === prefix || value.startsWith(prefix + '/') ? value : prefix + '/' + value.replace(/^\/+/, ''));
              } else if (!secure && key === 'samesite' && value.toLowerCase() === 'none') part = 'SameSite=Lax';
              result.push(part);
            }
            if (!path) result.push('Path=' + prefix + '/');
            value = result.join('; ');
          } catch (_) {}
          return Reflect.apply(descriptor.set, this, [value]);
        } });
      }
    } catch (_) {}
  } catch (_) {}
})();
