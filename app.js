// ── Constants ─────────────────────────────────────────────────────────────────
const SHEET_ID = '1ZgRYGNyw9lOvr1nwhhsZVHDSuGPVsXH4YfCec3h1O0o';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const IS_EXTENSION = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

// ── State ─────────────────────────────────────────────────────────────────────
let allRows = [];      // 전체 행
let todayIndex = -1;   // 오늘 행의 인덱스
let viewIndex = 0;     // 현재 보고 있는 인덱스
let todayRow = null;   // 오늘 행 (편의 참조)

let timerInterval = null;
let timerRunning = false;
let timerStartTs = 0;   // Date.now() 기준 시작 타임스탬프 (경과 = Date.now() - timerStartTs)
let timerLimit = 60 * 60;
let elapsedSeconds = 0; // 현재 경과 초 (항상 Date.now() - timerStartTs 에서 계산)
let solvedAt = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadSpreadsheet();
  scheduleNightReset();

  document.getElementById('btn-start').addEventListener('click', onBtnStartClick);
  document.getElementById('btn-reset').addEventListener('click', resetTimer);
  document.getElementById('btn-prev').addEventListener('click', () => navigateTo(viewIndex - 1));
  document.getElementById('btn-next').addEventListener('click', () => navigateTo(viewIndex + 1));
  document.getElementById('timer-min').addEventListener('change', timerSetLimit);
  document.getElementById('member-select').addEventListener('change', onMemberChange);
  document.getElementById('script-url').addEventListener('input', saveScriptUrl);
  document.querySelector('.copy-btn').addEventListener('click', copyScript);
});

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwOWf980I4iRCEMg1WnrX1aB917dD9Ckl7vYrOqzbyom3Z-FqNaYv3RNmunlpphmhE/exec';

function loadSettings() {
  const url = localStorage.getItem('cote_script_url') || DEFAULT_SCRIPT_URL;
  document.getElementById('script-url').value = url;
  const min = parseInt(localStorage.getItem('cote_timer_min') || '60', 10);
  document.getElementById('timer-min').value = min;
  timerLimit = min * 60;
}

function restoreTimerState() {
  const member = document.getElementById('member-select').value;
  const savedSolvedAt = parseInt(localStorage.getItem(`cote_solved_at_${member}`) || '0', 10);
  const savedSolvedDate = localStorage.getItem(`cote_solved_date_${member}`) || '';
  if (savedSolvedAt > 0 && savedSolvedDate === todayStr()) {
    applySolvedState(savedSolvedAt);
    return;
  }

  const running = localStorage.getItem('cote_timer_running') === 'true';
  const startTs = parseInt(localStorage.getItem('cote_timer_start_ts') || '0', 10);

  if (running && startTs) {
    // 시작일과 현재가 KST 기준 다른 날이면 타이머 무효화
    const KST = 9 * 3600 * 1000;
    const DAY = 24 * 3600 * 1000;
    const startKstDay = Math.floor((startTs + KST) / DAY);
    const nowKstDay = Math.floor((Date.now() + KST) / DAY);
    if (startKstDay < nowKstDay) {
      localStorage.setItem('cote_timer_running', 'false');
      localStorage.removeItem('cote_timer_start_ts');
      renderTimer();
      return;
    }

    timerStartTs = startTs;
    elapsedSeconds = Math.round((Date.now() - timerStartTs) / 1000);
    timerRunning = true;
    timerInterval = setInterval(tickTimer, 500);
    const btn = document.getElementById('btn-start');
    btn.textContent = '✓ 풀이 확인';
    btn.className = 'btn btn-success';
  }
  renderTimer();
}

function applySolvedState(elapsedSec) {
  solvedAt = elapsedSec;
  elapsedSeconds = elapsedSec;
  renderTimer();
  updateStartBtn();
}

function markSolved(elapsedSec) {
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    localStorage.setItem('cote_timer_running', 'false');
  }
  localStorage.setItem('cote_timer_paused_at', elapsedSec);
  const member = document.getElementById('member-select').value;
  localStorage.setItem(`cote_solved_at_${member}`, elapsedSec);
  localStorage.setItem(`cote_solved_date_${member}`, todayStr());
  applySolvedState(elapsedSec);
}

// ── Spreadsheet ───────────────────────────────────────────────────────────────
async function loadSpreadsheet() {
  setStatus('스프레드시트 로딩 중…');
  try {
    const resp = await fetch(CSV_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    parseCSV(text);
    restoreTimerState();
  } catch (e) {
    setStatus('❌ 스프레드시트 로드 실패: ' + e.message);
  }
}

function parseCSV(text) {
  const today = todayStr();
  const rows = text.trim().split('\n');
  allRows = [];
  todayIndex = -1;

  if (rows.length < 3) return;

  // 3행(index 2)에서 팀원 이름과 컬럼 인덱스 추출 (Average 열 이전까지)
  // 1행의 "비고" 셀에 줄바꿈이 있어 CSV가 2줄로 분리되므로 실제 헤더는 index 2
  const headerCols = splitCSVRow(rows[2]);
  const memberNames = [];
  const memberColIdx = {};
  for (let c = 3; c < headerCols.length; c++) {
    const name = headerCols[c].trim().replace(/^"(.*)"$/, '$1');
    if (!name || name === 'Average') break;
    memberNames.push(name);
    memberColIdx[name] = c;
  }
  populateMemberSelect(memberNames);

  for (let i = 3; i < rows.length; i++) {
    const cols = splitCSVRow(rows[i]);
    const rawDate = cols[0] || '';
    const norm = normalizeDate(rawDate);
    if (!norm) continue;

    const title = cols[1] || '제목 없음';
    const link = cols[2] || '';
    const cleanLink = link.replace(/^"(.*)"$/, '$1');
    const memberValues = {};
    for (const [name, idx] of Object.entries(memberColIdx)) {
      memberValues[name] = (cols[idx] || '').trim();
    }

    allRows.push({
      date: norm,
      title: title.replace(/^"(.*)"$/, '$1'),
      link: cleanLink,
      memberValues
    });

    if (norm === today) todayIndex = allRows.length - 1;
  }

  todayRow = todayIndex >= 0 ? allRows[todayIndex] : null;
  viewIndex = todayIndex >= 0 ? todayIndex : allRows.length - 1;

  if (allRows.length === 0) {
    setStatus('스프레드시트에 데이터가 없습니다.');
    return;
  }
  renderViewedRow();
}

function populateMemberSelect(names) {
  const sel = document.getElementById('member-select');
  sel.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  const saved = localStorage.getItem('cote_member') || '';
  sel.value = names.includes(saved) ? saved : (names[0] || '');
}

function splitCSVRow(row) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuote && row[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigateTo(idx) {
  if (idx < 0 || idx >= allRows.length) return;
  viewIndex = idx;
  renderViewedRow();
}

function renderViewedRow() {
  const row = allRows[viewIndex];
  if (!row) return;
  const isToday = viewIndex === todayIndex;

  document.getElementById('btn-prev').disabled = viewIndex <= 0;
  document.getElementById('btn-next').disabled = viewIndex >= allRows.length - 1;

  document.getElementById('problem-date').textContent =
    row.date + (isToday ? ' (오늘)' : '');

  const titleEl = document.getElementById('problem-title');
  if (row.link) {
    const a = document.createElement('a');
    a.href = row.link;
    a.target = '_blank';
    a.textContent = row.title;
    titleEl.textContent = '';
    titleEl.appendChild(a);
  } else {
    titleEl.textContent = row.title;
  }

  setStatus('');
  updateTimerDisplay();
  updateStartBtn();
}

function updateTimerDisplay() {
  const isToday = viewIndex === todayIndex;
  if (isToday) {
    renderTimer();
    return;
  }
  // 비오늘: 해당 날의 팀원 기록 시간 또는 --:--
  const row = allRows[viewIndex];
  const member = document.getElementById('member-select').value;
  const val = row?.memberValues[member] || '';
  const display = document.getElementById('timer-display');
  const diffEl = document.getElementById('timer-diff');
  display.classList.remove('overtime');
  if (val !== '') {
    const minutes = parseFloat(val);
    if (!isNaN(minutes)) {
      const totalSec = Math.round(minutes * 60);
      display.textContent = fmtSec(totalSec);
      const diff = totalSec - timerLimit;
      if (diff > 0) {
        diffEl.textContent = `(+${fmtSec(diff)})`;
        diffEl.className = 'overtime';
      } else if (diff < 0) {
        diffEl.textContent = `(-${fmtSec(diff)})`;
        diffEl.className = 'undertime';
      } else {
        diffEl.textContent = '(00:00)';
        diffEl.className = '';
      }
      return;
    }
  }
  display.textContent = '--:--';
  diffEl.textContent = '';
  diffEl.className = '';
}

function updateStartBtn() {
  const isToday = viewIndex === todayIndex;
  const btn = document.getElementById('btn-start');
  const resetBtn = document.getElementById('btn-reset');
  if (!isToday) {
    btn.textContent = '▶ 시작';
    btn.className = 'btn btn-primary';
    btn.disabled = true;
    resetBtn.style.display = 'none';
    return;
  }
  if (solvedAt !== null) {
    btn.textContent = '✓ 풀이 확인';
    btn.className = 'btn btn-success';
    btn.disabled = true;
    resetBtn.style.display = 'none';
  } else if (timerRunning) {
    btn.textContent = '✓ 풀이 확인';
    btn.className = 'btn btn-success';
    btn.disabled = false;
    resetBtn.style.display = '';
  } else {
    btn.textContent = '▶ 시작';
    btn.className = 'btn btn-primary';
    btn.disabled = false;
    resetBtn.style.display = 'none';
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function onBtnStartClick() {
  if (solvedAt !== null) return;
  if (!timerRunning) {
    timerStart();
  } else {
    checkSolved();
  }
}

function tickTimer() {
  elapsedSeconds = Math.round((Date.now() - timerStartTs) / 1000);
  renderTimer();
}

function resetTimer() {
  if (!timerRunning) return;
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  timerStartTs = 0;
  elapsedSeconds = 0;
  localStorage.setItem('cote_timer_running', 'false');
  localStorage.removeItem('cote_timer_start_ts');
  renderTimer();
  updateStartBtn();
}

function scheduleNightReset() {
  const KST_OFFSET = 9 * 3600 * 1000;
  const nowKst = Date.now() + KST_OFFSET;
  const DAY_MS = 24 * 3600 * 1000;
  const nextKstMidnightUtc = (Math.floor(nowKst / DAY_MS) + 1) * DAY_MS - KST_OFFSET;
  const msUntil = nextKstMidnightUtc - Date.now();
  setTimeout(() => {
    if (timerRunning) resetTimer();
  }, msUntil);
}

function timerStart() {
  timerRunning = true;
  timerStartTs = Date.now() - elapsedSeconds * 1000;
  localStorage.setItem('cote_timer_running', 'true');
  localStorage.setItem('cote_timer_start_ts', timerStartTs);
  timerInterval = setInterval(tickTimer, 500);
  updateStartBtn();
}

function timerSetLimit() {
  const min = parseInt(document.getElementById('timer-min').value, 10) || 60;
  localStorage.setItem('cote_timer_min', min);
  timerLimit = min * 60;
  if (!timerRunning) renderTimer();
}

function fmtSec(sec) {
  const abs = Math.abs(sec);
  const mm = String(Math.floor(abs / 60)).padStart(2, '0');
  const ss = String(abs % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function renderTimer() {
  // 오늘이 아닌 날을 보고 있으면 live 타이머가 디스플레이를 덮어쓰지 않음
  if (allRows.length > 0 && viewIndex !== todayIndex) return;

  const display = document.getElementById('timer-display');
  const diffEl = document.getElementById('timer-diff');

  if (solvedAt !== null) {
    display.textContent = fmtSec(solvedAt);
    display.classList.remove('overtime');
    const diff = solvedAt - timerLimit;
    if (diff > 0) {
      diffEl.textContent = `(+${fmtSec(diff)})`;
      diffEl.className = 'overtime';
    } else if (diff < 0) {
      diffEl.textContent = `(-${fmtSec(diff)})`;
      diffEl.className = 'undertime';
    } else {
      diffEl.textContent = '(00:00)';
      diffEl.className = '';
    }
    return;
  }

  diffEl.textContent = '';
  diffEl.className = '';
  const s = timerLimit - elapsedSeconds;
  const abs = Math.abs(s);
  const mm = String(Math.floor(abs / 60)).padStart(2, '0');
  const ss = String(abs % 60).padStart(2, '0');
  display.textContent = (s < 0 ? '-' : '') + mm + ':' + ss;
  display.classList.toggle('overtime', s < 0);
}

// ── Check & Record ────────────────────────────────────────────────────────────
async function checkSolved() {
  if (viewIndex !== todayIndex || !todayRow) return;
  const member = document.getElementById('member-select').value;

  try {
    // 시트에 이미 기록된 값이 있으면 그걸로 확정
    const sheetVal = todayRow.memberValues[member];
    if (sheetVal !== '') {
      const minutes = parseFloat(sheetVal);
      const elapsedSec = isNaN(minutes) ? 0 : Math.round(minutes * 60);
      markSolved(elapsedSec);
      return;
    }

    const confirmed = confirm(`${todayRow.title}\n\n풀이를 완료했나요?`);
    if (!confirmed) return;
    const currentElapsed = elapsedSeconds;
    markSolved(currentElapsed);
    if (currentElapsed > 0) {
      const solveMin = (currentElapsed / 60).toFixed(1);
      setStatus('시트에 기록 중…');
      await recordToSheet(member, todayRow.date, parseFloat(solveMin));
      todayRow.memberValues[member] = solveMin;
    }
    setStatus('');
  } catch (e) {
    setStatus('오류: ' + e.message);
  }
}

async function recordToSheet(member, date, solveTime) {
  const url = localStorage.getItem('cote_script_url') || DEFAULT_SCRIPT_URL;
  if (!url) return;
  const params = new URLSearchParams({ date, member, solveTime });
  try {
    if (IS_EXTENSION) {
      const r = await fetch(`${url}?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (json.ok === false) throw new Error(json.error || '기록 실패');
    } else {
      await fetch(`${url}?${params}`, { mode: 'no-cors' });
    }
  } catch (e) {
    setStatus('❌ 기록 오류: ' + e.message);
    throw e;
  }
}

// ── Member / Settings helpers ─────────────────────────────────────────────────
function onMemberChange() {
  const member = document.getElementById('member-select').value;
  localStorage.setItem('cote_member', member);

  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
  }
  elapsedSeconds = 0;
  timerStartTs = 0;
  solvedAt = null;
  localStorage.setItem('cote_timer_running', 'false');
  localStorage.setItem('cote_timer_paused_at', '0');

  if (viewIndex === todayIndex && todayRow) {
    const sheetVal = todayRow.memberValues[member];
    if (sheetVal !== '') {
      const minutes = parseFloat(sheetVal);
      if (!isNaN(minutes)) {
        applySolvedState(Math.round(minutes * 60));
        return;
      }
    }
    const savedAt = parseInt(localStorage.getItem(`cote_solved_at_${member}`) || '0', 10);
    const savedDate = localStorage.getItem(`cote_solved_date_${member}`) || '';
    if (savedAt > 0 && savedDate === todayStr()) {
      applySolvedState(savedAt);
      return;
    }
  }
  renderTimer();
  updateStartBtn();
  updateTimerDisplay();
}

function saveScriptUrl() {
  localStorage.setItem('cote_script_url', document.getElementById('script-url').value.trim());
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('load-status').textContent = msg;
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeDate(raw) {
  const m = raw.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function copyScript() {
  const code = document.getElementById('script-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = '복사됨!';
    setTimeout(() => { btn.textContent = '복사'; }, 2000);
  });
}
