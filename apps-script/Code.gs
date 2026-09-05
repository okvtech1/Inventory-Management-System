/**
 * OKV Inventory Management System — Online Edition
 * Apps Script backend (Code.gs) — Multi-Tenant Architecture
 *
 * ARCHITECTURE
 * ------------
 * This is a STANDALONE script (not bound to any one spreadsheet). It manages:
 *
 *   1. ONE small MASTER spreadsheet (id in Script Properties as
 *      MASTER_SPREADSHEET_ID), holding only non-transactional oversight data:
 *        - TenantRegistry   : one row per org (contact, plan, subscription
 *                              dates, spreadsheetId, capacity-monitoring fields)
 *        - UserIndex        : one row per login (auth only: username,
 *                              passwordHash, session/reset tokens, status)
 *        - SubscriptionRequests : upgrade payment submissions, reviewed here
 *        - SuperAdmins      : OKV's own login(s), system-wide
 *        - CapacityHistory  : periodic cell-usage snapshots per org (for
 *                              growth-rate estimation)
 *        - SystemConfig     : key/value store the Super Admin dashboard edits
 *                              (contact info, bank/payment gateways, branding,
 *                              pricing/plans, reminder cadence)
 *        - SuperAdminMessages : log of announcements the Super Admin sends
 *                                to org Admins
 *
 *   2. ONE dedicated spreadsheet PER TENANT (org), created automatically at
 *      signup, holding only that org's transactional data:
 *        - Users        : full profile per login (no auth secrets — those
 *                          live in Master's UserIndex only)
 *        - Data         : products, sales, stock, etc. (entityType-tagged)
 *        - Messages     : Communications-tab sends to that org's customers
 *        - ChatMessages : Team Chat between that org's Admin and staff
 *
 * Every function resolves the correct spreadsheet dynamically — via
 * getMaster_() for Master, or getOrgSpreadsheet_(orgId) for a tenant — never
 * a hardcoded/active-spreadsheet reference. getOrgSpreadsheet_ caches the
 * orgId -> spreadsheetId lookup for 6 hours (CacheService) to keep repeat
 * calls fast without re-scanning TenantRegistry every time.
 *
 * ONE-TIME SETUP (see README.md Section 3 for the full walkthrough):
 *   1. Run initMaster()      — creates the Master spreadsheet + seeds it
 *   2. Run installTriggers() — installs the onEdit (subscription approvals)
 *                              and time-based (capacity checks, reminders)
 *                              triggers
 *   3. Deploy as a Web App (Execute as: Me, Access: Anyone)
 *
 * MIGRATION from the old single-spreadsheet build: run migrateToMultiTenant_()
 * once, pointing OLD_SPREADSHEET_ID at that original container-bound sheet —
 * see the function below for details.
 */

/* =========================================================
   SHEET NAMES & HEADERS
   ========================================================= */
// --- Master spreadsheet ---
const MASTER_TENANT_REGISTRY = 'TenantRegistry';
const MASTER_USER_INDEX = 'UserIndex';
const MASTER_SUBS = 'SubscriptionRequests';
const MASTER_SUPER_ADMINS = 'SuperAdmins';
const MASTER_CAPACITY_HISTORY = 'CapacityHistory';
const MASTER_SYSTEM_CONFIG = 'SystemConfig';
const MASTER_SUPER_MESSAGES = 'SuperAdminMessages';

const TENANT_REGISTRY_HEADERS = [
  'orgId', 'orgName', 'adminFullName', 'adminEmail', 'adminPhone', 'spreadsheetId',
  'plan', 'billingCycle', 'subscriptionStatus', 'subscriptionExpiry', 'trialStartedAt',
  'orgStatus', 'createdAt',
  'cellUsageCount', 'cellUsagePercent', 'cellGrowthPerDayEstimate', 'estDaysToCapacity90',
  'capacityStatus', 'capacityRecommendation', 'capacityCheckedAt',
  'lastReminderSentAt', 'archiveSpreadsheetId',
];
const USER_INDEX_HEADERS = [
  'userId', 'orgId', 'username', 'passwordHash', 'accountType', 'status',
  'sessionToken', 'sessionExpiry', 'resetToken', 'resetTokenExpiry',
];
const SUBS_HEADERS = [
  'reqId', 'orgId', 'orgName', 'submittedByUserId', 'fullName', 'email', 'phone',
  'plan', 'billingCycle', 'paymentScreenshotUrl', 'status', 'adminNote',
  'submittedAt', 'decidedAt', 'newExpiry',
];
const SUPER_ADMIN_HEADERS = [
  'superAdminId', 'username', 'passwordHash', 'fullName', 'status',
  'sessionToken', 'sessionExpiry', 'resetToken', 'resetTokenExpiry', 'createdAt',
];
const CAPACITY_HISTORY_HEADERS = ['orgId', 'checkedAt', 'cellUsageCount'];
const SYSTEM_CONFIG_HEADERS = ['key', 'value'];
const SUPER_MSG_HEADERS = [
  'msgId', 'sentBySuperAdminId', 'sentByName', 'msgType', 'audience',
  'recipientOrgId', 'recipientName', 'channel', 'destination', 'subject', 'body',
  'status', 'statusDetail', 'sentAt',
];

// --- Per-tenant spreadsheet ---
const USERS_SHEET = 'Users';
const DATA_SHEET = 'Data';
const MESSAGES_SHEET = 'Messages';
const CHAT_SHEET = 'ChatMessages';

const USERS_HEADERS = [
  'userId', 'orgId', 'orgName', 'fullName', 'email', 'phone', 'accountType',
  'roles', 'createdAt', 'lastLoginAt',
];
const DATA_HEADERS = [
  'orgId', 'entityType', 'recordId', 'payload', 'updatedAt', 'updatedBy', 'deleted',
];
const MESSAGES_HEADERS = [
  'msgId', 'orgId', 'sentByUserId', 'sentByName', 'msgType', 'audience',
  'recipientId', 'recipientName', 'channel', 'destination', 'subject', 'body',
  'status', 'statusDetail', 'sentAt',
];
const CHAT_HEADERS = [
  'chatId', 'orgId', 'fromUserId', 'fromName', 'toUserId', 'toName', 'message', 'createdAt',
];

const SESSION_DAYS = 7;
const RESET_TOKEN_MINUTES = 60;
const TRIAL_DAYS = 7;
const CELL_LIMIT = 10000000; // Google Sheets' hard per-file cell limit
const CAPACITY_ACTION_THRESHOLD = 0.85;
const CAPACITY_MONITOR_THRESHOLD = 0.70;
const ORG_CACHE_SECONDS = 6 * 60 * 60; // 6 hours

// Default Super Admin login, seeded once by initMaster(). Change the password
// from the Super Admin Dashboard (Settings -> My Account) after first login.
const DEFAULT_SUPER_ADMIN_USERNAME = 'technologyokv@gmail.com';
const DEFAULT_SUPER_ADMIN_PASSWORD = 'OKVIMS557'; // "the system name" (OKV IMS) + 557

/* =========================================================
   OKV Technology Consults — fallback company/payment info. Anything
   the Super Admin sets via SystemConfig (Dashboard -> Settings)
   overrides these; these are only used before that first save.
   ========================================================= */
const OKV_CONTACT_DEFAULT = {
  email: 'technologyokv@gmail.com',
  phone: '+2348104141138',
  whatsapp: '+2348104141138',
  website: 'https://www.okvtechnology.com',
};
const OKV_BANK_DEFAULT = {
  bankName: 'OPA MFB',
  accountNumber: '8104141138',
  accountName: 'OLASILE KEHINDE VICTOR',
};
const DEFAULT_PLANS = [
  { id: 'Starter', name: 'Starter', monthlyPrice: 5000, biannualPrice: 27000, yearlyPrice: 48000,
    features: ['Core inventory & POS', 'Up to 3 team members', 'Email support'] },
  { id: 'Growth', name: 'Growth', monthlyPrice: 12000, biannualPrice: 65000, yearlyPrice: 115000,
    features: ['Everything in Starter', 'Unlimited team members', 'Reports & analytics', 'Priority support'] },
];
const PAYMENT_PROOF_FOLDER = 'OKV IMS Payment Proofs';
const BILLING_CYCLE_DAYS = { 'Monthly': 30, 'Bi-Annually': 182, 'Yearly': 365 };
// Send a trial/subscription reminder at most this often (twice a month).
const REMINDER_MIN_GAP_DAYS = 14;
// Start reminding once a subscription/trial is within this many days of expiry
// (also covers "just expired" since a negative days-left still passes <=).
const REMINDER_WINDOW_DAYS = 14;

function emailFooter_() {
  const c = getContactConfig_();
  return '<hr style="border:none;border-top:1px solid #ddd;margin:18px 0 10px;">' +
    '<p style="font-size:12.5px;color:#555;">— OKV Technology Consults<br>' +
    'Email: ' + c.email + ' &nbsp;|&nbsp; Phone/WhatsApp: ' + c.phone + '<br>' +
    'Website: <a href="' + c.website + '">' + c.website + '</a></p>';
}
/* Every email OKV Technology Consults itself sends (signup welcome, password
   reset, subscription confirm/reject/alerts, capacity alerts, trial
   reminders) sets name: 'OKV Inventory Management System' so it arrives as
   "OKV Inventory Management System <technologyokv@gmail.com>" — the display
   name always carries the product name, the address is always the OKV
   account. This is deliberately NOT applied in sendOneMessage_ below, which
   is the Message Members feature a System User uses to email their own
   customers/suppliers/team — that email should read as coming from their
   organisation, not from OKV. */

/* =========================================================
   ONE-TIME SETUP
   ========================================================= */
function initMaster() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty('MASTER_SPREADSHEET_ID');
  let ss;
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('OKV IMS — Master Control');
    ssId = ss.getId();
    props.setProperty('MASTER_SPREADSHEET_ID', ssId);
  }
  ensureSheet_(ss, MASTER_TENANT_REGISTRY, TENANT_REGISTRY_HEADERS);
  ensureSheet_(ss, MASTER_USER_INDEX, USER_INDEX_HEADERS);
  ensureSheet_(ss, MASTER_SUBS, SUBS_HEADERS);
  ensureSheet_(ss, MASTER_SUPER_ADMINS, SUPER_ADMIN_HEADERS);
  ensureSheet_(ss, MASTER_CAPACITY_HISTORY, CAPACITY_HISTORY_HEADERS);
  ensureSheet_(ss, MASTER_SYSTEM_CONFIG, SYSTEM_CONFIG_HEADERS);
  ensureSheet_(ss, MASTER_SUPER_MESSAGES, SUPER_MSG_HEADERS);

  // Remove the default blank "Sheet1" Google adds to every new spreadsheet.
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  seedDefaultSystemConfig_(ss);
  seedDefaultSuperAdmin_(ss);

  Logger.log('Master spreadsheet ready: ' + ss.getUrl());
  return ss.getUrl();
}

function seedDefaultSystemConfig_(ss) {
  const sheet = ss.getSheetByName(MASTER_SYSTEM_CONFIG);
  const existing = readRows_(sheet, SYSTEM_CONFIG_HEADERS);
  const has = k => existing.some(r => r.key === k);
  const seed = (k, v) => { if (!has(k)) appendRow_(sheet, SYSTEM_CONFIG_HEADERS, { key: k, value: JSON.stringify(v) }); };
  seed('contact', OKV_CONTACT_DEFAULT);
  seed('bankAccounts', [Object.assign({ enabled: true }, OKV_BANK_DEFAULT)]);
  seed('branding', { primaryColor: '#1F3D2B', goldColor: '#C9A24B', creamColor: '#F6F1E7', logoUrl: '' });
  seed('plans', DEFAULT_PLANS);
  seed('gateways', {
    paystack: { enabled: false, publicKey: '', secretKey: '' },
    remita: { enabled: false, merchantId: '', apiKey: '', serviceTypeId: '' },
    flutterwave: { enabled: false, publicKey: '', secretKey: '' },
  });
  seed('reminders', { windowDays: REMINDER_WINDOW_DAYS, minGapDays: REMINDER_MIN_GAP_DAYS });
}

function seedDefaultSuperAdmin_(ss) {
  const sheet = ss.getSheetByName(MASTER_SUPER_ADMINS);
  const existing = readRows_(sheet, SUPER_ADMIN_HEADERS);
  if (existing.length) return; // never overwrite — only seed on a truly empty sheet
  appendRow_(sheet, SUPER_ADMIN_HEADERS, {
    superAdminId: newId_('SA'), username: DEFAULT_SUPER_ADMIN_USERNAME,
    passwordHash: sha256Hex_(DEFAULT_SUPER_ADMIN_PASSWORD), fullName: 'OKV Technology Consults',
    status: 'Active', sessionToken: '', sessionExpiry: '', resetToken: '', resetTokenExpiry: '',
    createdAt: nowIso_(),
  });
  Logger.log('Seeded default Super Admin login: ' + DEFAULT_SUPER_ADMIN_USERNAME + ' / ' + DEFAULT_SUPER_ADMIN_PASSWORD + ' — change this after first login.');
}

/* Run once (after initMaster). Installs:
   - onEdit on Master's SubscriptionRequests (type Confirmed/Rejected to
     approve an upgrade — see handleSubscriptionEdit_)
   - a daily time-based trigger for cell-capacity monitoring
   - a daily time-based trigger for trial/subscription reminder emails
     (the reminder function itself enforces the twice-a-month cadence) */
function installTriggers() {
  const master = getMaster_();
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'handleSubscriptionEdit_' || fn === 'checkAllTenantsCapacity_' || fn === 'sendTrialReminders_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('handleSubscriptionEdit_').forSpreadsheet(master).onEdit().create();
  ScriptApp.newTrigger('checkAllTenantsCapacity_').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('sendTrialReminders_').timeBased().everyDays(1).atHour(8).create();
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (existing.join('') !== headers.join('')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

/* =========================================================
   Web app entry points
   ========================================================= */
function doGet(e) {
  return json_({ ok: true, message: 'OKV IMS API is running. Use POST for all actions.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ success: false, error: 'Invalid request body.' });
  }
  const action = body.action;
  try {
    switch (action) {
      // --- Auth (org users) ---
      case 'signup': return signup_(body);
      case 'login': return login_(body);
      case 'logout': return logout_(body);
      case 'forgotPassword': return forgotPassword_(body);
      case 'resetPassword': return resetPassword_(body);
      case 'changePassword': return changePassword_(body);
      case 'whoAmI': return whoAmI_(body);
      // --- Team & Access ---
      case 'listUsers': return listUsers_(body);
      case 'createUser': return createUser_(body);
      case 'editUserRoles': return editUserRoles_(body);
      case 'editUser': return editUser_(body);
      case 'setUserPassword': return setUserPassword_(body);
      case 'setUserStatus': return setUserStatus_(body);
      case 'deleteUser': return deleteUser_(body);
      // --- Data sync ---
      case 'pullData': return pullData_(body);
      case 'pushData': return pushData_(body);
      // --- Communications / Team Chat ---
      case 'sendMemberMessage': return sendMemberMessage_(body);
      case 'listMessages': return listMessages_(body);
      case 'sendChatMessage': return sendChatMessage_(body);
      case 'listChatMessages': return listChatMessages_(body);
      // --- Upgrade & Subscription ---
      case 'submitSubscriptionRequest': return submitSubscriptionRequest_(body);
      case 'listSubscriptionRequests': return listSubscriptionRequests_(body);
      // --- Public config (no auth — safe subset, used by login/signup/pricing pages) ---
      case 'getPublicConfig': return getPublicConfig_(body);
      // --- Super Admin ---
      case 'superAdminLogin': return superAdminLogin_(body);
      case 'superAdminLogout': return superAdminLogout_(body);
      case 'superAdminWhoAmI': return superAdminWhoAmI_(body);
      case 'superAdminChangePassword': return superAdminChangePassword_(body);
      case 'listTenants': return listTenants_(body);
      case 'getTenant': return getTenant_(body);
      case 'updateTenant': return updateTenant_(body);
      case 'setTenantStatus': return setTenantStatus_(body);
      case 'getCapacityDashboard': return getCapacityDashboard_(body);
      case 'runCapacityCheckNow': return runCapacityCheckNow_(body);
      case 'archiveOldRecords': return archiveOldRecords_(body);
      case 'sendSuperAdminMessage': return sendSuperAdminMessage_(body);
      case 'listSuperAdminMessages': return listSuperAdminMessages_(body);
      case 'getSystemConfig': return getSystemConfig_(body);
      case 'updateSystemConfig': return updateSystemConfig_(body);
      default: return json_({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json_({ success: false, error: 'Server error: ' + err.message });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
   Core helpers
   ========================================================= */
function readRows_(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map((row, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, idx) => obj[h] = row[idx]);
    return obj;
  });
}
function writeRow_(sheet, headers, rowIndex, obj) {
  const row = headers.map(h => obj[h] !== undefined ? obj[h] : '');
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
}
function appendRow_(sheet, headers, obj) {
  const row = headers.map(h => obj[h] !== undefined ? obj[h] : '');
  sheet.appendRow(row);
}
function newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
}
function nowIso_() { return new Date().toISOString(); }
function addDays_(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMinutes_(date, mins) { const d = new Date(date); d.setMinutes(d.getMinutes() + mins); return d; }
function daysBetween_(a, b) { return (new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24); }
function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/* =========================================================
   MASTER spreadsheet resolution
   ========================================================= */
function getMaster_() {
  const ssId = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
  if (!ssId) throw new Error('Master spreadsheet not set up yet — run initMaster() once from the Apps Script editor.');
  return SpreadsheetApp.openById(ssId);
}
function masterSheet_(name) { return getMaster_().getSheetByName(name); }

/* Resolves a tenant's spreadsheet dynamically from TenantRegistry — never a
   hardcoded reference. Cached for ORG_CACHE_SECONDS so repeat calls in the
   same short window don't re-scan the registry every time. */
function getOrgSpreadsheet_(orgId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ssid_' + orgId;
  let ssId = cache.get(cacheKey);
  if (!ssId) {
    const rows = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS);
    const tenant = rows.find(t => t.orgId === orgId);
    if (!tenant) throw new Error('Unknown organisation.');
    ssId = tenant.spreadsheetId;
    cache.put(cacheKey, ssId, ORG_CACHE_SECONDS);
  }
  return SpreadsheetApp.openById(ssId);
}
function invalidateOrgCache_(orgId) { CacheService.getScriptCache().remove('ssid_' + orgId); }

function createTenantSpreadsheet_(orgName) {
  const ss = SpreadsheetApp.create('OKV IMS — ' + orgName);
  ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  ensureSheet_(ss, DATA_SHEET, DATA_HEADERS);
  ensureSheet_(ss, MESSAGES_SHEET, MESSAGES_HEADERS);
  ensureSheet_(ss, CHAT_SHEET, CHAT_HEADERS);
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
  return ss;
}

/* Tenant-side sheet getters — always take the tenant's own Spreadsheet
   object (resolved via getOrgSpreadsheet_), never a global/active one. */
function usersSheet_(ss) { return ss.getSheetByName(USERS_SHEET); }
function dataSheet_(ss) { return ss.getSheetByName(DATA_SHEET); }
function messagesSheet_(ss) { return ss.getSheetByName(MESSAGES_SHEET); }
function chatSheet_(ss) { return ss.getSheetByName(CHAT_SHEET); }

/* =========================================================
   SystemConfig — Super Admin-editable key/value store
   ========================================================= */
function getConfigValue_(key, fallback) {
  const rows = readRows_(masterSheet_(MASTER_SYSTEM_CONFIG), SYSTEM_CONFIG_HEADERS);
  const row = rows.find(r => r.key === key);
  if (!row || !row.value) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}
function setConfigValue_(key, value) {
  const sheet = masterSheet_(MASTER_SYSTEM_CONFIG);
  const rows = readRows_(sheet, SYSTEM_CONFIG_HEADERS);
  const row = rows.find(r => r.key === key);
  const obj = { key, value: JSON.stringify(value) };
  if (row) writeRow_(sheet, SYSTEM_CONFIG_HEADERS, row._row, obj);
  else appendRow_(sheet, SYSTEM_CONFIG_HEADERS, obj);
}
function getContactConfig_() { return getConfigValue_('contact', OKV_CONTACT_DEFAULT); }
function getBankAccounts_() { return getConfigValue_('bankAccounts', [Object.assign({ enabled: true }, OKV_BANK_DEFAULT)]); }
function getBrandingConfig_() { return getConfigValue_('branding', { primaryColor: '#1F3D2B', goldColor: '#C9A24B', creamColor: '#F6F1E7', logoUrl: '' }); }
function getPlansConfig_() { return getConfigValue_('plans', DEFAULT_PLANS); }
function getGatewaysConfig_() { return getConfigValue_('gateways', {}); }
function getRemindersConfig_() { return getConfigValue_('reminders', { windowDays: REMINDER_WINDOW_DAYS, minGapDays: REMINDER_MIN_GAP_DAYS }); }

// Public (unauthenticated) subset — safe to expose to login/signup/pricing pages.
// Never includes secretKey/apiKey fields.
function getPublicConfig_(body) {
  const gw = getGatewaysConfig_();
  const publicGateways = {};
  Object.keys(gw).forEach(k => { publicGateways[k] = { enabled: !!gw[k].enabled, publicKey: gw[k].publicKey || '' }; });
  return json_({
    success: true,
    contact: getContactConfig_(),
    bankAccounts: getBankAccounts_().filter(b => b.enabled !== false),
    branding: getBrandingConfig_(),
    plans: getPlansConfig_(),
    gateways: publicGateways,
  });
}

/* =========================================================
   Session helpers
   ========================================================= */
// Resolves a sessionToken to { user } via Master's UserIndex (fast — no
// tenant spreadsheet opened yet), then fills in profile fields from the
// tenant's own Users sheet and subscription fields from TenantRegistry.
function requireSession_(sessionToken) {
  if (!sessionToken) return { error: 'Not logged in.' };
  const idx = readRows_(masterSheet_(MASTER_USER_INDEX), USER_INDEX_HEADERS);
  const auth = idx.find(r => r.sessionToken === sessionToken);
  if (!auth) return { error: 'Session not found. Please log in again.' };
  if (new Date(auth.sessionExpiry) < new Date()) return { error: 'Session expired. Please log in again.' };
  if (auth.status === 'Suspended') return { error: 'This account has been suspended. Contact your Admin.' };

  const tenantRows = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS);
  const tenant = tenantRows.find(t => t.orgId === auth.orgId);
  if (!tenant) return { error: 'Your organisation could not be found. Contact support.' };
  if (tenant.orgStatus === 'Suspended') return { error: 'Your organisation account has been suspended. Contact OKV Technology Consults.' };

  const ss = getOrgSpreadsheet_(auth.orgId);
  const profileRows = readRows_(usersSheet_(ss), USERS_HEADERS);
  const profile = profileRows.find(u => u.userId === auth.userId);
  if (!profile) return { error: 'Your profile could not be found. Contact your Admin.' };

  return { user: composeUser_(auth, profile, tenant), auth, profile, tenant, ss };
}
function requireAdmin_(sessionToken) {
  const r = requireSession_(sessionToken);
  if (r.error) return r;
  if (r.user.accountType !== 'Admin') return { error: 'Admins only.' };
  return r;
}
function composeUser_(auth, profile, tenant) {
  const daysLeft = tenant.subscriptionExpiry ? daysBetween_(tenant.subscriptionExpiry, nowIso_()) : null;
  return {
    userId: auth.userId, orgId: auth.orgId, orgName: profile.orgName,
    fullName: profile.fullName, email: profile.email, phone: profile.phone,
    username: auth.username, accountType: auth.accountType,
    roles: profile.roles ? String(profile.roles).split(',').filter(Boolean) : [],
    status: auth.status,
    plan: tenant.plan, billingCycle: tenant.billingCycle,
    subscriptionStatus: tenant.subscriptionStatus, subscriptionExpiry: tenant.subscriptionExpiry,
    trialStartedAt: tenant.trialStartedAt,
    subscriptionDaysLeft: daysLeft === null ? null : Math.ceil(daysLeft),
    subscriptionExpired: daysLeft !== null && daysLeft <= 0,
    createdAt: profile.createdAt, lastLoginAt: profile.lastLoginAt,
  };
}

/* =========================================================
   Auth actions (org Admin / staff)
   ========================================================= */
function signup_(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const orgName = String(body.orgName || '').trim();
  const fullName = String(body.fullName || '').trim();
  const phone = String(body.phone || '').trim();
  const passwordHash = String(body.passwordHash || '');
  const plan = String(body.plan || 'Starter');
  const billingCycle = String(body.billingCycle || 'Monthly');
  if (!username || !email || !orgName || !fullName || !passwordHash) {
    return json_({ success: false, error: 'All fields are required.' });
  }

  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  if (idxRows.some(r => String(r.username).toLowerCase() === username)) {
    return json_({ success: false, error: 'That username is already taken.' });
  }

  const now = nowIso_();
  const orgId = newId_('ORG');
  const userId = newId_('USR');
  const sessionToken = Utilities.getUuid();

  const tenantSs = createTenantSpreadsheet_(orgName);
  appendRow_(usersSheet_(tenantSs), USERS_HEADERS, {
    userId, orgId, orgName, fullName, email, phone, accountType: 'Admin',
    roles: '', createdAt: now, lastLoginAt: now,
  });

  appendRow_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS, {
    orgId, orgName, adminFullName: fullName, adminEmail: email, adminPhone: phone,
    spreadsheetId: tenantSs.getId(), plan, billingCycle,
    subscriptionStatus: 'trial', subscriptionExpiry: addDays_(now, TRIAL_DAYS).toISOString(),
    trialStartedAt: now, orgStatus: 'Active', createdAt: now,
    cellUsageCount: 0, cellUsagePercent: 0, cellGrowthPerDayEstimate: 0, estDaysToCapacity90: '',
    capacityStatus: 'Healthy', capacityRecommendation: '', capacityCheckedAt: '',
    lastReminderSentAt: '',
  });

  appendRow_(idxSheet, USER_INDEX_HEADERS, {
    userId, orgId, username, passwordHash, accountType: 'Admin', status: 'Active',
    sessionToken, sessionExpiry: addDays_(now, SESSION_DAYS).toISOString(),
    resetToken: '', resetTokenExpiry: '',
  });

  try {
    MailApp.sendEmail({
      to: email,
      name: 'OKV Inventory Management System',
      subject: 'Welcome to OKV Inventory Management System — your 7-day free trial has started',
      htmlBody:
        '<p>Hi ' + fullName + ',</p>' +
        '<p>Your organisation "<b>' + orgName + '</b>" is set up on the <b>' + plan + ' (' + billingCycle + ')</b> plan, ' +
        'with full access for the next <b>7 days</b>, free — no card required.</p>' +
        '<p><b>Your login username:</b> ' + username + '</p>' +
        '<p>Next step: install the app on your device and log in. Your Admin dashboard will show exactly how many ' +
        'trial days are left and how to upgrade whenever you\'re ready.</p>' +
        emailFooter_(),
    });
  } catch (err) { Logger.log('signup_ welcome email failed: ' + err.message); }

  const r = requireSession_(sessionToken);
  return json_({ success: true, sessionToken, user: r.user });
}

function login_(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const passwordHash = String(body.passwordHash || '');
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const auth = idxRows.find(r => String(r.username).toLowerCase() === username);
  if (!auth || auth.passwordHash !== passwordHash) {
    return json_({ success: false, error: 'Incorrect username/email or password.' });
  }
  if (auth.status === 'Suspended') {
    return json_({ success: false, error: 'This account has been suspended. Contact your Admin.' });
  }
  const tenantRows = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS);
  const tenant = tenantRows.find(t => t.orgId === auth.orgId);
  if (!tenant) return json_({ success: false, error: 'Your organisation could not be found. Contact support.' });
  if (tenant.orgStatus === 'Suspended') {
    return json_({ success: false, error: 'Your organisation account has been suspended. Contact OKV Technology Consults.' });
  }
  // Note: an expired trial/subscription no longer blocks login outright — the
  // Admin still needs to reach the Upgrade & Subscription tab to pay. The
  // frontend restricts a fully-expired org to Dashboard + Upgrade only
  // (based on subscriptionExpired in the returned user object below);
  // non-Admin staff logins are blocked instead, since they can't upgrade.
  const daysLeft = tenant.subscriptionExpiry ? daysBetween_(tenant.subscriptionExpiry, nowIso_()) : null;
  const expired = daysLeft !== null && daysLeft <= 0;
  if (expired && auth.accountType !== 'Admin') {
    const c = getContactConfig_();
    return json_({ success: false, error: 'Your organisation\'s subscription has ended. Ask your Admin to upgrade, or contact OKV Technology Consults — ' + c.email + ' / ' + c.phone + '.' });
  }

  const now = nowIso_();
  const sessionToken = Utilities.getUuid();
  auth.sessionToken = sessionToken;
  auth.sessionExpiry = addDays_(now, SESSION_DAYS).toISOString();
  writeRow_(idxSheet, USER_INDEX_HEADERS, auth._row, auth);

  const ss = getOrgSpreadsheet_(auth.orgId);
  const profileRows = readRows_(usersSheet_(ss), USERS_HEADERS);
  const profile = profileRows.find(u => u.userId === auth.userId);
  if (profile) {
    profile.lastLoginAt = now;
    writeRow_(usersSheet_(ss), USERS_HEADERS, profile._row, profile);
  }
  return json_({ success: true, sessionToken, user: composeUser_(auth, profile, tenant) });
}

function logout_(body) {
  const sheet = masterSheet_(MASTER_USER_INDEX);
  const rows = readRows_(sheet, USER_INDEX_HEADERS);
  const auth = rows.find(r => r.sessionToken === body.sessionToken);
  if (auth) {
    auth.sessionToken = ''; auth.sessionExpiry = '';
    writeRow_(sheet, USER_INDEX_HEADERS, auth._row, auth);
  }
  return json_({ success: true });
}

function whoAmI_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  return json_({ success: true, user: r.user });
}

function forgotPassword_(body) {
  const identifier = String(body.username || '').trim().toLowerCase();
  const resetBaseUrl = String(body.resetBaseUrl || '');
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const auth = idxRows.find(r => String(r.username).toLowerCase() === identifier && r.accountType === 'Admin');
  if (auth) {
    const token = Utilities.getUuid();
    auth.resetToken = token;
    auth.resetTokenExpiry = addMinutes_(nowIso_(), RESET_TOKEN_MINUTES).toISOString();
    writeRow_(idxSheet, USER_INDEX_HEADERS, auth._row, auth);

    const ss = getOrgSpreadsheet_(auth.orgId);
    const profile = readRows_(usersSheet_(ss), USERS_HEADERS).find(u => u.userId === auth.userId);
    const link = (resetBaseUrl || 'https://example.com/reset-password.html') + '?token=' + token;
    try {
      MailApp.sendEmail({
        to: (profile && profile.email) || auth.username,
        name: 'OKV Inventory Management System',
        subject: 'Reset your OKV Inventory Management System password',
        htmlBody:
          '<p>Hi ' + ((profile && profile.fullName) || '') + ',</p>' +
          '<p>Someone requested a password reset for your OKV Inventory Management System account' +
          (profile ? ' (' + profile.orgName + ')' : '') + '.</p>' +
          '<p><a href="' + link + '">Click here to set a new password</a>. This link expires in ' + RESET_TOKEN_MINUTES + ' minutes and can only be used once.</p>' +
          '<p>If you did not request this, you can safely ignore this email.</p>' +
          emailFooter_(),
      });
    } catch (err) { Logger.log('forgotPassword_ email send failed: ' + err.message); }
  }
  return json_({ success: true, message: 'If that email is registered as an Admin, a reset link has been sent.' });
}

function resetPassword_(body) {
  const token = String(body.token || '');
  const newPasswordHash = String(body.newPasswordHash || '');
  if (!token || !newPasswordHash) return json_({ success: false, error: 'Missing token or new password.' });
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const auth = idxRows.find(r => r.resetToken === token);
  if (!auth) return json_({ success: false, error: 'This reset link is invalid. Request a new one.' });
  if (!auth.resetTokenExpiry || new Date(auth.resetTokenExpiry) < new Date()) {
    return json_({ success: false, error: 'This reset link has expired. Request a new one.' });
  }
  auth.passwordHash = newPasswordHash;
  auth.resetToken = ''; auth.resetTokenExpiry = '';
  writeRow_(idxSheet, USER_INDEX_HEADERS, auth._row, auth);
  return json_({ success: true, message: 'Password updated. You can now log in.' });
}

function changePassword_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  if (r.auth.passwordHash !== String(body.oldPasswordHash || '')) {
    return json_({ success: false, error: 'Current password is incorrect.' });
  }
  r.auth.passwordHash = String(body.newPasswordHash || '');
  writeRow_(masterSheet_(MASTER_USER_INDEX), USER_INDEX_HEADERS, r.auth._row, r.auth);
  return json_({ success: true });
}

/* =========================================================
   Admin — Team & Access (org-scoped: Master UserIndex for auth,
   tenant Users sheet for profile)
   ========================================================= */
function publicTeamUser_(auth, profile) {
  return {
    userId: auth.userId, orgId: auth.orgId, username: auth.username,
    accountType: auth.accountType, status: auth.status,
    fullName: profile ? profile.fullName : '', email: profile ? profile.email : '',
    phone: profile ? profile.phone : '', roles: profile && profile.roles ? String(profile.roles).split(',').filter(Boolean) : [],
    createdAt: profile ? profile.createdAt : '', lastLoginAt: profile ? profile.lastLoginAt : '',
  };
}
function listUsers_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const idxRows = readRows_(masterSheet_(MASTER_USER_INDEX), USER_INDEX_HEADERS).filter(u => u.orgId === r.user.orgId);
  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  const users = idxRows.map(auth => publicTeamUser_(auth, profileRows.find(p => p.userId === auth.userId)));
  return json_({ success: true, users });
}
function createUser_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const username = String(body.username || '').trim().toLowerCase();
  const passwordHash = String(body.passwordHash || '');
  const roles = Array.isArray(body.roles) ? body.roles.join(',') : '';
  if (!username || !passwordHash) return json_({ success: false, error: 'Email and password are required.' });

  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  if (idxRows.some(u => String(u.username).toLowerCase() === username)) {
    return json_({ success: false, error: 'That email is already registered.' });
  }
  const now = nowIso_();
  const userId = newId_('USR');
  appendRow_(idxSheet, USER_INDEX_HEADERS, {
    userId, orgId: r.user.orgId, username, passwordHash, accountType: 'User', status: 'Active',
    sessionToken: '', sessionExpiry: '', resetToken: '', resetTokenExpiry: '',
  });
  const profile = {
    userId, orgId: r.user.orgId, orgName: r.user.orgName, fullName: body.fullName || '',
    email: body.email || '', phone: body.phone || '', accountType: 'User', roles,
    createdAt: now, lastLoginAt: '',
  };
  appendRow_(usersSheet_(r.ss), USERS_HEADERS, profile);
  return json_({ success: true, user: publicTeamUser_({ userId, orgId: r.user.orgId, username, accountType: 'User', status: 'Active' }, profile) });
}
function editUserRoles_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  const target = profileRows.find(u => u.userId === body.userId && u.orgId === r.user.orgId);
  if (!target) return json_({ success: false, error: 'User not found in your organisation.' });
  target.roles = Array.isArray(body.roles) ? body.roles.join(',') : '';
  writeRow_(usersSheet_(r.ss), USERS_HEADERS, target._row, target);
  return json_({ success: true });
}
/* Full edit — name/email/phone plus roles in one call, so the "Edit User"
   modal only needs a single round trip. Login email (username) is
   intentionally NOT editable here — it's the login credential and is
   enforced unique across the whole system in the master index, so renaming
   it safely needs its own guarded flow; Admin can still fully replace a
   user's access via Suspend + Delete + re-invite if a login email changes. */
function editUser_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  const target = profileRows.find(u => u.userId === body.userId && u.orgId === r.user.orgId);
  if (!target) return json_({ success: false, error: 'User not found in your organisation.' });
  target.fullName = String(body.fullName || '');
  target.email = String(body.email || '');
  target.phone = String(body.phone || '');
  target.roles = Array.isArray(body.roles) ? body.roles.join(',') : '';
  writeRow_(usersSheet_(r.ss), USERS_HEADERS, target._row, target);
  return json_({ success: true });
}
function setUserPassword_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const target = idxRows.find(u => u.userId === body.userId && u.orgId === r.user.orgId);
  if (!target) return json_({ success: false, error: 'User not found in your organisation.' });
  target.passwordHash = String(body.newPasswordHash || '');
  writeRow_(idxSheet, USER_INDEX_HEADERS, target._row, target);
  return json_({ success: true });
}
function setUserStatus_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const status = body.status === 'Suspended' ? 'Suspended' : 'Active';
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const target = idxRows.find(u => u.userId === body.userId && u.orgId === r.user.orgId);
  if (!target) return json_({ success: false, error: 'User not found in your organisation.' });
  target.status = status;
  if (status === 'Suspended') { target.sessionToken = ''; target.sessionExpiry = ''; }
  writeRow_(idxSheet, USER_INDEX_HEADERS, target._row, target);
  return json_({ success: true });
}
function deleteUser_(body) {
  const r = requireAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const idxSheet = masterSheet_(MASTER_USER_INDEX);
  const idxRows = readRows_(idxSheet, USER_INDEX_HEADERS);
  const target = idxRows.find(u => u.userId === body.userId && u.orgId === r.user.orgId);
  if (!target) return json_({ success: false, error: 'User not found in your organisation.' });
  if (target.accountType === 'Admin') return json_({ success: false, error: "Can't delete the Admin account." });
  idxSheet.deleteRow(target._row);
  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  const profile = profileRows.find(u => u.userId === body.userId);
  if (profile) usersSheet_(r.ss).deleteRow(profile._row);
  return json_({ success: true });
}

/* =========================================================
   Data sync — org-scoped push/pull (tenant spreadsheet)
   ========================================================= */
function pullData_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const since = body.since ? new Date(body.since) : new Date(0);
  const rows = readRows_(dataSheet_(r.ss), DATA_HEADERS);
  const records = rows
    .filter(d => d.orgId === r.user.orgId && new Date(d.updatedAt) > since)
    .map(d => ({
      entityType: d.entityType, recordId: d.recordId,
      payload: d.payload ? JSON.parse(d.payload) : null,
      updatedAt: d.updatedAt, deleted: d.deleted === true || d.deleted === 'TRUE',
    }));
  return json_({ success: true, records, serverTime: nowIso_() });
}
function pushData_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const records = Array.isArray(body.records) ? body.records : [];
  const sheet = dataSheet_(r.ss);
  const rows = readRows_(sheet, DATA_HEADERS);
  const orgId = r.user.orgId;
  let written = 0;
  records.forEach(rec => {
    const existing = rows.find(d => d.orgId === orgId && d.entityType === rec.entityType && d.recordId === rec.recordId);
    const rowObj = {
      orgId, entityType: rec.entityType, recordId: rec.recordId,
      payload: JSON.stringify(rec.payload || {}), updatedAt: rec.updatedAt || nowIso_(),
      updatedBy: r.user.userId, deleted: !!rec.deleted,
    };
    if (existing) {
      if (!existing.updatedAt || new Date(rec.updatedAt) >= new Date(existing.updatedAt)) {
        writeRow_(sheet, DATA_HEADERS, existing._row, rowObj);
        written++;
      }
    } else {
      appendRow_(sheet, DATA_HEADERS, rowObj);
      written++;
    }
  });
  return json_({ success: true, written, serverTime: nowIso_() });
}

/* =========================================================
   COMMUNICATIONS — org Admin/staff messaging their own customers
   (tenant spreadsheet). Email works out of the box (MailApp); SMS/
   WhatsApp need a gateway — see README Section 6.
   ========================================================= */
function sendMemberMessage_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const channels = Array.isArray(body.channels) ? body.channels : [];
  const msgType = String(body.msgType || 'Other');
  const audience = String(body.audience || 'Selected');
  const subject = String(body.subject || 'A message from ' + r.user.orgName);
  if (!recipients.length) return json_({ success: false, error: 'No recipients selected.' });
  if (!channels.length) return json_({ success: false, error: 'Select at least one channel (Email, SMS, or WhatsApp).' });

  const sheet = messagesSheet_(r.ss);
  const results = [];
  recipients.forEach(rec => {
    const personalizedBody = String(rec.body || body.body || '').replace(/\{\{\s*name\s*\}\}/gi, rec.name || 'there');
    channels.forEach(channel => {
      const { status, detail, destination } = sendOneMessage_(channel, rec, subject, personalizedBody, r.user);
      const row = {
        msgId: newId_('MSG'), orgId: r.user.orgId, sentByUserId: r.user.userId, sentByName: r.user.fullName || r.user.username,
        msgType, audience, recipientId: rec.id || '', recipientName: rec.name || '', channel, destination,
        subject, body: personalizedBody, status, statusDetail: detail, sentAt: nowIso_(),
      };
      appendRow_(sheet, MESSAGES_HEADERS, row);
      results.push(row);
    });
  });
  return json_({ success: true, results });
}
function sendOneMessage_(channel, rec, subject, msgBody, sender) {
  try {
    if (channel === 'email') {
      if (!rec.email) return { status: 'failed', detail: 'No email on file.', destination: '' };
      MailApp.sendEmail({
        to: rec.email, subject,
        htmlBody: '<p>' + msgBody.replace(/\n/g, '<br>') + '</p>' +
          '<p style="font-size:12px;color:#888;">Sent by ' + (sender.orgName || '') + ' via OKV Inventory Management System.</p>' +
          emailFooter_(),
      });
      return { status: 'sent', detail: '', destination: rec.email };
    }
    if (channel === 'sms') return sendViaGateway_('SMS', rec.phone, msgBody);
    if (channel === 'whatsapp') return sendViaGateway_('WHATSAPP', rec.phone, msgBody);
    return { status: 'failed', detail: 'Unknown channel.', destination: '' };
  } catch (err) {
    return { status: 'failed', detail: err.message, destination: rec.email || rec.phone || '' };
  }
}
function sendViaGateway_(prefix, to, message) {
  if (!to) return { status: 'failed', detail: 'No phone number on file.', destination: '' };
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty(prefix + '_GATEWAY_URL');
  const apiKey = props.getProperty(prefix + '_API_KEY');
  if (!url) return { status: 'not_configured', detail: prefix + ' gateway not set up yet — see README section 6.', destination: to };
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ to, message, apiKey }),
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return { status: 'sent', detail: '', destination: to };
    return { status: 'failed', detail: prefix + ' gateway returned ' + code, destination: to };
  } catch (err) {
    return { status: 'failed', detail: err.message, destination: to };
  }
}
function listMessages_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const rows = readRows_(messagesSheet_(r.ss), MESSAGES_HEADERS)
    .filter(m => m.orgId === r.user.orgId)
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
    .slice(0, 200)
    .map(m => { delete m._row; return m; });
  return json_({ success: true, messages: rows });
}

/* =========================================================
   TEAM CHAT — per-tenant Admin <-> User messaging
   ========================================================= */
function sendChatMessage_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const message = String(body.message || '').trim();
  if (!message) return json_({ success: false, error: 'Message is empty.' });

  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  let toUserId, toName;
  if (r.user.accountType === 'Admin') {
    const target = profileRows.find(u => u.userId === body.toUserId && u.orgId === r.user.orgId);
    if (!target) return json_({ success: false, error: 'Recipient not found in your organisation.' });
    toUserId = target.userId; toName = target.fullName || target.username || 'Team member';
  } else {
    const admin = profileRows.find(u => u.orgId === r.user.orgId && u.accountType === 'Admin');
    if (!admin) return json_({ success: false, error: 'Your organisation has no Admin account.' });
    toUserId = admin.userId; toName = admin.fullName || 'Admin';
  }
  const row = {
    chatId: newId_('MSG'), orgId: r.user.orgId, fromUserId: r.user.userId,
    fromName: r.user.fullName || r.user.username, toUserId, toName, message, createdAt: nowIso_(),
  };
  appendRow_(chatSheet_(r.ss), CHAT_HEADERS, row);
  return json_({ success: true, message: row });
}
function listChatMessages_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const profileRows = readRows_(usersSheet_(r.ss), USERS_HEADERS);
  let withUserId;
  if (r.user.accountType === 'Admin') {
    withUserId = String(body.withUserId || '');
    if (!withUserId) return json_({ success: false, error: 'Choose a team member to chat with.' });
  } else {
    const admin = profileRows.find(u => u.orgId === r.user.orgId && u.accountType === 'Admin');
    withUserId = admin ? admin.userId : '';
  }
  const all = readRows_(chatSheet_(r.ss), CHAT_HEADERS)
    .filter(c => c.orgId === r.user.orgId &&
      ((c.fromUserId === r.user.userId && c.toUserId === withUserId) ||
       (c.fromUserId === withUserId && c.toUserId === r.user.userId)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-300)
    .map(c => { delete c._row; return c; });
  return json_({ success: true, messages: all });
}

/* =========================================================
   UPGRADE & SUBSCRIPTION — SubscriptionRequests lives in MASTER
   (org-level oversight data, reviewed centrally). Approve/reject by
   typing "Confirmed"/"Rejected" into the Status column — see
   handleSubscriptionEdit_.
   ========================================================= */
function submitSubscriptionRequest_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const plan = String(body.plan || 'Starter');
  const billingCycle = String(body.billingCycle || 'Monthly');
  const fullName = String(body.fullName || r.user.fullName || r.user.username || '').trim();
  const email = String(body.email || r.user.email || '').trim();
  const phone = String(body.phone || r.user.phone || '').trim();
  if (!email) return json_({ success: false, error: 'An email address is required so we can send your confirmation.' });

  let screenshotUrl = '';
  if (body.paymentScreenshotBase64) {
    try { screenshotUrl = savePaymentProof_(body.paymentScreenshotBase64, body.paymentScreenshotName || 'payment-proof', r.user.orgName); }
    catch (err) { Logger.log('savePaymentProof_ failed: ' + err.message); }
  }

  const reqId = newId_('SUB');
  const row = {
    reqId, orgId: r.user.orgId, orgName: r.user.orgName, submittedByUserId: r.user.userId,
    fullName, email, phone, plan, billingCycle, paymentScreenshotUrl: screenshotUrl,
    status: 'Pending', adminNote: '', submittedAt: nowIso_(), decidedAt: '', newExpiry: '',
  };
  appendRow_(masterSheet_(MASTER_SUBS), SUBS_HEADERS, row);

  try {
    const c = getContactConfig_();
    MailApp.sendEmail({
      to: c.email,
      name: 'OKV Inventory Management System',
      subject: 'OKV Inventory Management System — new upgrade payment submitted — ' + r.user.orgName + ' (' + plan + ')',
      htmlBody:
        '<p>A new subscription payment was submitted:</p><ul>' +
        '<li><b>Organisation:</b> ' + r.user.orgName + '</li>' +
        '<li><b>Name:</b> ' + fullName + '</li><li><b>Email:</b> ' + email + '</li><li><b>Phone:</b> ' + phone + '</li>' +
        '<li><b>Plan:</b> ' + plan + ' (' + billingCycle + ')</li>' +
        '<li><b>Payment screenshot:</b> ' + (screenshotUrl ? '<a href="' + screenshotUrl + '">View</a>' : 'Not attached') + '</li>' +
        '<li><b>Request ID:</b> ' + reqId + '</li></ul>' +
        '<p>To approve: open the <b>SubscriptionRequests</b> sheet in the Master spreadsheet and type <b>Confirmed</b> ' +
        '(or <b>Rejected</b>) into this row\'s Status column — the member is emailed and upgraded automatically within moments. ' +
        'You can also do this from the Super Admin Dashboard.</p>' + emailFooter_(),
    });
  } catch (err) { Logger.log('submitSubscriptionRequest_ notify email failed: ' + err.message); }
  return json_({ success: true, request: row });
}
function savePaymentProof_(base64DataUrl, filename, orgName) {
  const match = String(base64DataUrl).match(/^data:(.+);base64,(.*)$/);
  const mimeType = match ? match[1] : 'image/jpeg';
  const data = match ? match[2] : base64DataUrl;
  const blob = Utilities.newBlob(Utilities.base64Decode(data), mimeType, orgName + ' - ' + filename);
  const folders = DriveApp.getFoldersByName(PAYMENT_PROOF_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PAYMENT_PROOF_FOLDER);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}
function listSubscriptionRequests_(body) {
  const r = requireSession_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const rows = readRows_(masterSheet_(MASTER_SUBS), SUBS_HEADERS)
    .filter(s => s.orgId === r.user.orgId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
    .map(s => { delete s._row; return s; });
  return json_({ success: true, requests: rows });
}

/* Installable onEdit trigger on the MASTER spreadsheet (installTriggers()).
   Type "Confirmed"/"Rejected" into SubscriptionRequests' Status column.
   Confirming updates TenantRegistry directly — no more looping tenant
   Users rows, since subscription truth now lives in one place. */
function handleSubscriptionEdit_(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== MASTER_SUBS) return;
    const statusCol = SUBS_HEADERS.indexOf('status') + 1;
    if (e.range.getColumn() !== statusCol || e.range.getRow() < 2) return;

    const rowNum = e.range.getRow();
    const rowValues = sheet.getRange(rowNum, 1, 1, SUBS_HEADERS.length).getValues()[0];
    const reqObj = {}; SUBS_HEADERS.forEach((h, i) => reqObj[h] = rowValues[i]);
    if (reqObj.decidedAt) return;

    const newStatus = String(e.value || '').trim();
    if (newStatus !== 'Confirmed' && newStatus !== 'Rejected') return;
    reqObj.decidedAt = nowIso_();

    if (newStatus === 'Confirmed') {
      applyConfirmedSubscription_(reqObj.orgId, reqObj.plan, reqObj.billingCycle);
      const tenant = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS).find(t => t.orgId === reqObj.orgId);
      reqObj.newExpiry = tenant ? tenant.subscriptionExpiry : '';
      try {
        MailApp.sendEmail({
          to: reqObj.email, name: 'OKV Inventory Management System',
          subject: 'You are upgraded! — OKV Inventory Management System',
          htmlBody:
            '<p>Hi ' + reqObj.fullName + ',</p>' +
            '<p>Your payment was confirmed and <b>' + reqObj.orgName + '</b> is now upgraded to the ' +
            '<b>' + reqObj.plan + ' (' + reqObj.billingCycle + ')</b> plan, active until ' +
            '<b>' + new Date(reqObj.newExpiry).toDateString() + '</b>.</p>' +
            '<p>This shows automatically on your dashboard the next time it syncs (usually within a few minutes) — ' +
            'no need to log out and back in.</p>' + emailFooter_(),
        });
      } catch (err) { Logger.log('confirm email failed: ' + err.message); }
    } else {
      try {
        MailApp.sendEmail({
          to: reqObj.email, name: 'OKV Inventory Management System',
          subject: 'About your OKV IMS upgrade request',
          htmlBody:
            '<p>Hi ' + reqObj.fullName + ',</p>' +
            '<p>We could not confirm your payment for the <b>' + reqObj.plan + ' (' + reqObj.billingCycle + ')</b> plan. ' +
            'Please reply to this email or reach us directly so we can help sort it out.</p>' + emailFooter_(),
        });
      } catch (err) { Logger.log('reject email failed: ' + err.message); }
    }
    writeRow_(sheet, SUBS_HEADERS, rowNum, reqObj);
  } catch (err) {
    Logger.log('handleSubscriptionEdit_ error: ' + err.message);
  }
}
// Shared by the onEdit approval flow above and updateTenant_ (Super Admin
// manually adjusting a plan from the dashboard).
function applyConfirmedSubscription_(orgId, plan, billingCycle) {
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const rows = readRows_(sheet, TENANT_REGISTRY_HEADERS);
  const tenant = rows.find(t => t.orgId === orgId);
  if (!tenant) return;
  const cycleDays = BILLING_CYCLE_DAYS[billingCycle] || 30;
  const base = (tenant.subscriptionExpiry && new Date(tenant.subscriptionExpiry) > new Date()) ? new Date(tenant.subscriptionExpiry) : new Date();
  tenant.subscriptionStatus = 'active';
  tenant.subscriptionExpiry = addDays_(base, cycleDays).toISOString();
  tenant.plan = plan;
  tenant.billingCycle = billingCycle;
  writeRow_(sheet, TENANT_REGISTRY_HEADERS, tenant._row, tenant);
}

/* =========================================================
   CELL-CAPACITY MONITORING (time-based trigger, daily —
   see installTriggers()). Never runs on a page load.
   ========================================================= */
function checkAllTenantsCapacity_() {
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const rows = readRows_(sheet, TENANT_REGISTRY_HEADERS);
  const alerts = [];
  rows.forEach(tenant => {
    const result = checkOneTenantCapacity_(tenant);
    if (result && result.alert) alerts.push(result.alert);
  });
  if (alerts.length) sendCapacityAlertEmail_(alerts);
  return alerts.length;
}
// Checks one tenant (an already-read TenantRegistry row) and writes the
// result back. Shared by the daily checkAllTenantsCapacity_ loop and by
// archiveOldRecords_, which needs to refresh just the one org it touched
// immediately rather than waiting for the next scheduled run.
function checkOneTenantCapacity_(tenant) {
  let ss;
  try { ss = SpreadsheetApp.openById(tenant.spreadsheetId); } catch (e) { return null; } // sheet missing/inaccessible
  const checkedAt = nowIso_();
  const cellUsageCount = totalUsedCells_(ss);
  const cellUsagePercent = Math.round((cellUsageCount / CELL_LIMIT) * 10000) / 100;

  appendRow_(masterSheet_(MASTER_CAPACITY_HISTORY), CAPACITY_HISTORY_HEADERS, { orgId: tenant.orgId, checkedAt, cellUsageCount });
  const growth = estimateGrowth_(tenant.orgId, cellUsageCount, checkedAt);

  const previousStatus = tenant.capacityStatus;
  let status = 'Healthy', recommendation = 'No action needed.';
  if (cellUsagePercent >= CAPACITY_ACTION_THRESHOLD * 100) {
    status = 'Action Needed';
    recommendation = 'Approaching the 10,000,000-cell limit — archive older transactional records ' +
      '(old Sales/Stock history, old Messages) into a separate archive spreadsheet soon, or split this ' +
      'tenant\'s data (e.g. move records older than a year to an archive file) to avoid hitting the hard limit.';
  } else if (cellUsagePercent >= CAPACITY_MONITOR_THRESHOLD * 100) {
    status = 'Monitor';
    recommendation = 'Usage is climbing — worth planning ahead. Consider archiving old records ' +
      '(e.g. Stock In/Out history, old Messages) in the next few months.';
  }

  const registrySheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const fresh = readRows_(registrySheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === tenant.orgId) || tenant;
  fresh.cellUsageCount = cellUsageCount;
  fresh.cellUsagePercent = cellUsagePercent;
  fresh.cellGrowthPerDayEstimate = growth.perDay;
  fresh.estDaysToCapacity90 = growth.daysTo90 === null ? '' : growth.daysTo90;
  fresh.capacityStatus = status;
  fresh.capacityRecommendation = recommendation;
  fresh.capacityCheckedAt = checkedAt;
  writeRow_(registrySheet, TENANT_REGISTRY_HEADERS, fresh._row, fresh);

  return {
    cellUsageCount, cellUsagePercent, status, recommendation,
    alert: (status === 'Action Needed' && previousStatus !== 'Action Needed')
      ? { orgName: tenant.orgName, orgId: tenant.orgId, cellUsagePercent, recommendation } : null,
  };
}
function runCapacityCheckNow_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const alertCount = checkAllTenantsCapacity_();
  return json_({ success: true, alertCount });
}

/* =========================================================
   ARCHIVE OLD RECORDS — turns the capacity recommendation into a
   one-click Super Admin action. Moves old rows for chosen entityTypes
   (e.g. stockIn, stockOut, salesOrders — never products/customers/
   settings, since those aren't historical) out of a tenant's live Data
   sheet into a per-org Archive spreadsheet, then re-checks that one
   tenant's capacity immediately so the dashboard reflects it right away.
   The archive spreadsheet is created once per org and reused on every
   subsequent archive run (its ID is remembered in TenantRegistry).
   ========================================================= */
const ARCHIVE_SHEET = 'Archive';
const ARCHIVE_HEADERS = DATA_HEADERS.concat(['archivedAt']);

function getOrCreateArchiveSpreadsheet_(tenant) {
  if (tenant.archiveSpreadsheetId) {
    try { return SpreadsheetApp.openById(tenant.archiveSpreadsheetId); } catch (e) { /* fall through and make a new one */ }
  }
  const ss = SpreadsheetApp.create('OKV IMS Archive — ' + tenant.orgName);
  ensureSheet_(ss, ARCHIVE_SHEET, ARCHIVE_HEADERS);
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const fresh = readRows_(sheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === tenant.orgId);
  if (fresh) { fresh.archiveSpreadsheetId = ss.getId(); writeRow_(sheet, TENANT_REGISTRY_HEADERS, fresh._row, fresh); }
  return ss;
}
function archiveOldRecords_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const orgId = String(body.orgId || '');
  const entityTypes = Array.isArray(body.entityTypes) ? body.entityTypes : [];
  const cutoffMonths = Number(body.cutoffMonths) > 0 ? Number(body.cutoffMonths) : 12;
  if (!entityTypes.length) return json_({ success: false, error: 'Choose at least one record type to archive.' });

  const registrySheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const tenant = readRows_(registrySheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === orgId);
  if (!tenant) return json_({ success: false, error: 'Organisation not found.' });

  const tenantSs = getOrgSpreadsheet_(orgId);
  const dataSheet = dataSheet_(tenantSs);
  const rows = readRows_(dataSheet, DATA_HEADERS);
  const cutoff = addDays_(nowIso_(), -cutoffMonths * 30);
  const toArchive = rows.filter(d => entityTypes.indexOf(d.entityType) !== -1 && d.updatedAt && new Date(d.updatedAt) < cutoff);
  if (!toArchive.length) return json_({ success: true, archived: 0, message: 'Nothing matched that cutoff — nothing was moved.' });

  const archiveSs = getOrCreateArchiveSpreadsheet_(tenant);
  const archiveSheet = archiveSs.getSheetByName(ARCHIVE_SHEET) || archiveSs.insertSheet(ARCHIVE_SHEET);
  const archivedAt = nowIso_();
  toArchive.forEach(d => {
    appendRow_(archiveSheet, ARCHIVE_HEADERS, {
      orgId: d.orgId, entityType: d.entityType, recordId: d.recordId, payload: d.payload,
      updatedAt: d.updatedAt, updatedBy: d.updatedBy, deleted: d.deleted, archivedAt,
    });
  });
  // Delete from the bottom up so earlier row numbers don't shift under us.
  toArchive.map(d => d._row).sort((a, b) => b - a).forEach(rowNum => dataSheet.deleteRow(rowNum));

  const capacityResult = checkOneTenantCapacity_(tenant);
  return json_({
    success: true, archived: toArchive.length, archiveSpreadsheetUrl: archiveSs.getUrl(),
    newCellUsagePercent: capacityResult ? capacityResult.cellUsagePercent : null,
    newCapacityStatus: capacityResult ? capacityResult.status : null,
  });
}

// Sums actual used cells (data range, not the full default grid) across
// every tab in a tenant's spreadsheet.
function totalUsedCells_(ss) {
  return ss.getSheets().reduce((sum, sheet) => {
    const range = sheet.getDataRange();
    return sum + (range.getNumRows() * range.getNumColumns());
  }, 0);
}
// Looks back through CapacityHistory for a snapshot ~30 days ago (falls back
// to the oldest available if the org is newer than that) to estimate a daily
// growth rate, then projects days remaining until 90% capacity.
function estimateGrowth_(orgId, currentCount, checkedAtIso) {
  const rows = readRows_(masterSheet_(MASTER_CAPACITY_HISTORY), CAPACITY_HISTORY_HEADERS).filter(h => h.orgId === orgId);
  if (rows.length < 2) return { perDay: 0, daysTo90: null };
  const now = new Date(checkedAtIso);
  const target = addDays_(now, -30);
  let best = null;
  rows.forEach(h => {
    const d = new Date(h.checkedAt);
    if (d <= now && (!best || Math.abs(d - target) < Math.abs(new Date(best.checkedAt) - target))) best = h;
  });
  if (!best || best.checkedAt === checkedAtIso) return { perDay: 0, daysTo90: null };
  const daysElapsed = Math.max(1, daysBetween_(checkedAtIso, best.checkedAt));
  const perDay = Math.round(((currentCount - best.cellUsageCount) / daysElapsed) * 100) / 100;
  if (perDay <= 0) return { perDay, daysTo90: null }; // flat or shrinking — no runway estimate needed
  const cellsToNinety = CELL_LIMIT * 0.9 - currentCount;
  const daysTo90 = cellsToNinety <= 0 ? 0 : Math.round(cellsToNinety / perDay);
  return { perDay, daysTo90 };
}
function sendCapacityAlertEmail_(alerts) {
  try {
    const c = getContactConfig_();
    const rows = alerts.map(a =>
      '<li><b>' + a.orgName + '</b> — ' + a.cellUsagePercent + '% of cell limit used.<br>' +
      '<span style="font-size:12px;color:#666;">' + a.recommendation + '</span></li>'
    ).join('');
    MailApp.sendEmail({
      to: c.email,
      name: 'OKV Inventory Management System',
      subject: 'OKV Inventory Management System — ' + alerts.length + ' organisation(s) crossed "Action Needed" cell-capacity threshold',
      htmlBody: '<p>The following tenant spreadsheet(s) just crossed the 85% cell-usage threshold:</p><ul>' + rows + '</ul>' +
        '<p>Review them on the Super Admin Dashboard.</p>' + emailFooter_(),
    });
  } catch (err) { Logger.log('sendCapacityAlertEmail_ failed: ' + err.message); }
}

/* =========================================================
   TRIAL / SUBSCRIPTION REMINDERS — daily trigger, but each org is
   only actually emailed at most once every REMINDER_MIN_GAP_DAYS
   (twice a month), and only once inside REMINDER_WINDOW_DAYS of
   expiry (or already expired). The Admin Dashboard shows the same
   information every time it loads (see whoAmI_'s subscriptionDaysLeft/
   subscriptionExpired fields) — no separate trigger needed for that part.
   ========================================================= */
function sendTrialReminders_() {
  const cfg = getRemindersConfig_();
  const windowDays = cfg.windowDays || REMINDER_WINDOW_DAYS;
  const minGapDays = cfg.minGapDays || REMINDER_MIN_GAP_DAYS;
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const rows = readRows_(sheet, TENANT_REGISTRY_HEADERS);
  const plans = getPlansConfig_();
  const now = new Date();

  rows.forEach(tenant => {
    if (tenant.orgStatus === 'Suspended' || !tenant.subscriptionExpiry) return;
    const daysLeft = Math.ceil(daysBetween_(tenant.subscriptionExpiry, now.toISOString()));
    if (daysLeft > windowDays) return; // not due yet
    if (tenant.lastReminderSentAt && daysBetween_(now.toISOString(), tenant.lastReminderSentAt) < minGapDays) return; // too soon

    const currentPlan = plans.find(p => p.id === tenant.plan) || plans[0];
    const nextPlan = plans.find(p => p.id !== tenant.plan) || currentPlan;
    const state = daysLeft <= 0
      ? (tenant.subscriptionStatus === 'trial' ? 'trial has ended' : 'subscription has ended')
      : ((tenant.subscriptionStatus === 'trial' ? 'trial ends' : 'subscription renews') + ' in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's'));

    try {
      const c = getContactConfig_();
      MailApp.sendEmail({
        to: tenant.adminEmail,
        name: 'OKV Inventory Management System',
        subject: 'OKV IMS — ' + tenant.orgName + '\'s ' + (daysLeft <= 0 ? 'access has ended' : 'plan ' + state),
        htmlBody:
          '<p>Hi ' + tenant.adminFullName + ',</p>' +
          '<p>Your organisation\'s ' + state + ' on the <b>' + tenant.plan + ' (' + tenant.billingCycle + ')</b> plan.</p>' +
          '<p>To continue without interruption, open the <b>Upgrade & Subscription</b> tab on your dashboard and submit ' +
          'a payment — it takes a couple of minutes and you\'re usually confirmed within an hour.</p>' +
          '<p style="font-size:13px;color:#555;"><b>Your current plan (' + currentPlan.name + '):</b><br>' + currentPlan.features.join(' · ') + '</p>' +
          (nextPlan.id !== currentPlan.id ?
            '<p style="font-size:13px;color:#555;"><b>Considering ' + nextPlan.name + '?</b><br>' + nextPlan.features.join(' · ') + '</p>' : '') +
          emailFooter_(),
      });
      tenant.lastReminderSentAt = now.toISOString();
      writeRow_(sheet, TENANT_REGISTRY_HEADERS, tenant._row, tenant);
    } catch (err) { Logger.log('sendTrialReminders_ failed for ' + tenant.orgId + ': ' + err.message); }
  });
}

/* =========================================================
   SUPER ADMIN — auth
   ========================================================= */
function requireSuperAdmin_(sessionToken) {
  if (!sessionToken) return { error: 'Not logged in.' };
  const rows = readRows_(masterSheet_(MASTER_SUPER_ADMINS), SUPER_ADMIN_HEADERS);
  const sa = rows.find(r => r.sessionToken === sessionToken);
  if (!sa) return { error: 'Session not found. Please log in again.' };
  if (new Date(sa.sessionExpiry) < new Date()) return { error: 'Session expired. Please log in again.' };
  if (sa.status === 'Suspended') return { error: 'This Super Admin account has been suspended.' };
  return { superAdmin: sa };
}
function publicSuperAdmin_(sa) {
  return { superAdminId: sa.superAdminId, username: sa.username, fullName: sa.fullName, status: sa.status };
}
function superAdminLogin_(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const passwordHash = String(body.passwordHash || '');
  const sheet = masterSheet_(MASTER_SUPER_ADMINS);
  const rows = readRows_(sheet, SUPER_ADMIN_HEADERS);
  const sa = rows.find(r => String(r.username).toLowerCase() === username);
  if (!sa || sa.passwordHash !== passwordHash) return json_({ success: false, error: 'Incorrect username or password.' });
  if (sa.status === 'Suspended') return json_({ success: false, error: 'This account has been suspended.' });
  const now = nowIso_();
  sa.sessionToken = Utilities.getUuid();
  sa.sessionExpiry = addDays_(now, SESSION_DAYS).toISOString();
  writeRow_(sheet, SUPER_ADMIN_HEADERS, sa._row, sa);
  return json_({ success: true, sessionToken: sa.sessionToken, superAdmin: publicSuperAdmin_(sa) });
}
function superAdminLogout_(body) {
  const sheet = masterSheet_(MASTER_SUPER_ADMINS);
  const rows = readRows_(sheet, SUPER_ADMIN_HEADERS);
  const sa = rows.find(r => r.sessionToken === body.sessionToken);
  if (sa) { sa.sessionToken = ''; sa.sessionExpiry = ''; writeRow_(sheet, SUPER_ADMIN_HEADERS, sa._row, sa); }
  return json_({ success: true });
}
function superAdminWhoAmI_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  return json_({ success: true, superAdmin: publicSuperAdmin_(r.superAdmin) });
}
function superAdminChangePassword_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  if (r.superAdmin.passwordHash !== String(body.oldPasswordHash || '')) {
    return json_({ success: false, error: 'Current password is incorrect.' });
  }
  r.superAdmin.passwordHash = String(body.newPasswordHash || '');
  writeRow_(masterSheet_(MASTER_SUPER_ADMINS), SUPER_ADMIN_HEADERS, r.superAdmin._row, r.superAdmin);
  return json_({ success: true });
}

/* =========================================================
   SUPER ADMIN — tenant/org management
   ========================================================= */
function publicTenant_(t) {
  const copy = Object.assign({}, t); delete copy._row; return copy;
}
function listTenants_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const rows = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(publicTenant_);
  return json_({ success: true, tenants: rows });
}
function getTenant_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const tenant = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS).find(t => t.orgId === body.orgId);
  if (!tenant) return json_({ success: false, error: 'Organisation not found.' });
  return json_({ success: true, tenant: publicTenant_(tenant) });
}
// Lets the Super Admin edit an org's contact details and/or manually set
// plan/billing cycle/subscription expiry (e.g. a goodwill extension, or
// applying an off-platform payment) without touching the spreadsheet.
function updateTenant_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const tenant = readRows_(sheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === body.orgId);
  if (!tenant) return json_({ success: false, error: 'Organisation not found.' });

  ['orgName', 'adminFullName', 'adminEmail', 'adminPhone'].forEach(f => {
    if (body[f] !== undefined) tenant[f] = String(body[f]);
  });
  if (body.plan && body.billingCycle && body.applyUpgrade) {
    applyConfirmedSubscription_(tenant.orgId, String(body.plan), String(body.billingCycle));
  } else {
    if (body.plan !== undefined) tenant.plan = String(body.plan);
    if (body.billingCycle !== undefined) tenant.billingCycle = String(body.billingCycle);
    if (body.subscriptionExpiry !== undefined) tenant.subscriptionExpiry = String(body.subscriptionExpiry);
    if (body.subscriptionStatus !== undefined) tenant.subscriptionStatus = String(body.subscriptionStatus);
  }
  const fresh = readRows_(sheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === body.orgId) || tenant;
  Object.assign(fresh, tenant);
  writeRow_(sheet, TENANT_REGISTRY_HEADERS, fresh._row, fresh);

  // Keep tenant's own Users sheet in sync if org/admin contact details changed.
  if (body.orgName !== undefined || body.adminFullName !== undefined || body.adminEmail !== undefined || body.adminPhone !== undefined) {
    try {
      const ss = getOrgSpreadsheet_(tenant.orgId);
      const profiles = readRows_(usersSheet_(ss), USERS_HEADERS);
      const admin = profiles.find(p => p.accountType === 'Admin');
      if (admin) {
        if (body.orgName !== undefined) admin.orgName = body.orgName;
        if (body.adminFullName !== undefined) admin.fullName = body.adminFullName;
        if (body.adminEmail !== undefined) admin.email = body.adminEmail;
        if (body.adminPhone !== undefined) admin.phone = body.adminPhone;
        writeRow_(usersSheet_(ss), USERS_HEADERS, admin._row, admin);
      }
    } catch (err) { Logger.log('updateTenant_ profile sync failed: ' + err.message); }
  }
  return json_({ success: true, tenant: publicTenant_(fresh) });
}
function setTenantStatus_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const sheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const tenant = readRows_(sheet, TENANT_REGISTRY_HEADERS).find(t => t.orgId === body.orgId);
  if (!tenant) return json_({ success: false, error: 'Organisation not found.' });
  tenant.orgStatus = body.status === 'Suspended' ? 'Suspended' : 'Active';
  writeRow_(sheet, TENANT_REGISTRY_HEADERS, tenant._row, tenant);
  if (tenant.orgStatus === 'Suspended') {
    const idxSheet = masterSheet_(MASTER_USER_INDEX);
    readRows_(idxSheet, USER_INDEX_HEADERS).filter(u => u.orgId === body.orgId).forEach(u => {
      u.sessionToken = ''; u.sessionExpiry = '';
      writeRow_(idxSheet, USER_INDEX_HEADERS, u._row, u);
    });
  }
  return json_({ success: true });
}

/* =========================================================
   SUPER ADMIN — capacity dashboard (display-only; org Admins/Users
   never see this data)
   ========================================================= */
function getCapacityDashboard_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const rows = readRows_(masterSheet_(MASTER_TENANT_REGISTRY), TENANT_REGISTRY_HEADERS)
    .map(t => ({
      orgId: t.orgId, orgName: t.orgName, cellUsageCount: t.cellUsageCount || 0,
      cellUsagePercent: t.cellUsagePercent || 0, cellGrowthPerDayEstimate: t.cellGrowthPerDayEstimate || 0,
      estDaysToCapacity90: t.estDaysToCapacity90 === '' ? null : t.estDaysToCapacity90,
      capacityStatus: t.capacityStatus || 'Healthy', capacityRecommendation: t.capacityRecommendation || '',
      capacityCheckedAt: t.capacityCheckedAt || '',
    }))
    .sort((a, b) => (b.cellUsagePercent || 0) - (a.cellUsagePercent || 0));
  return json_({ success: true, tenants: rows });
}

/* =========================================================
   SUPER ADMIN — messaging org Admins (Announcement/Personalized/
   Other, by Email/SMS/WhatsApp — same gateway pattern as Message
   Members, targeting org Admin contacts instead of customers)
   ========================================================= */
function sendSuperAdminMessage_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const recipients = Array.isArray(body.recipients) ? body.recipients : []; // [{orgId, name, email, phone}]
  const channels = Array.isArray(body.channels) ? body.channels : [];
  const msgType = String(body.msgType || 'Announcement');
  const audience = String(body.audience || 'Selected');
  const subject = String(body.subject || 'A message from OKV Technology Consults');
  if (!recipients.length) return json_({ success: false, error: 'No recipients selected.' });
  if (!channels.length) return json_({ success: false, error: 'Select at least one channel.' });

  const sheet = masterSheet_(MASTER_SUPER_MESSAGES);
  const results = [];
  recipients.forEach(rec => {
    const personalizedBody = String(rec.body || body.body || '').replace(/\{\{\s*name\s*\}\}/gi, rec.name || 'there');
    channels.forEach(channel => {
      const { status, detail, destination } = sendOneMessage_(channel, rec, subject, personalizedBody, { orgName: 'OKV Technology Consults' });
      const row = {
        msgId: newId_('SAM'), sentBySuperAdminId: r.superAdmin.superAdminId, sentByName: r.superAdmin.fullName,
        msgType, audience, recipientOrgId: rec.orgId || '', recipientName: rec.name || '', channel, destination,
        subject, body: personalizedBody, status, statusDetail: detail, sentAt: nowIso_(),
      };
      appendRow_(sheet, SUPER_MSG_HEADERS, row);
      results.push(row);
    });
  });
  return json_({ success: true, results });
}
function listSuperAdminMessages_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const rows = readRows_(masterSheet_(MASTER_SUPER_MESSAGES), SUPER_MSG_HEADERS)
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, 300)
    .map(m => { delete m._row; return m; });
  return json_({ success: true, messages: rows });
}

/* =========================================================
   SUPER ADMIN — system configuration (contact/payment/branding/
   pricing/reminders). getSystemConfig_ requires Super Admin auth
   (includes secret keys) — contrast with the public, secret-free
   getPublicConfig_ used by login/signup/pricing pages.
   ========================================================= */
function getSystemConfig_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  return json_({
    success: true,
    contact: getContactConfig_(), bankAccounts: getBankAccounts_(), branding: getBrandingConfig_(),
    plans: getPlansConfig_(), gateways: getGatewaysConfig_(), reminders: getRemindersConfig_(),
  });
}
function updateSystemConfig_(body) {
  const r = requireSuperAdmin_(body.sessionToken);
  if (r.error) return json_({ success: false, error: r.error });
  const allowedKeys = ['contact', 'bankAccounts', 'branding', 'plans', 'gateways', 'reminders'];
  if (allowedKeys.indexOf(body.key) === -1) return json_({ success: false, error: 'Unknown config key.' });
  setConfigValue_(body.key, body.value);
  return json_({ success: true });
}

/* =========================================================
   ONE-TIME MIGRATION — moves data from the OLD single-spreadsheet
   build into this new multi-tenant structure. Run manually:
   1. Set OLD_SPREADSHEET_ID below to that original container-bound
      spreadsheet's ID.
   2. Run initMaster() first if you haven't already.
   3. Run migrateToMultiTenant_() once from the Apps Script editor.
   Safe to re-run — it skips orgIds already present in TenantRegistry.
   ========================================================= */
const OLD_SPREADSHEET_ID = ''; // <- paste the old spreadsheet's ID here before running

function migrateToMultiTenant_() {
  if (!OLD_SPREADSHEET_ID) throw new Error('Set OLD_SPREADSHEET_ID at the top of migrateToMultiTenant_ first.');
  const oldSs = SpreadsheetApp.openById(OLD_SPREADSHEET_ID);
  const oldUsersHeaders = [
    'userId', 'orgId', 'orgName', 'fullName', 'email', 'phone', 'username', 'passwordHash', 'accountType',
    'roles', 'status', 'plan', 'billingCycle', 'subscriptionStatus', 'subscriptionExpiry', 'trialStartedAt',
    'sessionToken', 'sessionExpiry', 'resetToken', 'resetTokenExpiry', 'createdAt', 'lastLoginAt',
  ];
  const oldUsers = readRows_(oldSs.getSheetByName('Users'), oldUsersHeaders);
  const oldData = readRows_(oldSs.getSheetByName('Data'), DATA_HEADERS);
  const oldMessages = oldSs.getSheetByName('Messages') ? readRows_(oldSs.getSheetByName('Messages'), MESSAGES_HEADERS) : [];
  const oldChat = oldSs.getSheetByName('ChatMessages') ? readRows_(oldSs.getSheetByName('ChatMessages'), CHAT_HEADERS) : [];
  const oldSubs = oldSs.getSheetByName('SubscriptionRequests') ? readRows_(oldSs.getSheetByName('SubscriptionRequests'), SUBS_HEADERS) : [];

  const registrySheet = masterSheet_(MASTER_TENANT_REGISTRY);
  const existingOrgIds = readRows_(registrySheet, TENANT_REGISTRY_HEADERS).map(t => t.orgId);
  const idxSheet = masterSheet_(MASTER_USER_INDEX);

  const orgIds = [...new Set(oldUsers.map(u => u.orgId))];
  let migrated = 0;
  orgIds.forEach(orgId => {
    if (existingOrgIds.indexOf(orgId) !== -1) return; // already migrated
    const usersForOrg = oldUsers.filter(u => u.orgId === orgId);
    const admin = usersForOrg.find(u => u.accountType === 'Admin') || usersForOrg[0];
    if (!admin) return;

    const tenantSs = createTenantSpreadsheet_(admin.orgName);
    usersForOrg.forEach(u => {
      appendRow_(usersSheet_(tenantSs), USERS_HEADERS, {
        userId: u.userId, orgId: u.orgId, orgName: u.orgName, fullName: u.fullName || '',
        email: u.email || '', phone: u.phone || '', accountType: u.accountType,
        roles: u.roles || '', createdAt: u.createdAt || nowIso_(), lastLoginAt: u.lastLoginAt || '',
      });
      appendRow_(idxSheet, USER_INDEX_HEADERS, {
        userId: u.userId, orgId: u.orgId, username: u.username, passwordHash: u.passwordHash,
        accountType: u.accountType, status: u.status || 'Active',
        sessionToken: '', sessionExpiry: '', resetToken: '', resetTokenExpiry: '',
      });
    });
    oldData.filter(d => d.orgId === orgId).forEach(d => appendRow_(dataSheet_(tenantSs), DATA_HEADERS, d));
    oldMessages.filter(m => m.orgId === orgId).forEach(m => appendRow_(messagesSheet_(tenantSs), MESSAGES_HEADERS, m));
    oldChat.filter(c => c.orgId === orgId).forEach(c => appendRow_(chatSheet_(tenantSs), CHAT_HEADERS, c));

    appendRow_(registrySheet, TENANT_REGISTRY_HEADERS, {
      orgId, orgName: admin.orgName, adminFullName: admin.fullName, adminEmail: admin.email, adminPhone: admin.phone,
      spreadsheetId: tenantSs.getId(), plan: admin.plan || 'Starter', billingCycle: admin.billingCycle || 'Monthly',
      subscriptionStatus: admin.subscriptionStatus || 'trial', subscriptionExpiry: admin.subscriptionExpiry || '',
      trialStartedAt: admin.trialStartedAt || '', orgStatus: 'Active', createdAt: admin.createdAt || nowIso_(),
      cellUsageCount: 0, cellUsagePercent: 0, cellGrowthPerDayEstimate: 0, estDaysToCapacity90: '',
      capacityStatus: 'Healthy', capacityRecommendation: '', capacityCheckedAt: '', lastReminderSentAt: '',
    });
    migrated++;
  });

  const masterSubsSheet = masterSheet_(MASTER_SUBS);
  const existingReqIds = readRows_(masterSubsSheet, SUBS_HEADERS).map(s => s.reqId);
  oldSubs.filter(s => existingReqIds.indexOf(s.reqId) === -1).forEach(s => appendRow_(masterSubsSheet, SUBS_HEADERS, s));

  Logger.log('Migration complete: ' + migrated + ' organisation(s) moved to their own spreadsheets.');
  return migrated;
}
