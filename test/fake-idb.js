// Minimal in-memory IndexedDB stand-in for node:test. Covers only what
// public/js/idb.js uses: open/upgrade, transactions over named stores,
// put/add/get/delete/getAll requests, and connection lifecycle. Data is
// shared across connections so a reopen sees what an earlier one wrote.
//
// `killConnections({ fireClose })` simulates WebKit dropping the connection
// while the tab is suspended: every open handle starts throwing
// InvalidStateError from transaction(), and optionally gets its `onclose`
// event — iOS is not consistent about firing it, so tests cover both.

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

function invalidState(msg) {
  return new DOMException(msg, 'InvalidStateError');
}

class FakeStore {
  constructor(tx, name, data, meta) {
    this.tx = tx;
    this.name = name;
    this.data = data;
    this.meta = meta;
  }
  createIndex() {}
  _req(fn) {
    if (this.tx.finished) throw invalidState('transaction finished');
    const req = new FakeRequest();
    this.tx.pending += 1;
    // Requests complete as tasks, like the real thing.
    setTimeout(() => {
      try {
        req.result = fn();
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
      // Let the awaiting continuation run first, as a real transaction stays
      // active through the microtasks that follow a request callback.
      queueMicrotask(() => {
        this.tx.pending -= 1;
        this.tx._maybeComplete();
      });
    });
    return req;
  }
  _key(obj) {
    if (this.meta.keyPath) return obj[this.meta.keyPath];
    return undefined;
  }
  put(obj) {
    return this._req(() => {
      let key = this._key(obj);
      if (key === undefined && this.meta.autoIncrement) {
        key = ++this.meta.seq;
        obj = { ...obj, [this.meta.keyPath]: key };
      }
      this.data.set(key, structuredClone(obj));
      return key;
    });
  }
  add(obj) { return this.put(obj); }
  get(key) { return this._req(() => structuredClone(this.data.get(key))); }
  delete(key) { return this._req(() => { this.data.delete(key); }); }
  getAll() { return this._req(() => [...this.data.values()].map(v => structuredClone(v))); }
}

class FakeTransaction {
  constructor(db, stores, mode) {
    this.db = db;
    this.stores = Array.isArray(stores) ? stores : [stores];
    this.mode = mode;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    // Auto-commit once the creating task returns to the event loop with
    // nothing queued — microtask hops (awaits) in between do not commit it.
    setTimeout(() => this._maybeComplete(), 0);
  }
  objectStore(name) {
    if (!this.stores.includes(name)) throw new DOMException('not in scope', 'NotFoundError');
    const backing = this.db.backend.stores.get(name);
    if (!backing) throw new DOMException('no such store', 'NotFoundError');
    return new FakeStore(this, name, backing.data, backing.meta);
  }
  _maybeComplete() {
    if (this.finished || this.pending > 0) return;
    this.finished = true;
    queueMicrotask(() => this.oncomplete?.({ target: this }));
  }
}

class FakeDatabase {
  constructor(backend) {
    this.backend = backend;
    this.closed = false;
    this.onclose = null;
    this.onversionchange = null;
    this.objectStoreNames = {
      contains: (n) => backend.stores.has(n),
    };
  }
  createObjectStore(name, { keyPath, autoIncrement = false } = {}) {
    const meta = { keyPath, autoIncrement, seq: 0 };
    const entry = { data: new Map(), meta };
    this.backend.stores.set(name, entry);
    return new FakeStore({ pending: 0, finished: false, _maybeComplete() {} }, name, entry.data, meta);
  }
  transaction(stores, mode = 'readonly') {
    if (this.closed) throw invalidState('The database connection is closing.');
    return new FakeTransaction(this, stores, mode);
  }
  close() { this.closed = true; }
}

export function createFakeIndexedDB() {
  const backend = { stores: new Map(), version: 0, connections: [] };
  const idb = {
    opens: 0,
    open(name, version) {
      idb.opens += 1;
      const req = new FakeRequest();
      req.onupgradeneeded = null;
      req.onblocked = null;
      queueMicrotask(() => {
        const db = new FakeDatabase(backend);
        backend.connections.push(db);
        req.result = db;
        if (version > backend.version) {
          backend.version = version;
          req.onupgradeneeded?.({ target: req });
        }
        queueMicrotask(() => req.onsuccess?.({ target: req }));
      });
      return req;
    },
    // Simulate the OS closing every live connection out from under the page.
    killConnections({ fireClose = false } = {}) {
      for (const db of backend.connections) {
        if (db.closed) continue;
        db.closed = true;
        if (fireClose) db.onclose?.({ target: db });
      }
    },
    liveConnections() { return backend.connections.filter(db => !db.closed).length; },
  };
  return idb;
}
