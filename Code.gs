/**
 * Inpatient Patient-Flow Dashboard
 * Google Apps Script backend for Google Sheets database
 * Designed by : Mr. Mohamed Ghonim
 */

const CONFIG = {
  SPREADSHEET_ID: '12_Y4xs6wnJ7O6PZnrMoGPBWZWRpgz0BTwMXHMvVug_c',
  TIMEZONE: 'Asia/Riyadh',
  SHEETS: {
    BEDS: 'Beds',
    ADMISSIONS: 'Admissions',
    MOVEMENTS: 'Movements',
    DISCHARGES: 'Discharges',
    USERS: 'Users',
    LOOKUP: 'LookupLists'
  },
  CACHE_SECONDS: 6
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Inpatient Patient-Flow Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getInitialData() {
  return withErrorHandling_(() => {
    return {
      serverTime: nowIso_(),
      dashboard: getDashboardData_(),
      lookups: getLookups_(),
      users: getActiveNurses_()
    };
  });
}

function getDashboardData(filters) {
  return withErrorHandling_(() => getDashboardData_(filters || {}));
}

function login(username, password) {
  return withErrorHandling_(() => {
    username = String(username || '').trim();
    password = String(password || '').trim();
    if (!username || !password) throw new Error('Username and password are required.');

    const users = table_(CONFIG.SHEETS.USERS);
    const found = users.rows.find(u =>
      String(u.Username || '').trim().toLowerCase() === username.toLowerCase() &&
      String(u.Password || '').trim() === password &&
      isActive_(u.Active)
    );
    if (!found) throw new Error('Invalid username, password, or inactive account.');
    return {
      username: found.Username,
      role: found.Role,
      nurseName: found.NurseName || found.Username,
      permissions: permissions_(found.Role)
    };
  });
}

function admitPatient(payload) {
  return withLock_(() => withErrorHandling_(() => {
    payload = payload || {};
    const mrn = required_(payload.mrn, 'MRN');
    const bedId = required_(payload.bedId, 'Bed');
    const nurse = required_(payload.assignedNurse, 'Assigned nurse');
    const createdBy = payload.createdBy || 'Unknown';
    assertPermission_(payload.role, ['Primary Nurse', 'Charge Nurse', 'Admin']);

    const beds = table_(CONFIG.SHEETS.BEDS);
    const bedIndex = findRowIndex_(beds.rows, 'BedID', bedId);
    if (bedIndex < 0) throw new Error('Selected bed was not found.');
    const bed = beds.rows[bedIndex];
    if (String(bed.Status).toLowerCase() === 'occupied') throw new Error('This bed is already occupied.');

    const admissions = table_(CONFIG.SHEETS.ADMISSIONS);
    const active = admissions.rows.find(r => String(r.MRN) === mrn && String(r.Status).toLowerCase() === 'active');
    if (active) throw new Error('This MRN already has an active admission.');

    const ts = nowIso_();
    appendObject_(CONFIG.SHEETS.ADMISSIONS, {
      AdmissionID: makeId_('ADM'),
      MRN: mrn,
      BedID: bedId,
      Area: bed.Area,
      Category: bed.Category,
      AssignedNurse: nurse,
      AdmissionDateTime: ts,
      Status: 'Active',
      Notes: payload.notes || '',
      CreatedBy: createdBy
    });

    updateRow_(CONFIG.SHEETS.BEDS, bedIndex + 2, beds.headers, {
      Status: 'Occupied',
      CurrentMRN: mrn,
      CurrentNurse: nurse,
      LastUpdated: ts
    });

    clearDashboardCache_();
    return { message: 'Patient admitted successfully.', dashboard: getDashboardData_() };
  }));
}

function transferPatient(payload) {
  return withLock_(() => withErrorHandling_(() => {
    payload = payload || {};
    const mrn = required_(payload.mrn, 'MRN');
    const movementType = required_(payload.movementType, 'Movement type');
    const createdBy = payload.createdBy || 'Unknown';
    assertPermission_(payload.role, ['Primary Nurse', 'Charge Nurse', 'Admin']);

    const admissions = table_(CONFIG.SHEETS.ADMISSIONS);
    const activeAdmissionIndex = admissions.rows.findIndex(r => String(r.MRN) === mrn && String(r.Status).toLowerCase() === 'active');
    if (activeAdmissionIndex < 0) throw new Error('No active admission found for this MRN.');
    const admission = admissions.rows[activeAdmissionIndex];

    const beds = table_(CONFIG.SHEETS.BEDS);
    const fromBedId = admission.BedID;
    const fromBedIndex = findRowIndex_(beds.rows, 'BedID', fromBedId);
    const toBedId = payload.toBedId || '';
    const ts = nowIso_();

    if (movementType === 'Transfer to another bed') {
      if (!toBedId) throw new Error('Target bed is required for bed transfer.');
      const toBedIndex = findRowIndex_(beds.rows, 'BedID', toBedId);
      if (toBedIndex < 0) throw new Error('Target bed was not found.');
      if (String(beds.rows[toBedIndex].Status).toLowerCase() === 'occupied') throw new Error('Target bed is already occupied.');

      if (fromBedIndex >= 0) {
        updateRow_(CONFIG.SHEETS.BEDS, fromBedIndex + 2, beds.headers, {
          Status: 'Vacant', CurrentMRN: '', CurrentNurse: '', LastUpdated: ts
        });
      }
      updateRow_(CONFIG.SHEETS.BEDS, toBedIndex + 2, beds.headers, {
        Status: 'Occupied', CurrentMRN: mrn, CurrentNurse: admission.AssignedNurse, LastUpdated: ts
      });
      updateRow_(CONFIG.SHEETS.ADMISSIONS, activeAdmissionIndex + 2, admissions.headers, {
        BedID: toBedId,
        Area: beds.rows[toBedIndex].Area,
        Category: beds.rows[toBedIndex].Category
      });
    }

    appendObject_(CONFIG.SHEETS.MOVEMENTS, {
      MovementID: makeId_('MOV'),
      MRN: mrn,
      FromBedID: fromBedId,
      ToBedID: toBedId,
      MovementType: movementType,
      Destination: payload.destination || '',
      MovementDateTime: ts,
      Notes: payload.notes || '',
      CreatedBy: createdBy
    });

    clearDashboardCache_();
    return { message: 'Movement recorded successfully.', dashboard: getDashboardData_() };
  }));
}

function dischargePatient(payload) {
  return withLock_(() => withErrorHandling_(() => {
    payload = payload || {};
    const mrn = required_(payload.mrn, 'MRN');
    const dischargeType = required_(payload.dischargeType, 'Discharge type');
    const finalOutcome = required_(payload.finalOutcome, 'Final outcome');
    const createdBy = payload.createdBy || 'Unknown';
    assertPermission_(payload.role, ['Primary Nurse', 'Charge Nurse', 'Admin']);

    const admissions = table_(CONFIG.SHEETS.ADMISSIONS);
    const activeIndex = admissions.rows.findIndex(r => String(r.MRN) === mrn && String(r.Status).toLowerCase() === 'active');
    if (activeIndex < 0) throw new Error('No active admission found for this MRN.');
    const admission = admissions.rows[activeIndex];

    const beds = table_(CONFIG.SHEETS.BEDS);
    const bedIndex = findRowIndex_(beds.rows, 'BedID', admission.BedID);
    const ts = nowIso_();

    appendObject_(CONFIG.SHEETS.DISCHARGES, {
      DischargeID: makeId_('DIS'),
      MRN: mrn,
      BedID: admission.BedID,
      DischargeType: dischargeType,
      DischargeDestination: payload.dischargeDestination || '',
      DischargeDateTime: ts,
      FinalOutcome: finalOutcome,
      Notes: payload.notes || '',
      CreatedBy: createdBy
    });

    updateRow_(CONFIG.SHEETS.ADMISSIONS, activeIndex + 2, admissions.headers, { Status: 'Discharged' });
    if (bedIndex >= 0) {
      updateRow_(CONFIG.SHEETS.BEDS, bedIndex + 2, beds.headers, {
        Status: 'Vacant', CurrentMRN: '', CurrentNurse: '', LastUpdated: ts
      });
    }

    clearDashboardCache_();
    return { message: 'Patient discharged successfully.', dashboard: getDashboardData_() };
  }));
}

function searchPatientJourney(mrn) {
  return withErrorHandling_(() => {
    mrn = required_(mrn, 'MRN');
    const admissions = table_(CONFIG.SHEETS.ADMISSIONS).rows.filter(r => String(r.MRN) === String(mrn));
    const movements = table_(CONFIG.SHEETS.MOVEMENTS).rows.filter(r => String(r.MRN) === String(mrn));
    const discharges = table_(CONFIG.SHEETS.DISCHARGES).rows.filter(r => String(r.MRN) === String(mrn));
    return { mrn, admissions, movements, discharges, timeline: buildTimeline_(admissions, movements, discharges) };
  });
}

function getReportData(params) {
  return withErrorHandling_(() => {
    params = params || {};
    const type = params.type || 'current';
    const data = getDashboardData_(params.filters || {});
    let rows = [];
    if (type === 'occupied') rows = data.beds.filter(b => b.Status === 'Occupied');
    else if (type === 'vacant') rows = data.beds.filter(b => b.Status !== 'Occupied');
    else if (type === 'journey') rows = getJourneyRows_(params);
    else if (type === 'retrospective') rows = getRetrospectiveRows_(params);
    else rows = data.beds;
    return { type, generatedAt: nowIso_(), rows };
  });
}

function getDashboardData_(filters) {
  filters = filters || {};
  const cacheKey = 'dashboard_' + Utilities.base64EncodeWebSafe(JSON.stringify(filters));
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const beds = table_(CONFIG.SHEETS.BEDS).rows.map(normalizeBed_);
  const admissions = table_(CONFIG.SHEETS.ADMISSIONS).rows;
  const discharges = table_(CONFIG.SHEETS.DISCHARGES).rows;
  const now = new Date();

  const activeAdmissionsByMrn = {};
  admissions.forEach(a => { if (String(a.Status).toLowerCase() === 'active') activeAdmissionsByMrn[String(a.MRN)] = a; });

  let enrichedBeds = beds.map(b => {
    const admission = b.CurrentMRN ? activeAdmissionsByMrn[String(b.CurrentMRN)] : null;
    const admissionDateTime = admission ? admission.AdmissionDateTime : '';
    return Object.assign({}, b, {
      AdmissionDateTime: admissionDateTime,
      DurationText: admissionDateTime ? durationText_(new Date(admissionDateTime), now) : '',
      DurationMinutes: admissionDateTime ? Math.max(0, Math.floor((now - new Date(admissionDateTime)) / 60000)) : 0
    });
  });

  enrichedBeds = applyFilters_(enrichedBeds, filters);

  const totalBeds = beds.length;
  const occupiedBeds = beds.filter(b => b.Status === 'Occupied').length;
  const vacantBeds = totalBeds - occupiedBeds;
  const wardBeds = beds.filter(b => b.Category === 'Ward');
  const heatBeds = beds.filter(b => b.Category === 'Heat Stroke');
  const today = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const activeLos = enrichedBeds.filter(b => b.Status === 'Occupied' && b.DurationMinutes).map(b => b.DurationMinutes);

  const result = {
    serverTime: nowIso_(),
    beds: enrichedBeds,
    summary: {
      totalBeds,
      occupiedBeds,
      vacantBeds,
      wardOccupancy: occupancy_(wardBeds),
      heatStrokeOccupancy: occupancy_(heatBeds),
      averageLengthOfStay: activeLos.length ? durationTextFromMinutes_(Math.round(activeLos.reduce((a,b)=>a+b,0)/activeLos.length)) : '0m',
      admissionsToday: admissions.filter(a => dateOnly_(a.AdmissionDateTime) === today).length,
      dischargesToday: discharges.filter(d => dateOnly_(d.DischargeDateTime) === today).length
    },
    charts: {
      category: [
        { label: 'Ward', value: wardBeds.filter(b => b.Status === 'Occupied').length, total: wardBeds.length },
        { label: 'Heat Stroke', value: heatBeds.filter(b => b.Status === 'Occupied').length, total: heatBeds.length }
      ],
      status: [
        { label: 'Occupied', value: occupiedBeds },
        { label: 'Vacant', value: vacantBeds }
      ]
    }
  };
  cache.put(cacheKey, JSON.stringify(result), CONFIG.CACHE_SECONDS);
  return result;
}

function getLookups_() {
  const t = table_(CONFIG.SHEETS.LOOKUP);
  const out = {};
  t.headers.forEach(h => out[h] = []);
  t.rows.forEach(r => t.headers.forEach(h => { if (r[h] !== '' && r[h] != null) out[h].push(r[h]); }));
  return out;
}

function getActiveNurses_() {
  return table_(CONFIG.SHEETS.USERS).rows.filter(u => isActive_(u.Active)).map(u => ({ username: u.Username, role: u.Role, nurseName: u.NurseName }));
}

function getJourneyRows_(params) {
  const mrn = params.mrn || '';
  if (!mrn) return [];
  const journey = searchPatientJourney(mrn).data;
  return journey.timeline;
}

function getRetrospectiveRows_(params) {
  const start = params.startDate ? new Date(params.startDate + 'T00:00:00') : null;
  const end = params.endDate ? new Date(params.endDate + 'T23:59:59') : null;
  const admissions = table_(CONFIG.SHEETS.ADMISSIONS).rows;
  const discharges = table_(CONFIG.SHEETS.DISCHARGES).rows;
  const disByMrn = {};
  discharges.forEach(d => { disByMrn[String(d.MRN)] = d; });
  return admissions.filter(a => inDateRange_(a.AdmissionDateTime, start, end)).map(a => {
    const d = disByMrn[String(a.MRN)] || {};
    return {
      MRN: a.MRN,
      AdmissionDateTime: a.AdmissionDateTime,
      InitialBed: a.BedID,
      Area: a.Area,
      Category: a.Category,
      AssignedNurse: a.AssignedNurse,
      AdmissionStatus: a.Status,
      DischargeDateTime: d.DischargeDateTime || '',
      DischargeType: d.DischargeType || '',
      FinalOutcome: d.FinalOutcome || '',
      TotalLOS: d.DischargeDateTime ? durationText_(new Date(a.AdmissionDateTime), new Date(d.DischargeDateTime)) : durationText_(new Date(a.AdmissionDateTime), new Date())
    };
  });
}

function buildTimeline_(admissions, movements, discharges) {
  const rows = [];
  admissions.forEach(a => rows.push({ Type: 'Admission', DateTime: a.AdmissionDateTime, MRN: a.MRN, Details: 'Admitted to ' + a.BedID, Nurse: a.AssignedNurse, By: a.CreatedBy, Notes: a.Notes }));
  movements.forEach(m => rows.push({ Type: 'Movement', DateTime: m.MovementDateTime, MRN: m.MRN, Details: m.MovementType + ' | From: ' + (m.FromBedID || '-') + ' | To/Destination: ' + (m.ToBedID || m.Destination || '-'), Nurse: '', By: m.CreatedBy, Notes: m.Notes }));
  discharges.forEach(d => rows.push({ Type: 'Discharge', DateTime: d.DischargeDateTime, MRN: d.MRN, Details: d.DischargeType + ' | ' + (d.DischargeDestination || '') + ' | Outcome: ' + d.FinalOutcome, Nurse: '', By: d.CreatedBy, Notes: d.Notes }));
  return rows.sort((a,b) => new Date(a.DateTime) - new Date(b.DateTime));
}

function table_(sheetName) {
  const sh = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(sheetName);
  if (!sh) throw new Error('Missing sheet: ' + sheetName);
  const values = sh.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map(String);
  const rows = values.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {};
    headers.forEach((h, i) => o[h] = formatCell_(r[i]));
    return o;
  });
  return { headers, rows };
}

function appendObject_(sheetName, obj) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(headers.map(h => obj[h] != null ? obj[h] : ''));
}

function updateRow_(sheetName, rowNumber, headers, values) {
  const sh = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(sheetName);
  Object.keys(values).forEach(k => {
    const col = headers.indexOf(k) + 1;
    if (col > 0) sh.getRange(rowNumber, col).setValue(values[k]);
  });
}

function applyFilters_(beds, filters) {
  return beds.filter(b => {
    if (filters.search && !String(b.CurrentMRN || '').toLowerCase().includes(String(filters.search).toLowerCase()) && !String(b.DisplayBedName || '').toLowerCase().includes(String(filters.search).toLowerCase())) return false;
    if (filters.area && b.Area !== filters.area) return false;
    if (filters.status && b.Status !== filters.status) return false;
    if (filters.nurse && b.CurrentNurse !== filters.nurse) return false;
    return true;
  });
}

function normalizeBed_(b) {
  return {
    BedID: b.BedID,
    DisplayBedName: b.DisplayBedName,
    Area: b.Area,
    Category: b.Category,
    Status: String(b.Status || 'Vacant') === 'Occupied' ? 'Occupied' : 'Vacant',
    CurrentMRN: b.CurrentMRN || '',
    CurrentNurse: b.CurrentNurse || '',
    LastUpdated: b.LastUpdated || ''
  };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function withErrorHandling_(fn) {
  try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
}

function assertPermission_(role, allowed) {
  if (!allowed.includes(role)) throw new Error('Your role is not allowed to perform this action.');
}
function permissions_(role) {
  return {
    canAdmit: ['Primary Nurse','Charge Nurse','Admin'].includes(role),
    canTransfer: ['Primary Nurse','Charge Nurse','Admin'].includes(role),
    canDischarge: ['Primary Nurse','Charge Nurse','Admin'].includes(role),
    canExport: ['Charge Nurse','Admin'].includes(role),
    canManage: role === 'Admin'
  };
}
function required_(v, label) { if (v === undefined || v === null || String(v).trim() === '') throw new Error(label + ' is required.'); return String(v).trim(); }
function isActive_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes' || String(v) === '1'; }
function findRowIndex_(rows, key, value) { return rows.findIndex(r => String(r[key]) === String(value)); }
function makeId_(prefix) { return prefix + '-' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random()*9000+1000); }
function nowIso_() { return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"); }
function formatCell_(v) { return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss") : (v == null ? '' : v); }
function dateOnly_(v) { return v ? Utilities.formatDate(new Date(v), CONFIG.TIMEZONE, 'yyyy-MM-dd') : ''; }
function inDateRange_(v, start, end) { if (!v) return false; const d = new Date(v); if (start && d < start) return false; if (end && d > end) return false; return true; }
function occupancy_(beds) { const occ = beds.filter(b => b.Status === 'Occupied').length; return beds.length ? Math.round((occ / beds.length) * 100) + '%' : '0%'; }
function durationText_(start, end) { return durationTextFromMinutes_(Math.max(0, Math.floor((end - start) / 60000))); }
function durationTextFromMinutes_(mins) { const d=Math.floor(mins/1440), h=Math.floor((mins%1440)/60), m=mins%60; return (d?d+'d ':'') + (h?h+'h ':'') + m + 'm'; }
function clearDashboardCache_() { CacheService.getScriptCache().removeAll(['dashboard_' + Utilities.base64EncodeWebSafe(JSON.stringify({}))]); }
