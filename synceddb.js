// SyncedDB

// Begin universal Module Definition
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module.
    define([], factory);
  } else if (typeof exports === 'object') {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory();
  } else {
    // Browser globals (root is window)
    root.syncedDB = factory();
  }
}(this, function () {
'use strict';
var exports = {};
// End Universal Module Definition

function toArray(arr) {
  return [].slice.call(arr);
}

function eachKeyVal(obj, fn) {
  Object.keys(obj).forEach(function(key) { fn(key, obj[key]); });
}

var handleVersionChange = function(e) {
  // The database is being deleted or opened with
  // a newer version, possibly in another tab
  e.target.close();
};

function isObject(o) {
  return o !== null && typeof o === 'object';
}

function Countdown(initial) {
  this.val = initial || 0;
}
Countdown.prototype.add = function(n) {
  this.val += n;
  if (this.val === 0) this.onZero();
};

function resolve(val) {
  this.thenCbs.forEach(function(fn) {
    fn(val);
  });
};

function reject(val) {
  this.catchCbs.forEach(function(fn) {
    fn(val);
  });
};

function ImmediateThenable(fn) {
  this.thenCbs = [];
  this.catchCbs = [];
  fn(resolve.bind(this), reject.bind(this));
}

ImmediateThenable.prototype.then = function(cb) {
  this.thenCbs.push(cb);
};

ImmediateThenable.prototype.catch = function(cb) {
  this.catchCbs.push(cb);
};

function WrappedSocket(url, protocol) {
  var wws = this;
  Events(wws);
  var ws = this.ws = new WebSocket(url, protocol);
  ws.onopen = function () {
    console.log('Connection open');
    wws.emit('open');
  };
  ws.onerror = function (error) {
    console.log('Connection errror');
    console.log(error);
    wws.emit('error', error);
  };
  ws.onclose = function (e) {
    console.log('Connection closed');
    console.log(e);
    wws.emit('close', e);
  };
  ws.onmessage = function(msg) {
    console.log('Message recieved');
    var data;
    if (typeof msg.data === 'string') {
      data = JSON.parse(msg.data);
    } else {
      data = msg.data;
    }
    wws.emit('message', data);
  };
}

WrappedSocket.prototype.send = function(msg) {
  if (isObject(msg)) {
    this.ws.send(JSON.stringify(msg));
  } else {
    this.ws.send(msg);
  }
};

var SDBIndex = function(name, db, store) {
  this.name = name;
  this.db = db;
  this.store = store;
};

function doIndexGet(idx, ranges, tx, resolve, reject) {
  var records = [];
  var index = idx.store.IDBStore.index(idx.name);
  var countdown = new Countdown(ranges.length);
  countdown.onZero = function() {
    resolve(records);
  };
  ranges.forEach(function(range) {
    getInRange(index, range)
    .then(function(recs) {
      records = records.concat(recs);
      countdown.add(-1);
    });
  });
}

SDBIndex.prototype.get = function(/* ranges */) {
  var index = this;
  var ranges = toArray(arguments).map(IDBKeyRange.only);
  return doInStoreTx('readonly', index.store, function(tx, resolve, reject) {
    return doIndexGet(index, ranges, tx, resolve, reject);
  });
};

SDBIndex.prototype.inRange = function(/* ranges */) {
  var index = this;
  var ranges = toArray(arguments).map(createKeyRange);
  return doInStoreTx('readonly', index.store, function(tx, resolve, reject) {
    return doIndexGet(index, ranges, tx, resolve, reject);
  });
};

function setStoreTx(store, tx) {
  store.IDBStore = tx.objectStore(store.name);
  tx.addEventListener('complete', function() {
    emitChangeEvents(store.changedRecords, store.db.stores[store.name]);
    store.changedRecords.length = 0;
  });
}

var SDBObjectStore = function(db, name, indexes, tx) {
  var store = this;
  store.name = name;
  store.db = db;
  store.indexes = indexes;
  store.tx = tx;
  store.changedRecords = [];
  Events(store);
  indexes.forEach(function(i) {
    store[i] = new SDBIndex(i, db, store);
  });
  if (tx) setStoreTx(store, tx);
};

SDBObjectStore.prototype.get = function(/* keys */) {
  var store = this;
  var keys = toArray(arguments);
  return doInStoreTx('readonly', store, function(tx, resolve, reject) {
    var records = [];
    keys.forEach(function(key) {
      var req = store.IDBStore.get(key);
      req.onsuccess = function() {
        records.push(req.result);
        if (keys.length === records.length)
          resolve(keys.length == 1 ? records[0] : records);
      };
    });
  });
};

function doInStoreTx(mode, store, cb) {
  if (store.tx) { // We're in transaction
    return (new ImmediateThenable(function(resolve, reject) {
      cb(store.tx, resolve, reject);
    }));
  } else {
    return store.db.then(function() {
      var tx = store.db.db.transaction(store.name, mode);
      setStoreTx(store, tx);
      return (new Promise(function(resolve, reject) {
        var res;
        cb(tx, function(r) { res = r; }, reject);
        tx.oncomplete = function() { resolve(res); };
      }));
    });
  }
}

SDBObjectStore.prototype.put = function(/* recs */) {
  var recs = toArray(arguments);
  var store = this;
  return doInStoreTx('readwrite', store, function(tx, resolve, reject) {
    recs.forEach(function(val) {
      val.changedSinceSync = 1;
      if (val.serverId && !val.remoteOriginal) {
        // FIXME
      }
    });
    putValsToStore(store, recs).then(function(ks) {
      resolve(ks);
    });
  });
};

function getInRange(index, range) {
  return new ImmediateThenable(function(resolve, reject) {
    var records = [];
    var req = index.openCursor(range);
    req.onsuccess = function() {
      var cursor = req.result;
      if (cursor) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        resolve(records);
      }
    };
  });
}

function emitChangeEvents(changes, dbStore) {
  changes.forEach(function(change) {
    dbStore.emit(change.type, {
      record: change.record
    });
  });
}

function insertValInStore(method, store, val, silent) {
  var IDBStore = store.IDBStore;
  return new ImmediateThenable(function(resolve, reject) {
    var isNew = !('key' in val);
    if (isNew) val.key = Math.random().toString(36);
    var req = IDBStore[method](val);
    req.onsuccess = function() {
      var type = (method === 'add' || isNew) ? 'add' : 'update';
      if (!silent) store.changedRecords.push({type: type, record: val});
      resolve(req.result);
    };
  });
}

var putValToStore = insertValInStore.bind(null, 'put');
var addValToStore = insertValInStore.bind(null, 'add');

var insertValsInStore = function(method, store, vals) {
  return new ImmediateThenable(function(resolve, reject) {
    var keys = [];
    vals.forEach(function(val) {
      insertValInStore(method, store, val).then(function(key) {
        keys.push(key);
        if (keys.length === vals.length)
          resolve(vals.length == 1 ? keys[0] : keys);
      });
    });
  });
};

var putValsToStore = insertValsInStore.bind(null, 'put');
var addValsToStore = insertValsInStore.bind(null, 'add');

var createKeyRange = function(r) {
  var gt   = 'gt' in r,
      gte  = 'gte' in r,
      lt   = 'lt' in r,
      lte  = 'lte' in r,
      low  = gt ? r.gt : r.gte,
      high = lt ? r.lt : r.lte;
  return !(gt || gte) ? IDBKeyRange.upperBound(high, lt)
       : !(lt || lte) ? IDBKeyRange.lowerBound(low, gt)
                      : IDBKeyRange.bound(low, high, gt, lt);
};

function callMigrationHooks(data, migrations, newV, curV) {
  while(curV++ < newV)
    if (typeof migrations[curV] === 'function')
      migrations[curV](data.db, data.e);
}

var handleMigrations = function(version, storeDeclaration, migrationHooks, e) {
  var req = e.target;
  var db = req.result;
  var existingStores = db.objectStoreNames;
  var metaStore;
  if (existingStores.contains('sdbMetaData')) {
    metaStore = req.transaction.objectStore('sdbMetaData');
  } else {
    metaStore = db.createObjectStore('sdbMetaData', {keyPath: 'key'});
    metaStore.put({key: 'meta', clientId: undefined});
  }
  eachKeyVal(storeDeclaration, function(storeName, indexes) {
    var store;
    if (existingStores.contains(storeName)) {
      store = req.transaction.objectStore(storeName);
    } else {
      store = db.createObjectStore(storeName, {keyPath: 'key'});
      metaStore.put({ key: storeName + 'Meta', syncedTo: -1});
    }
    indexes.forEach(function(index) {
      if (!store.indexNames.contains(index[0]))
        store.createIndex.apply(store, index);
    });
  });
  if (migrationHooks)
    callMigrationHooks({db: db, e: e}, migrationHooks, version, e.oldVersion);
};

var SDBDatabase = function(name, version, storeDecs, migrations) {
  var db = this;
  db.name = name;
  db.remote = '';
  db.version = version;
  db.recordsToSync = new Countdown();
  db.recordsLeft = new Countdown();
  db.stores = {};
  var stores = {};
  eachKeyVal(storeDecs, function(storeName, indexes) {
    stores[storeName] = indexes.concat([['changedSinceSync', 'changedSinceSync']]);
  });
  // Create stores on db object
  eachKeyVal(stores, function(storeName, indexes) {
    var indexNames = indexes.map(function(idx) { return idx[0]; });
    var storeObj = new SDBObjectStore(db, storeName, indexNames);
    db.stores[storeName] = storeObj;
    // Make stores available directly as properties on the db
    // Store shortcut should not override db properties
    db[storeName] = db[storeName] || storeObj;
  });
  db.sdbMetaData = new SDBObjectStore(db, 'sdbMetaData', []);
  this.promise = new Promise(function(resolve, reject) {
    var req = indexedDB.open(name, version);
    req.onupgradeneeded = handleMigrations.bind(null, version, stores, migrations);
    req.onsuccess = function(e) {
      db.db = req.result;
      db.db.onversionchange = handleVersionChange;
      resolve({db: db, e: e});
    };
  });
  return db;
};

SDBDatabase.prototype.then = function(fn) {
  return this.promise.then(fn);
};
SDBDatabase.prototype.catch = function(fn) {
  return this.promise.catch(fn);
};

SDBDatabase.prototype.transaction = function(storeNames, mode, fn) {
  storeNames = [].concat(storeNames);
  mode = mode === 'r'    ? 'readonly'
       : mode === 'read' ? 'readwrite'
       : mode === 'rw'   ? 'readwrite'
                         : mode;
  var db = this;
  return db.then(function(res) {
    return new Promise(function(resolve, reject) {
      var tx = db.db.transaction(storeNames, mode);
      var stores = storeNames.map(function(s) {
        return (new SDBObjectStore(db, s, db[s].indexes, tx));
      });
      tx.oncomplete = function() {
        resolve();
      };
      fn.apply(null, stores);
    });
  });
};

SDBDatabase.prototype.read = function() {
  var args = toArray(arguments);
  return this.transaction(args.slice(0, -1), 'read', args.slice(-1)[0]);
};

var forEachRecordChangedSinceSync = function(db, storeNames, fn) {
  db.transaction(storeNames, 'r', function() {
    var stores = toArray(arguments);
    stores.forEach(function(store) {
      var boundFn = fn.bind(null, store.name);
      store.changedSinceSync.get(1)
      .then(function(records) {
        records.forEach(boundFn);
      });
    });
  });
};

var createMsg = function(storeName, clientId, record) {
  return JSON.stringify({
    type: 'create',
    storeName: storeName,
    clientId: clientId,
    record: record,
  });
};

function handleRemoteOk(db, msg) {
  return db.transaction(msg.storeName, 'rw', function(store) {
    store.get(msg.key).then(function(record) {
      record.changedSinceSync = 0;
      record.version = msg.newVersion;
      putValToStore(store, record);
    });
  });
}

function syncToRemote(db, ws, storeNames) {
  return new Promise(function(resolve, reject) {
    db.recordsToSync.onZero = resolve;
    getClientId(db, ws).then(function(clientId) {
      ws.on('message', function(msg) {
        handleIncomingMessage(db, ws, msg);
      });
      forEachRecordChangedSinceSync(db, storeNames, function(storeName, record) {
        db.recordsToSync.add(1);
        ws.send(createMsg(storeName, clientId, record));
      });
    });
  });
};

SDBDatabase.prototype.pushToRemote = function(/* storeNames */) {
  var db = this;
  var storeNames = arguments.length ? toArray(arguments) : Object.keys(db.stores);
  var ws = new WrappedSocket('ws://' + db.remote);
  return new Promise(function(resolve, reject) {
    ws.on('open', function () {
      syncToRemote(db, ws, storeNames).then(function() {
        console.log('done syncing');
        resolve();
      });
    });
  });
};

function updateStoreSyncedTo(metaStore, storeName, time) {
  metaStore.get(storeName + 'Meta')
  .then(function(storeMeta) {
    storeMeta.syncedTo = time;
    putValToStore(metaStore, storeMeta, true);
  });
}

function getClientId(db, ws) {
  if (db.clientId) {
    return Promise.resolve(db.clientId);
  } else {
    return db.sdbMetaData.get('meta')
    .then(function(meta) {
      if (meta.clientId) {
        db.clientId = meta.clientId;
        return meta.clientId;
      } else {
        meta.clientId = Math.random().toString(36); // FIXME
        return db.transaction('sdbMetaData', 'rw', function(sdbMetaData) {
          putValToStore(sdbMetaData, meta, true);
        }).then(function() {
          db.clientId = meta.clientId;
          return meta.clientId;
        });
      }
    });
  }
}

function requestChangesToStore(db, ws, storeName, clientId) {
  db.sdbMetaData.get(storeName + 'Meta')
  .then(function(storeMeta) {
    ws.send({
      type: 'get-changes',
      storeNames: storeName,
      clientId: clientId,
      since: storeMeta.syncedTo,
    });
  });
}

var handleIncomingMessageByType = {
  'sending-changes': function(db, ws, msg) {
    db.recordsLeft.add(msg.nrOfRecordsToSync);
  },
  'create': function(db, ws, msg) {
    msg.record.changedSinceSync = 0;
    db.transaction([msg.storeName, 'sdbMetaData'], 'rw', function(store, metaStore) {
      addValToStore(store, msg.record)
      .then(function() {
        updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
      });
    }).then(function() {
      db.recordsLeft.add(-1);
    });
  },
  'update': function(db, ws, msg) {
    console.log('update coming in');
    db.transaction([msg.storeName, 'sdbMetaData'], 'rw', function(store, metaStore) {
      store.get(msg.key)
      .then(function(record) {
        dffptch.patch(record, msg.diff); 
        store.put(record)
        .then(function() {
          updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
        });
      });
    }).then(function() {
      db.recordsLeft.add(-1);
    });
  },
  'ok': function(db, ws, msg) {
    handleRemoteOk(db, msg).then(function() {
      db.recordsToSync.add(-1);
    });
  },
};

function handleIncomingMessage(db, ws, msg) {
  handleIncomingMessageByType[msg.type](db, ws, msg);
}

SDBDatabase.prototype.pullFromRemote = function() {
  var db = this;
  var storeNames = arguments.length ? toArray(arguments) : Object.keys(db.stores);
  return db.then(function() {
    return getClientId(db);
  }).then(function(clientId) {
    db.syncing = true;
    return new Promise(function(resolve, reject) {
      var ws = new WrappedSocket('ws://' + db.remote);
      db.recordsLeft.onZero = resolve;
      ws.on('open', function() {
        storeNames.map(function(storeName) {
          requestChangesToStore(db, ws, storeName, clientId);
        });
      });
      ws.on('message', function(msg) {
        handleIncomingMessage(db, ws, msg);
      });
    });
  });
};

exports.open = function(name, version, stores, migrations) {
  return new SDBDatabase(name, version, stores, migrations);
};

return exports;
}));
