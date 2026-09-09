/** Small deterministic compatibility shims, scoped to the disposable parser realm.
 * PDF.js 6 uses ES2026 Map insertion helpers; browsers must not need eval/CDN polyfills.
 * This module is imported only by the dedicated PDF adapter (and its unit tests).
 */
for (const prototype of [Map.prototype, WeakMap.prototype]) {
  if (!('getOrInsert' in prototype))
    Object.defineProperty(prototype, 'getOrInsert', {
      configurable: true,
      writable: true,
      value: function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
    });
  if (!('getOrInsertComputed' in prototype))
    Object.defineProperty(prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function (
        this: Map<unknown, unknown>,
        key: unknown,
        callback: (key: unknown) => unknown,
      ) {
        if (typeof callback !== 'function') throw new TypeError('Invalid map callback');
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      },
    });
}
if (!('toHex' in Uint8Array.prototype))
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    configurable: true,
    writable: true,
    value: function (this: Uint8Array) {
      let text = '';
      for (const byte of this) text += byte.toString(16).padStart(2, '0');
      return text;
    },
  });
export {};
