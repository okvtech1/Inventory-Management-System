// Wraps the real Code.gs (unmodified) in a mocked Apps Script runtime, same
// technique as apps-script/test_mock.js, but exposes it as an actual local
// HTTP server so a real browser (Playwright) can fetch() it exactly like the
// front-end does against the real deployed Apps Script web app.
//
// Multi-tenant note: this mock simulates SEPARATE spreadsheets the same way
// the real Google environment does — SpreadsheetApp.create() makes a new
// isolated sheet namespace with its own id, and openById(id) resolves back
// to it. That mirrors Code.gs's per-tenant-spreadsheet design (Master +
// one spreadsheet per org) so local testing exercises the same code paths
// as production.

const http = require('http');
const vm = require('vm');
const fs = require('fs');

class MockSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getRange(r1, c1, numRows, numCols) {
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const row = self.rows[r1 - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) line.push(row[c1 - 1 + j] !== undefined ? row[c1 - 1 + j] : '');
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          const rIdx = r1 - 1 + i;
          while (self.rows.length <= rIdx) self.rows.push([]);
          const row = self.rows[rIdx];
          for (let j = 0; j < vals[i].length; j++) row[c1 - 1 + j] = vals[i][j];
        }
      },
    };
  }
  appendRow(arr) { this.rows.push(arr.slice()); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  getDataRange() {
    const numRows = this.rows.length;
    const numCols = this.rows.reduce((m, r) => Math.max(m, r.length), 0);
    return { getNumRows: () => numRows, getNumColumns: () => numCols };
  }
}

class MockSpreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheetMap = {}; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://mock-sheets.local/' + this.id; }
  getSheetByName(name) { return this.sheetMap[name] || null; }
  insertSheet(name) { const s = new MockSheet(name); this.sheetMap[name] = s; return s; }
  getSheets() { return Object.values(this.sheetMap); }
  deleteSheet(sheet) { delete this.sheetMap[sheet.name]; }
}

const allSpreadsheets = {}; // id -> MockSpreadsheet
let ssIdCounter = 0;
const SpreadsheetApp = {
  create(name) {
    ssIdCounter++;
    const id = 'mockss-' + ssIdCounter;
    const ss = new MockSpreadsheet(id, name);
    allSpreadsheets[id] = ss;
    return ss;
  },
  openById(id) {
    const ss = allSpreadsheets[id];
    if (!ss) throw new Error('Mock spreadsheet not found: ' + id);
    return ss;
  },
};

let uuidCounter = 0;
const Utilities = {
  getUuid() {
    uuidCounter++;
    const rand = () => Math.floor(Math.random() * 16).toString(16);
    const seg = (n) => Array.from({length: n}, rand).join('');
    return `${seg(8)}-${seg(4)}-${seg(4)}-${seg(4)}-${uuidCounter.toString(16).padStart(4,'0')}${seg(8)}`;
  },
  base64Decode(s) { return Buffer.from(s, 'base64'); },
  newBlob(bytes, mimeType, name) { return { bytes, mimeType, name }; },
  computeDigest(algo, text) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(text, 'utf8').digest();
    return Array.from(hash).map(b => b > 127 ? b - 256 : b); // signed bytes, like Apps Script
  },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
};
const ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput(text) { return { _text: text, setMimeType() { return this; } }; },
};
const sentEmails = [];
const MailApp = { sendEmail(opts) { sentEmails.push(opts); console.log('[mock email]', opts.to, '-', opts.subject); } };
const Logger = { log(...a) { console.log('[Logger]', ...a); } };
// Payment-proof uploads and SMS/WhatsApp gateways aren't exercised by the
// local mock — these stand in so submitSubscriptionRequest_/sendOneMessage_
// don't throw when the real Drive/Fetch services aren't available locally.
const savedFiles = [];
const DriveApp = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' },
  getFoldersByName() { return { hasNext: () => false }; },
  createFolder(name) { return { createFile: (blob) => { const f = { blob, url: 'https://mock-drive.local/' + Utilities.getUuid(), setSharing() {} }; savedFiles.push(f); f.getUrl = () => f.url; return f; } }; },
};
const UrlFetchApp = { fetch() { return { getResponseCode: () => 200 }; } };

// Persistent (for the life of this process) Script Properties — needed so
// MASTER_SPREADSHEET_ID set by initMaster() sticks around for later calls.
const scriptProps = {};
const PropertiesService = {
  getScriptProperties() {
    return {
      getProperty(k) { return scriptProps[k] !== undefined ? scriptProps[k] : null; },
      setProperty(k, v) { scriptProps[k] = v; },
    };
  },
};
const ScriptApp = {
  getProjectTriggers() { return []; },
  newTrigger() {
    return {
      forSpreadsheet() { return { onEdit() { return { create() {} }; } }; },
      timeBased() { return { everyDays() { return { atHour() { return { create() {} }; } }; } }; },
    };
  },
  deleteTrigger() {},
};

// Simple in-memory CacheService (ignores expiry — fine for a short-lived local run).
const cacheStore = {};
const CacheService = {
  getScriptCache() {
    return {
      get(k) { return cacheStore[k] !== undefined ? cacheStore[k] : null; },
      put(k, v) { cacheStore[k] = v; },
      remove(k) { delete cacheStore[k]; },
    };
  },
};

const code = fs.readFileSync(__dirname + '/apps-script/Code.gs', 'utf8');
const context = {
  SpreadsheetApp, Utilities, ContentService, MailApp, Logger,
  DriveApp, UrlFetchApp, PropertiesService, ScriptApp, CacheService,
  console, process, JSON, Date, Math, String, Array, Object, Number, Boolean,
};
vm.createContext(context);
vm.runInContext(code, context, { filename: 'Code.gs' });
vm.runInContext('this.__exports = { doPost, initMaster, installTriggers };', context);
const codeExports = context.__exports;
codeExports.initMaster();
codeExports.installTriggers();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  // Test-only introspection endpoint — lets e2e_test.js (a separate Node
  // process from this server) read the live in-memory "sheet" contents over
  // HTTP, since a plain require() from another process can't see this
  // process's memory. Never shipped/used by the real front-end. Now reports
  // every mock spreadsheet (Master + each tenant), keyed by its mock id.
  if (req.method === 'GET' && req.url === '/_debug/sheets') {
    const plain = {};
    Object.keys(allSpreadsheets).forEach(id => {
      const ss = allSpreadsheets[id];
      const sheetsPlain = {};
      Object.keys(ss.sheetMap).forEach(name => { sheetsPlain[name] = ss.sheetMap[name].rows; });
      plain[id] = { name: ss.name, sheets: sheetsPlain };
    });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ spreadsheets: plain, masterSpreadsheetId: scriptProps.MASTER_SPREADSHEET_ID, sentEmails }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const result = codeExports.doPost({ postData: { contents: body } });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(result._text);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
});

const PORT = process.argv[2] || 8950;
server.listen(PORT, () => console.log('Mock Apps Script API server listening on', PORT));

module.exports = { allSpreadsheets, sentEmails, scriptProps };
