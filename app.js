// ── Constants ─────────────────────────────────────────────────────────────────
const SHEET_ID = '1ZgRYGNyw9lOvr1nwhhsZVHDSuGPVsXH4YfCec3h1O0o';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const IS_EXTENSION = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

const MEMBER_COL_IDX = { '김호민': 3, '나예찬': 4, '이준용': 5, '장재범': 6, '정찬호': 7, '최진혁': 8 };

const TIER_NAMES = [
  'Unrated','Bronze V','Bronze IV','Bronze III','Bronze II','Bronze I',
  'Silver V','Silver IV','Silver III','Silver II','Silver I',
  'Gold V','Gold IV','Gold III','Gold II','Gold I',
  'Platinum V','Platinum IV','Platinum III','Platinum II','Platinum I',
  'Diamond V','Diamond IV','Diamond III','Diamond II','Diamond I',
  'Ruby V','Ruby IV','Ruby III','Ruby II','Ruby I',
  'Master'
];
const TIER_CLASS = [
  'unrated',
  'bronze','bronze','bronze','bronze','bronze',
  'silver','silver','silver','silver','silver',
  'gold','gold','gold','gold','gold',
  'platinum','platinum','platinum','platinum','platinum',
  'diamond','diamond','diamond','diamond','diamond',
  'ruby','ruby','ruby','ruby','ruby',
  'master'
];

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
  document.getElementById('solved-id').addEventListener('input', saveSolvedId);
  document.getElementById('script-url').addEventListener('input', saveScriptUrl);
  document.querySelector('.copy-btn').addEventListener('click', copyScript);
});

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwlY-DVYx7bIdy4u_wGyk2mlwfev5H_DsvZJfsYFsoABQv0VEmZyVvZaRuYZ0is-Y0syQ/exec';

function loadSettings() {
  const member = localStorage.getItem('cote_member') || '나예찬';
  document.getElementById('member-select').value = member;
  loadSolvedIdForMember(member);
  const url = localStorage.getItem('cote_script_url') || DEFAULT_SCRIPT_URL;
  document.getElementById('script-url').value = url;
  const min = parseInt(localStorage.getItem('cote_timer_min') || '60', 10);
  document.getElementById('timer-min').value = min;
  timerLimit = min * 60;
  restoreTimerState();
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
    const solvedId = document.getElementById('solved-id').value.trim();
    if (todayRow && todayRow.isBaekjoon && solvedId) {
      await checkSolved();
    }
  } catch (e) {
    setStatus('❌ 스프레드시트 로드 실패: ' + e.message);
  }
}

function parseCSV(text) {
  const today = todayStr();
  const rows = text.trim().split('\n');
  allRows = [];
  todayIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    const cols = splitCSVRow(rows[i]);
    const rawDate = cols[0] || '';
    const norm = normalizeDate(rawDate);
    if (!norm) continue;

    const title = cols[1] || '제목 없음';
    const link = cols[2] || '';
    const cleanLink = link.replace(/^"(.*)"$/, '$1');
    const isBaekjoon = cleanLink.includes('acmicpc.net');
    const probMatch = cleanLink.match(/\/problem\/(\d+)/);
    const memberValues = {};
    for (const [name, idx] of Object.entries(MEMBER_COL_IDX)) {
      memberValues[name] = (cols[idx] || '').trim();
    }

    allRows.push({
      date: norm,
      title: title.replace(/^"(.*)"$/, '$1'),
      link: cleanLink,
      isBaekjoon,
      problemId: isBaekjoon && probMatch ? probMatch[1] : null,
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

async function renderViewedRow() {
  const row = allRows[viewIndex];
  if (!row) return;
  const isToday = viewIndex === todayIndex;

  // Nav buttons
  document.getElementById('btn-prev').disabled = viewIndex <= 0;
  document.getElementById('btn-next').disabled = viewIndex >= allRows.length - 1;

  // Date label
  document.getElementById('problem-date').textContent =
    row.date + (isToday ? ' (오늘)' : '');

  // Title helper
  const titleEl = document.getElementById('problem-title');
  function setTitle(text) {
    if (row.link) {
      const a = document.createElement('a');
      a.href = row.link;
      a.target = '_blank';
      a.textContent = text;
      titleEl.textContent = '';
      titleEl.appendChild(a);
    } else {
      titleEl.textContent = text;
    }
  }

  // Meta (tier/stats)
  const metaEl = document.getElementById('problem-meta');
  if (!row.isBaekjoon) {
    metaEl.style.display = 'none';
    setTitle(row.title);
  } else {
    metaEl.style.display = '';
    document.getElementById('tier-badge').className = 'tier-badge tier-unrated';
    document.getElementById('tier-badge').textContent = '?';
    document.getElementById('problem-stats').textContent = '';
    setTitle('로딩 중…');
  }

  setStatus('');
  updateTimerDisplay();
  updateStartBtn();

  // Fetch tier/stats + title (Baekjoon only)
  if (row.isBaekjoon && row.problemId) {
    try {
      const data = await fetchSolvedAC(`/problem/show?problemId=${row.problemId}`);
      if (allRows[viewIndex] === row) {
        setTitle(data.titleKo || data.title || row.title);
        renderTierBadge(data.level);
        const ac = data.acceptedUserCount?.toLocaleString() ?? '?';
        const rate = data.averageTries ? data.averageTries.toFixed(1) : '?';
        document.getElementById('problem-stats').textContent =
          `맞힌 사람 ${ac}명 · 평균 시도 ${rate}회`;
        setStatus('');
      }
    } catch (e) {
      if (allRows[viewIndex] === row) {
        setTitle(row.title);
        setStatus('solved.ac 로드 실패');
      }
    }
  }
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

function renderTierBadge(level) {
  const badge = document.getElementById('tier-badge');
  const cls = TIER_CLASS[level] || 'unrated';
  const name = TIER_NAMES[level] || 'Unrated';
  badge.className = `tier-badge tier-${cls}`;
  badge.textContent = name;
}

// ── solved.ac API ─────────────────────────────────────────────────────────────
async function fetchSolvedAC(path) {
  const url = `https://solved.ac/api/v3${path}`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  } catch (e) {
    if (IS_EXTENSION) throw e;
    const proxy = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    const r = await fetch(proxy);
    if (!r.ok) throw new Error(r.status);
    return r.json();
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
    // 1단계: 시트 확인 (백준/비백준 공통)
    const sheetVal = todayRow.memberValues[member];
    if (sheetVal !== '') {
      const minutes = parseFloat(sheetVal);
      const elapsedSec = isNaN(minutes) ? 0 : Math.round(minutes * 60);
      markSolved(elapsedSec);
      return;
    }

    if (!todayRow.isBaekjoon) {
      // 비백준: confirm 팝업으로 수동 확인
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
      return;
    }

    // 2단계: 백준 — solved.ac 확인
    const solvedId = document.getElementById('solved-id').value.trim();
    if (!solvedId || !todayRow.problemId) return;

    setStatus('solved.ac 확인 중…');
    const query = `id:${todayRow.problemId} s@${solvedId}`;
    const data = await fetchSolvedAC(`/search/problem?query=${encodeURIComponent(query)}&page=1`);

    if (data.count > 0) {
      const currentElapsed = elapsedSeconds;
      markSolved(currentElapsed);
      if (currentElapsed > 0) {
        const solveMin = (currentElapsed / 60).toFixed(1);
        setStatus('시트에 기록 중…');
        await recordToSheet(member, todayRow.date, parseFloat(solveMin));
        todayRow.memberValues[member] = solveMin;
      }
      setStatus('');
    } else {
      const confirmed = confirm(`${todayRow.title}\n\n아직 풀지 않은 문제입니다. 정말 완료하시겠습니까?`);
      if (!confirmed) { setStatus('풀이 기록 없음'); return; }
      const currentElapsed = elapsedSeconds;
      markSolved(currentElapsed);
      if (currentElapsed > 0) {
        const solveMin = (currentElapsed / 60).toFixed(1);
        setStatus('시트에 기록 중…');
        await recordToSheet(member, todayRow.date, parseFloat(solveMin));
        todayRow.memberValues[member] = solveMin;
      }
      setStatus('');
    }
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
  loadSolvedIdForMember(member);

  // 타이머 초기화
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
  }
  elapsedSeconds = 0;
  timerStartTs = 0;
  solvedAt = null;
  localStorage.setItem('cote_timer_running', 'false');
  localStorage.setItem('cote_timer_paused_at', '0');

  // 새 팀원의 solved 상태 확인
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

function loadSolvedIdForMember(member) {
  const id = localStorage.getItem(`cote_solved_id_${member}`) || '';
  document.getElementById('solved-id').value = id;
}

function saveSolvedId() {
  const member = document.getElementById('member-select').value;
  const id = document.getElementById('solved-id').value.trim();
  localStorage.setItem(`cote_solved_id_${member}`, id);
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
