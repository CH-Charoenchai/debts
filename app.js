// ========= ใส่ค่าจาก Project Settings > Data API ของคุณตรงนี้ =========
    const SUPABASE_URL = 'https://rjxkwjecbgmtomvyaoxp.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_I_cwQD9m84D9D04pK3a6zA_Ff6oUY0b';
    const VAPID_PUBLIC_KEY = 'BLgkyHztkavPdE4YIaf_LhBvlmo6J84f5VCAVOAy4FgsFRQLFn7csuMtuPK98GFgEfQbkZ6Wum3_Fn_UGiw2qos';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribeToPush(userId) {
  try {
    console.log('[push] subscribeToPush start, userId:', userId);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { console.log('[push] no SW or PushManager support'); return; }
    const reg = await navigator.serviceWorker.ready;
    console.log('[push] SW ready:', reg);
    let sub = await reg.pushManager.getSubscription();
    console.log('[push] existing sub:', sub);
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      console.log('[push] new sub created:', sub);
    }
    const json = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }, { onConflict: 'endpoint' });
    console.log('[push] upsert error:', error);
  } catch (e) {
    console.error('[push] CAUGHT ERROR:', e);
  }
}
// ======================================================================


const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let DATA = null;
let currentTab = 'home';
let paymentType = 'one_time';
let monthOffset = 0;          // 0 = เดือนปัจจุบัน, +1/+2 = ล่วงหน้า, ติดลบ = ย้อนหลัง (อ่านจาก snapshot)
const MIN_MONTH_OFFSET = -6;  // ดูย้อนหลังได้ 6 เดือน (จาก snapshot)
const MAX_MONTH_OFFSET = 2;   // ล่วงหน้าได้สูงสุด 2 เดือน (ดูประมาณการ/บันทึกรายจ่ายล่วงหน้า)
let isReadonlyMonth = false;  // true เมื่อกำลังดู snapshot เดือนที่ผ่านไปแล้ว
let selectedCategoryFilter = ''; // '' = ทั้งหมด
let selectedDebts = new Set();
let selectedPeopleItems = new Set();
let pendingDeleteIds = new Set();   // ids ที่ถูกซ่อนไว้รอลบจริง (เผื่อกด undo)
let pendingDeleteTimers = {};       // id -> timeoutId

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const THAI_MONTHS_SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

// ---------- AUTH ----------
function togglePasswordView() {
  const input = document.getElementById('loginPassword');
  const btn = document.getElementById('togglePwBtn');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁️';
}
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('lock-error');
  const btn = document.getElementById('loginBtn');
  if (!email || !password) { errEl.textContent = 'กรอกอีเมลและรหัสผ่านก่อนนะ'; return; }
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (error) { errEl.textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + error.message; return; }
  errEl.textContent = '';
}
async function doLogout() {
  await sb.auth.signOut();
}
function unlockApp(session) {
  document.getElementById('lock').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('tabbar').style.display = 'flex';
  document.getElementById('accountEmail').textContent = session.user.email;

  enableNotification(); // เพิ่มตรงนี้

  switchTab('home');
  loadData();
}
function lockApp() {
  document.getElementById('lock').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('tabbar').style.display = 'none';
  document.getElementById('fabWrap').style.display = 'none';
  document.getElementById('loginPassword').value = '';
}
sb.auth.onAuthStateChange((event, session) => {
  if (session) unlockApp(session); else lockApp();
});

// ---------- MONTH ----------
function monthKeyForOffset(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function currentMonthKey() { return monthKeyForOffset(monthOffset); }
const REAL_CURRENT_MONTH = monthKeyForOffset(0);
function thaiMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return THAI_MONTHS[m - 1] + ' ' + (y + 543);
}
function changeMonth(delta) {
  const next = monthOffset + delta;
  if (next < MIN_MONTH_OFFSET || next > MAX_MONTH_OFFSET) return;
  monthOffset = next;
  clearSelections();
  loadData();
}
function resetToCurrentMonth() {
  monthOffset = 0;
  selectedCategoryFilter = '';
  clearSelections();
  loadData();
  showToast('รีเซตกลับเดือนปัจจุบันแล้ว 🌱');
}

// ---------- DATA ----------
async function loadData() {
  const month = currentMonthKey();

  // ----- ย้อนหลัง: อ่านจาก snapshot อย่างเดียว -----
  if (monthOffset < 0) {
    isReadonlyMonth = true;
    const snapRes = await sb.rpc('get_snapshot', { p_month: month });
    if (snapRes.error) return handleErr(snapRes.error);
    if (!snapRes.data) {
      DATA = { month, obligations: [], transactions: [], people: [], categories: [], salary: 0, monthlyStats: [] };
      computeTotals(); render();
      showToast('ยังไม่มีข้อมูลย้อนหลังของเดือนนี้');
      return;
    }
    DATA = snapRes.data;
    DATA.monthlyStats = [];
    computeTotals(); render();
    return;
  }

  isReadonlyMonth = false;
  if (monthOffset === 0) {
    const { error: rErr } = await sb.rpc('ensure_monthly_reset', { p_month: month });
    if (rErr) return handleErr(rErr);
    // เก็บ snapshot เดือนก่อนหน้า (idempotent) + คิดดอกเบี้ยยอดหมุนเวียนของเดือนนี้
    const prevMonth = monthKeyForOffset(-1);
    await sb.rpc('snapshot_month', { p_month: prevMonth });
    const { error: iErr } = await sb.rpc('apply_monthly_interest', { p_month: month });
    if (iErr) console.warn('apply_monthly_interest:', iErr.message);
  }

  const [dataRes, statsRes] = await Promise.all([
    sb.rpc('get_all_data', { p_month: month }),
    sb.rpc('get_monthly_stats', { p_months: 6 })
  ]);
  if (dataRes.error) return handleErr(dataRes.error);

  try {
    DATA = dataRes.data;
    DATA.monthlyStats = (!statsRes.error && statsRes.data) ? statsRes.data : [];
    computeTotals();
    render();
  } catch (e) {
    console.error('render() error:', e);
    showToast('render error: ' + e.message);
  }
}

function isDoneObl(o) {
  return o.status === 'paid' || (o.payment_type === 'installment' && o.completed === true);
}

function computeTotals() {
  const obligations = visibleObligations();
  const payables = obligations.filter(o => o.direction === 'payable');
  const receivables = obligations.filter(o => o.direction === 'receivable');
  DATA.totalDebt = payables.reduce((s, o) =>
    s + (isDoneObl(o) ? 0 : Math.max(0, Number(o.computedAmount || 0))), 0);
  DATA.totalReceivable = receivables
    .filter(o => !isDoneObl(o))
    .reduce((s, o) => s + Number(o.computedAmount || 0), 0);
  DATA.netRemaining = (Number(DATA.salary) || 0) - DATA.totalDebt + DATA.totalReceivable;
}

function fmt(n) { return '฿' + Number(n || 0).toLocaleString('th-TH', {maximumFractionDigits: 0}); }
function showToast(msg, onUndo) {
  const t = document.getElementById('toast');
  t.innerHTML = '';
  t.appendChild(document.createTextNode(msg));
  if (onUndo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo-btn';
    btn.textContent = 'เรียกคืน';
    btn.onclick = () => { onUndo(); t.classList.remove('show'); };
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), onUndo ? 4000 : 1800);
}
// ---------- SOFT DELETE / UNDO ----------
function visibleObligations() { return DATA.obligations.filter(o => !pendingDeleteIds.has(String(o.id))); }
function visiblePeople() { return DATA.people.filter(p => !pendingDeleteIds.has(String(p.id))); }
function visibleTransactions() { return DATA.transactions.filter(t => !pendingDeleteIds.has(String(t.id))); }
function scheduleDelete(id, label, executeFn) {
  const key = String(id);
  pendingDeleteIds.add(key);
  computeTotals(); render();
  pendingDeleteTimers[key] = setTimeout(async () => {
    delete pendingDeleteTimers[key];
    const { error } = await executeFn();
    pendingDeleteIds.delete(key);
    if (error) { handleErr(error); computeTotals(); render(); return; }
    loadData();
  }, 3500);
  showToast(label, () => {
    clearTimeout(pendingDeleteTimers[key]);
    delete pendingDeleteTimers[key];
    pendingDeleteIds.delete(key);
    computeTotals(); render();
  });
}
function handleErr(err) { showToast('เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err)); }

function render() {
  // หัวเดือน + คำทักทาย แสดงซ้ำทุกหน้า (home / debts / people / settings) -> อัปเดตทุก instance ด้วย class
  document.querySelectorAll('.month-label-text').forEach(el => { el.textContent = thaiMonthLabel(DATA.month || currentMonthKey()); });
  document.querySelectorAll('.month-prev-btn').forEach(el => { el.disabled = monthOffset <= MIN_MONTH_OFFSET; });
  document.querySelectorAll('.month-next-btn').forEach(el => { el.disabled = monthOffset >= MAX_MONTH_OFFSET; });
  document.querySelectorAll('.greeting-text').forEach(el => { el.textContent = greetingText(); });

  document.getElementById('futureNote').style.display = monthOffset > 0 ? 'block' : 'none';
  const pastNote = document.getElementById('pastNote');
  if (pastNote) pastNote.style.display = isReadonlyMonth ? 'block' : 'none';
  document.getElementById('netAmount').textContent = fmt(DATA.netRemaining);
  document.getElementById('salaryVal').textContent = fmt(DATA.salary);
  document.getElementById('debtVal').textContent = fmt(DATA.totalDebt);
  document.getElementById('recvVal').textContent = fmt(DATA.totalReceivable);
  document.getElementById('thinDebtVal').textContent = fmt(DATA.totalDebt);
  document.getElementById('thinRecvVal').textContent = fmt(DATA.totalReceivable);
  document.getElementById('salaryInput').value = DATA.salary || '';
  renderDebts();
  renderPeople();
  renderBulkBars();
  renderUpcoming();
  renderSparkline();
  renderFabVisibility();
  renderCategories();
  renderQuickAddRevolving();
  renderCategoryChips();
  renderCategoryBreakdown();
}

// ---------- CATEGORY FILTER + BREAKDOWN ----------
function setCategoryFilter(id) {
  selectedCategoryFilter = (selectedCategoryFilter === String(id || '')) ? '' : String(id || '');
  renderDebts(); renderPeople(); renderCategoryChips();
}
function renderCategoryChips() {
  const cats = (DATA && DATA.categories) || [];
  const chipsHtml = (idPrefix) => '<button class="cat-chip' + (selectedCategoryFilter === '' ? ' active' : '') + '" onclick="setCategoryFilter(\'\')">ทั้งหมด</button>'
    + cats.map(c => '<button class="cat-chip' + (selectedCategoryFilter === String(c.id) ? ' active' : '') + '" onclick="setCategoryFilter(\'' + c.id + '\')">' + esc(c.name) + '</button>').join('');
  const dEl = document.getElementById('catChipsDebts');
  const pEl = document.getElementById('catChipsPeople');
  if (dEl) dEl.innerHTML = cats.length ? chipsHtml('d') : '';
  if (pEl) pEl.innerHTML = cats.length ? chipsHtml('p') : '';
}
function renderCategoryBreakdown() {
  const card = document.getElementById('categoryBreakdownCard');
  const wrap = document.getElementById('categoryBreakdownWrap');
  const cats = (DATA && DATA.categories) || [];
  const active = visibleObligations().filter(o => o.direction === 'payable' && !isDoneObl(o));
  if (!cats.length || !active.length) { card.style.display = 'none'; return; }
  const totals = {};
  active.forEach(o => {
    const key = o.category_id ? String(o.category_id) : '__none__';
    totals[key] = (totals[key] || 0) + Number(o.computedAmount || 0);
  });
  const rows = Object.keys(totals).map(key => ({
    name: key === '__none__' ? 'ไม่ระบุ' : ((cats.find(c => String(c.id) === key) || {}).name || 'ไม่ระบุ'),
    total: totals[key]
  })).sort((a, b) => b.total - a.total);
  if (!rows.length) { card.style.display = 'none'; return; }
  const maxVal = Math.max(1, ...rows.map(r => r.total));
  card.style.display = 'block';
  wrap.innerHTML = rows.map(r =>
    '<div class="cat-breakdown-row">'
    + '<div class="cb-name">' + esc(r.name) + '</div>'
    + '<div class="cb-bar-wrap"><div class="cb-bar" style="width:' + Math.max(4, (r.total / maxVal) * 100) + '%;"></div></div>'
    + '<div class="cb-amount">' + fmt(r.total) + '</div>'
    + '</div>'
  ).join('');
}

// ---------- HOME: quick add ยอดรูดบัตร ----------
function renderQuickAddRevolving() {
  const section = document.getElementById('quickAddRevolvingSection');
  const wrap = document.getElementById('quickAddRevolvingWrap');
  if (isReadonlyMonth) { section.style.display = 'none'; wrap.innerHTML = ''; return; }
  const revolvingItems = visibleObligations().filter(o => o.payment_type === 'revolving' && !isDoneObl(o));
  if (!revolvingItems.length) { section.style.display = 'none'; wrap.innerHTML = ''; return; }
  section.style.display = 'block';
  wrap.innerHTML = revolvingItems.map(o => {
    const tag = o.direction === 'payable' ? 'ต้องจ่าย' : 'ต้องเก็บ';
    return '<div class="quick-add-row">'
      + '<div class="quick-add-name">' + esc(o.name) + '<span class="qa-tag">' + tag + ' • ' + fmt(o.computedAmount) + '</span></div>'
      + '<button class="btn btn-mint" data-action="openTxModal" data-id="' + esc(o.id) + '">+ รายการ</button>'
      + '</div>';
  }).join('');
}

function greetingText() {
  const unpaidCount = visibleObligations().filter(o => !isDoneObl(o)).length;
  if (unpaidCount === 0) return 'จัดการครบหมดแล้ว เก่งมาก 🎉';
  if (unpaidCount <= 3) return 'เหลืออีกนิดเดียว สู้ๆ นะ 💪';
  return 'มาจัดการหนี้กันเถอะวันนี้ 🌱';
}

function paymentTypeLabel(o) {
  if (o.payment_type === 'installment') {
    return o.completed === true ? 'ผ่อนครบแล้ว 🎉' : 'งวดที่ ' + o.current_installment + ' / ' + o.total_installments;
  }
  if (o.payment_type === 'recurring') return 'จ่ายทุกเดือน (ไม่มีกำหนดจบ)';
  if (o.payment_type === 'revolving') return 'ยอดหมุนเวียน';
  return 'จ่ายครั้งเดียว';
}
function dueDaySuffix(o) {
  return o.due_day ? ' • จ่ายวันที่ ' + o.due_day : '';
}
function categorySuffix(o) {
  if (!o.category_id || !DATA.categories) return '';
  const cat = DATA.categories.find(c => String(c.id) === String(o.category_id));
  return cat ? ' • ' + cat.name : '';
}
function interestSuffix(o) {
  const rate = Number(o.interest_rate_percent || 0);
  return (o.payment_type === 'revolving' && rate > 0) ? ' • ดอกเบี้ย ' + rate + '%/ด' : '';
}
function isUrgent(o) {
  if (currentMonthKey() !== REAL_CURRENT_MONTH) return false;
  if (!o.due_day) return false;
  const today = new Date();
  const dueDate = new Date(today.getFullYear(), today.getMonth(), o.due_day);
  // ถ้า due_day น้อยกว่าวันนี้มาก (เช่น due_day=2 แต่วันนี้ 28) ให้ถือว่าเป็นเดือนหน้า
  if (dueDate < new Date(today.getFullYear(), today.getMonth(), today.getDate() - 15)) {
    dueDate.setMonth(dueDate.getMonth() + 1);
  }
  const diffDays = Math.round((dueDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  return diffDays <= 3;
}
// ---------- SELECTION / BULK ----------
function clearSelections() { selectedDebts.clear(); selectedPeopleItems.clear(); }
function toggleSelect(kind, id, checked) {
  const set = kind === 'debts' ? selectedDebts : selectedPeopleItems;
  if (checked) set.add(String(id)); else set.delete(String(id));
  renderBulkBars();
}
function renderBulkBars() {
  const dBar = document.getElementById('bulkBarDebts');
  const pBar = document.getElementById('bulkBarPeople');
  dBar.classList.toggle('show', selectedDebts.size > 0);
  pBar.classList.toggle('show', selectedPeopleItems.size > 0);
  document.getElementById('bulkCountDebts').textContent = 'เลือกแล้ว ' + selectedDebts.size + ' รายการ';
  document.getElementById('bulkCountPeople').textContent = 'เลือกแล้ว ' + selectedPeopleItems.size + ' รายการ';
}
async function bulkSetStatus(kind, status) {
  const set = kind === 'debts' ? selectedDebts : selectedPeopleItems;
  if (!set.size) return;
  const ids = Array.from(set);
  const rpcName = status === 'paid' ? 'mark_obligations_paid_bulk' : 'mark_obligations_unpaid_bulk';
  const { error } = await sb.rpc(rpcName, { p_ids: ids });
  if (error) return handleErr(error);
  set.clear();
  loadData();
  showToast(status === 'paid' ? 'อัปเดตแล้ว เก่งมาก 👏' : 'เปลี่ยนกลับเป็นยังไม่จ่ายแล้ว');
}
async function toggleObligationStatus(id, currentStatus) {
  const goingToPaid = currentStatus !== 'paid';
  const rpcName = goingToPaid ? 'mark_obligation_paid' : 'mark_obligation_unpaid';
  const { error } = await sb.rpc(rpcName, { p_id: id });
  if (error) return handleErr(error);
  loadData();
  showToast(goingToPaid ? 'จ่ายแล้ว เก่งมาก 👏' : 'แก้เป็นยังไม่จ่ายแล้วนะ');
}

// ---------- HOME: upcoming + sparkline ----------
function renderUpcoming() {
  const el = document.getElementById('upcomingList');
  if (currentMonthKey() !== REAL_CURRENT_MONTH) {
    el.innerHTML = '<div class="empty">ดูรายการใกล้ครบกำหนดได้เฉพาะเดือนปัจจุบันนะ 📅</div>';
    return;
  }
  const today = new Date().getDate();
  const items = visibleObligations()
    .filter(o => o.due_day && !isDoneObl(o) && (o.due_day - today) <= 3)
    .map(o => Object.assign({}, o, { daysUntil: o.due_day - today }))
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 3);
  if (!items.length) { el.innerHTML = '<div class="empty">ไม่มีรายการใกล้ครบกำหนด 🌿</div>'; return; }
  el.innerHTML = items.map(o => {
    const overdue = o.daysUntil < 0;
    const dueLabel = overdue ? 'เลยกำหนดมา ' + Math.abs(o.daysUntil) + ' วัน'
      : (o.daysUntil === 0 ? 'ครบกำหนดวันนี้' : 'อีก ' + o.daysUntil + ' วัน');
    const dirTag = o.direction === 'payable' ? 'ต้องจ่าย' : 'ต้องเก็บ';
    return '<div class="card" style="padding:10px 14px;">'
      + '<div class="row"><div><div class="item-name">' + esc(o.name) + '</div>'
      + '<div class="item-sub" style="color:' + (overdue ? 'var(--danger)' : 'var(--plum-soft)') + ';">' + dirTag + ' • ' + dueLabel + '</div></div>'
      + '<div class="item-amount">' + fmt(o.computedAmount) + '</div></div></div>';
  }).join('');
}

function buildSparklineSvg(stats, w, h, showLabels) {
  if (!stats.length) return '<div class="empty" style="padding:10px 0;">ยังไม่มีข้อมูลสถิติ เริ่มเก็บตั้งแต่เดือนนี้ไปเรื่อยๆ ⏳</div>';
  const maxVal = Math.max(1, ...stats.map(s => Math.max(Number(s.paid_total), Number(s.received_total))));
  const padTop = 6, padBottom = showLabels ? 18 : 4;
  const usableH = h - padTop - padBottom;
  const stepX = stats.length > 1 ? w / (stats.length - 1) : 0;
  const toY = v => padTop + usableH - (Number(v) / maxVal) * usableH;
  const ptsPay = stats.map((s, i) => (i * stepX) + ',' + toY(s.paid_total)).join(' ');
  const ptsRecv = stats.map((s, i) => (i * stepX) + ',' + toY(s.received_total)).join(' ');
  let labels = '';
  if (showLabels) {
    labels = stats.map((s, i) => {
      const [, m] = s.month.split('-').map(Number);
      return '<text x="' + (i * stepX) + '" y="' + (h - 4) + '" font-size="9" fill="#8A8195" text-anchor="middle" font-family="Sarabun">' + THAI_MONTHS_SHORT[m - 1] + '</text>';
    }).join('');
  }
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">'
    + '<polyline points="' + ptsPay + '" fill="none" stroke="#E8927D" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<polyline points="' + ptsRecv + '" fill="none" stroke="#5A96C4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + labels
    + '</svg>';
}
function renderSparkline() {
  document.getElementById('sparklineWrap').innerHTML = buildSparklineSvg(DATA.monthlyStats || [], 300, 50, false);
}
function openStatsModal() {
  const stats = DATA.monthlyStats || [];
  const totalPaid = stats.reduce((s, x) => s + Number(x.paid_total), 0);
  const totalRecv = stats.reduce((s, x) => s + Number(x.received_total), 0);
  document.getElementById('statsContent').innerHTML =
    buildSparklineSvg(stats, 300, 130, true)
    + '<div class="spark-legend" style="margin-top:10px;">'
    + '<span><span class="dot" style="background:#E8927D;"></span>จ่ายไปแล้ว รวม ' + fmt(totalPaid) + '</span>'
    + '<span><span class="dot" style="background:#5A96C4;"></span>ได้รับแล้ว รวม ' + fmt(totalRecv) + '</span>'
    + '</div>'
    + '<div class="item-sub" style="margin-top:10px;">สถิตินี้เก็บจากตอนกด "จ่ายแล้ว/ได้แล้ว" เท่านั้น เดือนที่ผ่านมาก่อนเริ่มใช้ฟีเจอร์นี้จะยังไม่มีข้อมูลย้อนหลังนะ</div>';
  openModal('modalStats');
}

// ---------- COMPLETED ITEMS SHEET ----------
function openCompletedModal(onlyDirection) {
  const done = visibleObligations().filter(isDoneObl);
  const groups = [
    { dir: 'payable', title: 'หนี้ที่จ่ายแล้ว 💳' },
    { dir: 'receivable', title: 'รายการที่ได้แล้ว 🧾' }
  ].filter(g => !onlyDirection || g.dir === onlyDirection);

  let html = '';
  groups.forEach(g => {
    const items = done.filter(o => o.direction === g.dir);
    html += '<div class="section-title" style="margin-top:14px;"><span>' + g.title + '</span></div>';
    if (!items.length) { html += '<div class="empty" style="padding:14px 0;">ยังไม่มีรายการ</div>'; return; }
    html += items.map(o => {
      const person = g.dir === 'receivable' ? DATA.people.find(p => String(p.id) === String(o.person_id)) : null;
      const title = person ? (person.name + ' • ' + o.name) : o.name;
      return '<div class="card">'
        + '<div class="row"><div><div class="item-name">' + esc(title) + '</div>'
        + '<div class="item-sub">' + paymentTypeLabel(o) + '</div></div>'
        + '<div class="item-amount">' + fmt(o.amount) + '</div></div>'
        + '<div class="card-actions">'
        + '<button class="btn btn-ghost" data-action="toggleStatus" data-id="' + esc(o.id) + '" data-status="paid">แก้เป็นยังไม่เสร็จ</button>'
        + '<button class="btn btn-danger" data-action="removeDebt" data-id="' + esc(o.id) + '">ลบ</button>'
        + '</div></div>';
    }).join('');
  });
  document.getElementById('completedContent').innerHTML = html;
  openModal('modalCompleted');
}

// ---------- DEBTS ----------
function renderDebts() {
  const urgentTitle = document.getElementById('debtsUrgentTitle');
  const urgentList = document.getElementById('debtsUrgentList');
  const list = document.getElementById('debtsList');
  const allPayable = visibleObligations().filter(o => o.direction === 'payable'
    && (!selectedCategoryFilter || String(o.category_id) === selectedCategoryFilter));
  const active = allPayable.filter(o => !isDoneObl(o));

  if (!allPayable.length) {
    urgentTitle.style.display = 'none'; urgentList.innerHTML = '';
    list.innerHTML = '<div class="empty">ยังไม่มีรายการหนี้ กดปุ่ม + เพื่อเพิ่มเลย 🌱</div>';
    return;
  }
  if (!active.length) {
    urgentTitle.style.display = 'none'; urgentList.innerHTML = '';
    list.innerHTML = '<div class="empty">จ่ายครบหมดแล้วตอนนี้ เก่งมาก 🎉<br>ดูรายการที่จบแล้วได้ที่ปุ่ม "จบแล้ว 🏆" ด้านบน</div>';
    return;
  }
  // โซน "ใกล้ครบกำหนด" โชว์เฉพาะตอนดูเดือนปัจจุบันเท่านั้น (เดือนอื่นไม่ต้องเตือน)
  const onCurrentMonth = currentMonthKey() === REAL_CURRENT_MONTH;
  const urgent = onCurrentMonth ? active.filter(isUrgent) : [];
  const rest = onCurrentMonth ? active.filter(o => !isUrgent(o)) : active;

  if (urgent.length) {
    urgentTitle.style.display = 'flex';
    urgentList.innerHTML = urgent.map(d => renderObligationCard(d, 'debts')).join('');
  } else {
    urgentTitle.style.display = 'none'; urgentList.innerHTML = '';
  }
  list.innerHTML = rest.length ? rest.map(d => renderObligationCard(d, 'debts')).join('')
    : '<div class="empty">ไม่มีรายการอื่นแล้ว</div>';
}

function renderObligationCard(d, kind) {
  const sub = paymentTypeLabel(d) + dueDaySuffix(d) + categorySuffix(d) + interestSuffix(d);
  const isChecked = (kind === 'debts' ? selectedDebts : selectedPeopleItems).has(String(d.id));
  let badgeHtml = '';
  let amountClass = '';
  if (d.payment_type === 'revolving' && Number(d.computedAmount) <= 0) {
    badgeHtml = '<span class="badge none">ไม่มีหนี้ค้าง</span>';
    if (Number(d.computedAmount) < 0) amountClass = 'neg';
  }
  if (isReadonlyMonth) {
    let txListHtmlRo = '';
    if (d.payment_type === 'revolving') {
      const txs = (DATA.transactions || []).filter(t => String(t.obligation_id) === String(d.id));
      if (txs.length) {
        txListHtmlRo = '<div class="sub-list">' + txs.map(t => (
          '<div class="sub-row"><span class="sub-note">' + esc(t.note) + '</span>'
          + '<span class="sub-amount">' + fmt(t.amount) + '</span></div>'
        )).join('') + '</div>';
      }
    }
    return '<div class="card">'
      + '<div class="row"><div><div class="item-name">' + esc(d.name) + '</div>'
      + '<div class="item-sub">' + sub + '</div></div>'
      + '<div style="text-align:right;"><div class="item-amount ' + amountClass + '">' + fmt(d.computedAmount) + '</div>' + badgeHtml + '</div></div>'
      + txListHtmlRo
      + '</div>';
  }
  const txBtn = d.payment_type === 'revolving'
    ? '<button class="btn btn-ghost" data-action="openTxModal" data-id="' + esc(d.id) + '">+ รายการ</button>'
    : '';
  const interestBtn = d.payment_type === 'revolving'
    ? '<button class="btn btn-ghost" data-action="editInterest" data-id="' + esc(d.id) + '" data-rate="' + esc(d.interest_rate_percent || 0) + '">% ดอกเบี้ย</button>'
    : '';
  const payBtn = '<button class="btn btn-mint" data-action="toggleStatus" data-id="' + esc(d.id) + '" data-status="unpaid">จ่ายแล้ว</button>';

  let txListHtml = '';
  if (d.payment_type === 'revolving') {
    const txs = visibleTransactions().filter(t => String(t.obligation_id) === String(d.id));
    if (txs.length) {
      txListHtml = '<div class="sub-list">' + txs.map(t => (
        '<div class="sub-row' + (t.month && t.month > REAL_CURRENT_MONTH ? ' planned' : '') + '">'
        + '<span class="sub-note">' + esc(t.note) + '</span>'
        + '<span class="sub-amount">' + fmt(t.amount) + '</span>'
        + '<button class="sub-del" data-action="removeTx" data-id="' + esc(t.id) + '" title="ลบรายการ">✕</button>'
        + '</div>'
      )).join('') + '</div>';
    }
  }

  return '<div class="card">'
    + '<div class="row row-select">'
    + '<input type="checkbox" class="select-check" data-action="toggleSelect" data-kind="' + kind + '" data-id="' + esc(d.id) + '" ' + (isChecked ? 'checked' : '') + '>'
    + '<div class="row" style="flex:1;"><div><div class="item-name">' + esc(d.name) + '</div>'
    + '<div class="item-sub">' + sub + '</div></div>'
    + '<div style="text-align:right;"><div class="item-amount ' + amountClass + '">' + fmt(d.computedAmount) + '</div>' + badgeHtml + '</div></div>'
    + '</div>'
    + txListHtml
    + '<div class="card-actions">' + payBtn + txBtn + interestBtn
    + '<button class="btn btn-danger" data-action="removeDebt" data-id="' + esc(d.id) + '">ลบ</button></div>'
    + '</div>';
}

// ---------- PEOPLE ----------
function renderPeople() {
  const el = document.getElementById('peopleList');
  const people = visiblePeople();
  if (!people.length) { el.innerHTML = '<div class="empty">ยังไม่มีใครติดเงินเราเลย 🌸 กด + เพื่อเพิ่ม</div>'; return; }
  el.innerHTML = people.map(p => {
    const allItems = visibleObligations().filter(o => o.direction === 'receivable' && String(o.person_id) === String(p.id)
      && (!selectedCategoryFilter || String(o.category_id) === selectedCategoryFilter));
    const items = allItems.filter(o => !isDoneObl(o));
    const total = items.reduce((s, i) => s + Number(i.computedAmount || 0), 0);

    let itemsHtml;
    if (!allItems.length) {
      itemsHtml = '<div class="item-sub" style="padding:6px 0;">ยังไม่มีรายการ</div>';
    } else if (!items.length) {
      itemsHtml = '<div class="item-sub" style="padding:6px 0;">ได้ครบหมดแล้ว ✓ (ดูได้ที่ปุ่ม "จบแล้ว 🏆")</div>';
    } else {
      itemsHtml = '<div class="person-items">' + items.map(i => {
        const sub = paymentTypeLabel(i) + dueDaySuffix(i) + categorySuffix(i) + interestSuffix(i);
        if (isReadonlyMonth) {
          let txListHtmlRo = '';
          if (i.payment_type === 'revolving') {
            const txs = (DATA.transactions || []).filter(t => String(t.obligation_id) === String(i.id));
            if (txs.length) {
              txListHtmlRo = '<div class="sub-list">' + txs.map(t => (
                '<div class="sub-row"><span class="sub-note">' + esc(t.note) + '</span>'
                + '<span class="sub-amount">' + fmt(t.amount) + '</span></div>'
              )).join('') + '</div>';
            }
          }
          return '<div class="person-item-row">'
            + '<div class="row"><div><div class="person-item-name">' + esc(i.name) + '</div>'
            + '<div class="item-sub">' + sub + '</div></div>'
            + '<span style="font-size:13px; font-weight:600;">' + fmt(i.computedAmount) + '</span></div>'
            + txListHtmlRo
            + '</div>';
        }
        const isChecked = selectedPeopleItems.has(String(i.id));
        const paidBtn = '<button class="btn btn-mint" style="padding:5px 10px; font-size:12px;" data-action="toggleStatus" data-id="' + esc(i.id) + '" data-status="unpaid">ได้แล้ว</button>';
        const txBtn = i.payment_type === 'revolving'
          ? '<button class="btn btn-ghost" style="padding:5px 10px; font-size:12px;" data-action="openTxModal" data-id="' + esc(i.id) + '">+ รายการ</button>' : '';
        const interestBtn = i.payment_type === 'revolving'
          ? '<button class="btn btn-ghost" style="padding:5px 10px; font-size:12px;" data-action="editInterest" data-id="' + esc(i.id) + '" data-rate="' + esc(i.interest_rate_percent || 0) + '">% ดอกเบี้ย</button>' : '';

        let txListHtml = '';
        if (i.payment_type === 'revolving') {
          const txs = visibleTransactions().filter(t => String(t.obligation_id) === String(i.id));
          if (txs.length) {
            txListHtml = '<div class="sub-list">' + txs.map(t => (
              '<div class="sub-row">'
              + '<span class="sub-note">' + esc(t.note) + '</span>'
              + '<span class="sub-amount">' + fmt(t.amount) + '</span>'
              + '<button class="sub-del" data-action="removeTx" data-id="' + esc(t.id) + '" title="ลบรายการ">✕</button>'
              + '</div>'
            )).join('') + '</div>';
          }
        }

        return '<div class="person-item-row">'
          + '<div class="row row-select">'
          + '<input type="checkbox" class="select-check" data-action="toggleSelect" data-kind="people" data-id="' + esc(i.id) + '" ' + (isChecked ? 'checked' : '') + '>'
          + '<div class="row" style="flex:1;"><div><div class="person-item-name">' + esc(i.name) + '</div>'
          + '<div class="item-sub">' + sub + '</div></div>'
          + '<div style="display:flex; align-items:center; gap:8px;">'
          + '<span style="font-size:13px; font-weight:600;">' + fmt(i.computedAmount) + '</span></div></div>'
          + '</div>'
          + txListHtml
          + '<div class="card-actions">' + paidBtn + txBtn + interestBtn
          + '<button class="btn btn-danger" style="padding:5px 10px; font-size:12px;" data-action="removeDebt" data-id="' + esc(i.id) + '">ลบรายการ</button></div>'
          + '</div>';
      }).join('') + '</div>';
    }

    return '<div class="card">'
      + '<div class="row"><div class="person-name">' + esc(p.name) + '</div>'
      + '<div class="person-total">' + fmt(total) + '</div></div>'
      + itemsHtml
      + (isReadonlyMonth ? '' :
        '<div class="card-actions" style="margin-top:12px;">'
        + '<button class="btn btn-ghost" data-action="openItemModal" data-id="' + esc(p.id) + '">+ รายการ</button>'
        + '<button class="btn btn-danger" data-action="removePerson" data-id="' + esc(p.id) + '">ลบคนนี้</button>'
        + '</div>')
      + '</div>';
  }).join('');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.getElementById('app').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (action === 'toggleStatus') { toggleObligationStatus(id, btn.dataset.status); return; }
  if (action === 'editInterest') { editInterest(id, btn.dataset.rate); return; }
  const actions = { removeDebt, openTxModal, openItemModal, removePerson, removeTx, removeCategory };
  if (actions[action]) actions[action](id);
});
document.getElementById('app').addEventListener('change', function(e) {
  const el = e.target.closest('[data-action="toggleSelect"]');
  if (!el) return;
  toggleSelect(el.dataset.kind, el.dataset.id, el.checked);
});
document.getElementById('completedContent').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (action === 'toggleStatus') { toggleObligationStatus(id, btn.dataset.status).then(() => closeModal('modalCompleted')); return; }
  if (action === 'removeDebt') { removeDebt(id); openCompletedModal(); }
});

// ---------- TABS ----------
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  renderFabVisibility();
}
function renderFabVisibility() {
  document.getElementById('fabWrap').style.display =
    (!isReadonlyMonth && (currentTab === 'debts' || currentTab === 'people')) ? 'block' : 'none';
}

// ---------- ADD OBLIGATION ----------
function resetObligationForm() {
  document.getElementById('obligationName').value = '';
  document.getElementById('obligationAmount').value = '';
  document.getElementById('obligationCurrentInstallment').value = '';
  document.getElementById('obligationTotalInstallments').value = '';
  document.getElementById('obligationDueDay').value = '';
  document.getElementById('obligationInterestRate').value = '';
  document.getElementById('obligationCategory').value = '';
  document.getElementById('obligationNewCategoryName').value = '';
  document.getElementById('obligationNewCategoryName').style.display = 'none';
  setPaymentType('one_time');
}
function resetPersonForm() { document.getElementById('personName').value = ''; }
function openAddModal() {
  if (currentTab === 'people') { resetPersonForm(); openModal('modalPerson'); }
  else {
    resetObligationForm();
    document.getElementById('obligationDirection').value = 'payable';
    document.getElementById('obligationPersonId').value = '';
    document.getElementById('obligationModalTitle').textContent = 'เพิ่มหนี้ใหม่';
    openModal('modalObligation');
  }
}
function openItemModal(personId) {
  resetObligationForm();
  document.getElementById('obligationDirection').value = 'receivable';
  document.getElementById('obligationPersonId').value = personId;
  document.getElementById('obligationModalTitle').textContent = 'เพิ่มรายการที่เขาติด';
  openModal('modalObligation');
}
function setPaymentType(t) {
  paymentType = t;
  ['one_time','installment','recurring','revolving'].forEach(k => {
    document.getElementById('type_' + k).classList.toggle('active', k === t);
  });
  document.getElementById('installmentFields').style.display = t === 'installment' ? 'block' : 'none';
  document.getElementById('amountField').style.display = t === 'revolving' ? 'none' : 'block';
  document.getElementById('interestField').style.display = t === 'revolving' ? 'block' : 'none';
  const labels = { one_time: 'จำนวนเงิน', installment: 'ยอดต่องวด', recurring: 'จำนวนเงินต่อเดือน' };
  document.getElementById('amountLabel').textContent = labels[t] || 'จำนวนเงิน';
}
async function submitAddObligation() {
  const name = document.getElementById('obligationName').value.trim();
  if (!name) { showToast('ใส่ชื่อรายการก่อนนะ'); return; }
  const direction = document.getElementById('obligationDirection').value;
  const personId = document.getElementById('obligationPersonId').value || null;
  const dueDayVal = document.getElementById('obligationDueDay').value;
  const params = {
    p_direction: direction, p_name: name, p_payment_type: paymentType,
    p_person_id: personId, p_amount: 0, p_current: null, p_total: null,
    p_due_day: dueDayVal ? Number(dueDayVal) : null
  };
  if (paymentType === 'installment') {
    const current = Number(document.getElementById('obligationCurrentInstallment').value || 1);
    const total = Number(document.getElementById('obligationTotalInstallments').value || 1);
    if (current > total) { showToast('งวดที่กำลังจะจ่ายต้องไม่เกินจำนวนงวดทั้งหมด'); return; }
    params.p_amount = Number(document.getElementById('obligationAmount').value || 0);
    params.p_current = current;
    params.p_total = total;
  } else if (paymentType !== 'revolving') {
    params.p_amount = Number(document.getElementById('obligationAmount').value || 0);
  }

  // ---- หมวดหมู่: ถ้าเลือก "เพิ่มหมวดหมู่ใหม่" ให้สร้างหมวดหมู่ก่อน ----
  const categorySelect = document.getElementById('obligationCategory').value;
  let categoryId = null;
  if (categorySelect === '__new__') {
    const newCatName = document.getElementById('obligationNewCategoryName').value.trim();
    if (!newCatName) { showToast('ใส่ชื่อหมวดหมู่ใหม่ก่อนนะ'); return; }
    const catRes = await sb.rpc('add_category', { p_name: newCatName });
    if (catRes.error) return handleErr(catRes.error);
    categoryId = catRes.data && catRes.data.id;
  } else if (categorySelect) {
    categoryId = categorySelect;
  }

  const { data, error } = await sb.rpc('add_obligation', params);
  if (error) return handleErr(error);

  // ผูกหมวดหมู่เข้ากับรายการที่เพิ่งสร้าง (ต้องได้ id ของรายการกลับมาจาก add_obligation)
  if (categoryId && data && data.id) {
    const catAssignRes = await sb.rpc('set_obligation_category', { p_obligation_id: data.id, p_category_id: categoryId });
    if (catAssignRes.error) handleErr(catAssignRes.error);
  }

  if (paymentType === 'revolving' && data && data.id) {
    const rate = Number(document.getElementById('obligationInterestRate').value || 0);
    if (rate > 0) {
      const rateRes = await sb.rpc('set_obligation_interest', { p_obligation_id: data.id, p_rate: rate });
      if (rateRes.error) handleErr(rateRes.error);
    }
  }

  closeModal('modalObligation'); loadData(); showToast('เพิ่มรายการแล้ว 🎉');
}
function removeDebt(id) {
  scheduleDelete(id, 'ลบแล้ว', () => sb.from('obligations').delete().eq('id', id));
}

async function editInterest(obligationId, currentRate) {
  const input = prompt('ดอกเบี้ยต่อเดือน (%) สำหรับยอดหมุนเวียนนี้:', currentRate || '0');
  if (input === null) return;
  const rate = Number(input);
  if (isNaN(rate) || rate < 0) { showToast('ใส่ตัวเลข % ให้ถูกต้อง'); return; }
  const { error } = await sb.rpc('set_obligation_interest', { p_obligation_id: obligationId, p_rate: rate });
  if (error) return handleErr(error);
  loadData(); showToast('ตั้งดอกเบี้ยแล้ว 💳');
}

// ---------- TRANSACTION (revolving) ----------
function openTxModal(obligationId) {
  document.getElementById('txObligationId').value = obligationId;
  document.getElementById('txNote').value = '';
  document.getElementById('txAmount').value = '';
  const title = monthOffset > 0 ? 'บันทึกรายจ่ายล่วงหน้า 🔮' : 'เพิ่มรายการรูดบัตร / ยอดเพิ่ม';
  document.getElementById('txModalTitle').textContent = title;
  document.getElementById('txMonthNote').textContent = monthOffset > 0
    ? 'กำลังบันทึกให้เดือน ' + thaiMonthLabel(currentMonthKey()) + ' (เดือนล่วงหน้า) เพื่อดูยอดคร่าวๆ'
    : '';
  openModal('modalTx');
}
async function submitAddTx() {
  const obligationId = document.getElementById('txObligationId').value;
  const note = document.getElementById('txNote').value.trim();
  const amount = Number(document.getElementById('txAmount').value || 0);
  if (!note || !amount) { showToast('กรอกให้ครบก่อนนะ'); return; }
  const { error } = await sb.rpc('add_obligation_transaction', {
    p_obligation_id: obligationId, p_note: note, p_amount: amount, p_month: currentMonthKey()
  });
  if (error) return handleErr(error);
  closeModal('modalTx'); loadData(); showToast('เพิ่มรายการแล้ว');
}
function removeTx(id) {
  scheduleDelete(id, 'ลบรายการแล้ว', () => sb.from('obligation_transactions').delete().eq('id', id));
}

// ---------- PEOPLE ----------
async function submitAddPerson() {
  const name = document.getElementById('personName').value.trim();
  if (!name) { showToast('ใส่ชื่อก่อนนะ'); return; }
  const { error } = await sb.from('people').insert({ name });
  if (error) return handleErr(error);
  closeModal('modalPerson'); loadData(); showToast('เพิ่มแล้ว 🌸');
}
async function removePerson(id) {
  if (!confirm('ลบคนนี้พร้อมรายการทั้งหมดเลยไหม?')) return;
  const { error } = await sb.from('people').delete().eq('id', id);
  if (error) return handleErr(error);
  loadData();
}

// ---------- CATEGORIES ----------
function renderCategories() {
  const cats = (DATA && DATA.categories) || [];

  // รายการในหน้าตั้งค่า (ลบได้)
  const listEl = document.getElementById('categoryList');
  if (listEl) {
    listEl.innerHTML = cats.length
      ? cats.map(c =>
          '<span class="badge none" style="margin:0 6px 6px 0; display:inline-flex; align-items:center; gap:6px;">'
          + esc(c.name)
          + '<button data-action="removeCategory" data-id="' + esc(c.id) + '" style="border:none;background:none;color:var(--danger);cursor:pointer;font-size:12px;padding:0;">✕</button>'
          + '</span>'
        ).join('')
      : '<div class="item-sub" style="padding:4px 0;">ยังไม่มีหมวดหมู่ ลองเพิ่มดูสิ 🌱</div>';
  }

  // dropdown ในโมดัลเพิ่มรายการ
  const sel = document.getElementById('obligationCategory');
  if (sel) {
    const prevValue = sel.value;
    sel.innerHTML = '<option value="">— ไม่ระบุ —</option>'
      + cats.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('')
      + '<option value="__new__">+ เพิ่มหมวดหมู่ใหม่...</option>';
    if (cats.some(c => String(c.id) === prevValue) || prevValue === '') sel.value = prevValue;
  }
}
function handleCategorySelectChange() {
  const sel = document.getElementById('obligationCategory');
  const newInput = document.getElementById('obligationNewCategoryName');
  newInput.style.display = sel.value === '__new__' ? 'block' : 'none';
  if (sel.value === '__new__') newInput.focus();
}
async function addCategory() {
  const input = document.getElementById('newCategoryInput');
  const name = input.value.trim();
  if (!name) { showToast('ใส่ชื่อหมวดหมู่ก่อนนะ'); return; }
  const { error } = await sb.rpc('add_category', { p_name: name });
  if (error) return handleErr(error);
  input.value = '';
  loadData(); showToast('เพิ่มหมวดหมู่แล้ว 🏷️');
}
async function removeCategory(id) {
  if (!confirm('ลบหมวดหมู่นี้เลยไหม? (รายการที่ใช้หมวดนี้อยู่จะกลายเป็น "ไม่ระบุ")')) return;
  const { error } = await sb.rpc('delete_category', { p_id: id });
  if (error) return handleErr(error);
  loadData(); showToast('ลบหมวดหมู่แล้ว');
}

// ---------- SETTINGS ----------
async function saveSalary() {
  const val = Number(document.getElementById('salaryInput').value || 0);
  const month = currentMonthKey();
  const { error } = await sb.rpc('set_salary', { p_month: month, p_amount: val });
  if (error) return handleErr(error);
  loadData(); showToast('บันทึกเงินเดือนแล้ว');
}
function shareLine() {
  const debtLines = visibleObligations().filter(o => o.direction === 'payable' && !isDoneObl(o))
    .map(d => '• ' + d.name + '  ' + fmt(d.computedAmount)).join('\n');
  const recvLines = visibleObligations().filter(o => o.direction === 'receivable' && !isDoneObl(o))
    .map(r => {
      const p = DATA.people.find(x => String(x.id) === String(r.person_id));
      return '• ' + (p ? p.name : '') + ' (' + r.name + ')  ' + fmt(r.computedAmount);
    }).join('\n');
  const msg =
    '┏━━━━━━━━━━━━━━━┓\n'
    + '   💰 สรุปหนี้เดือน ' + thaiMonthLabel(DATA.month) + '\n'
    + '┗━━━━━━━━━━━━━━━┛\n\n'
    + '📌 ต้องจ่าย รวม ' + fmt(DATA.totalDebt) + '\n'
    + (debtLines || '（ไม่มี）') + '\n\n'
    + '📌 ต้องเก็บ รวม ' + fmt(DATA.totalReceivable) + '\n'
    + (recvLines || '（ไม่มี）') + '\n\n'
    + '✨ เหลือสุทธิประมาณ ' + fmt(DATA.netRemaining);
  const url = 'https://line.me/R/msg/text/?' + encodeURIComponent(msg);
  window.open(url, '_blank');
}

// ---------- EXPORT CSV ----------
function exportCSV() {
  if (!DATA) { showToast('ยังไม่มีข้อมูล'); return; }
  const header = ['ประเภท','ชื่อรายการ','รูปแบบการจ่าย','จำนวนเงิน','วันครบกำหนด','หมวดหมู่','สถานะ','บุคคล'];
  const rows = visibleObligations().map(o => {
    const person = o.direction === 'receivable'
      ? ((DATA.people.find(p => String(p.id) === String(o.person_id)) || {}).name || '')
      : '';
    const cat = (o.category_id && DATA.categories)
      ? ((DATA.categories.find(c => String(c.id) === String(o.category_id)) || {}).name || '')
      : '';
    return [
      o.direction === 'payable' ? 'ต้องจ่าย' : 'ต้องเก็บ',
      o.name, paymentTypeLabel(o), Number(o.computedAmount || 0),
      o.due_day || '', cat, isDoneObl(o) ? 'จบแล้ว' : 'ยังไม่จบ', person
    ];
  });
  const csvLines = [header, ...rows].map(r =>
    r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  );
  const blob = new Blob(['\uFEFF' + csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'สรุปหนี้_' + currentMonthKey() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('ดาวน์โหลด CSV แล้ว 📄');
}

// ---------- DARK MODE ----------
function applyDarkMode(enabled) {
  document.body.classList.toggle('dark', enabled);
  const btn = document.getElementById('darkModeToggle');
  if (btn) btn.textContent = enabled ? '☀️ โหมดสว่าง' : '🌙 โหมดมืด';
}
function toggleDarkMode() {
  const enabled = !document.body.classList.contains('dark');
  applyDarkMode(enabled);
  try { localStorage.setItem('darkMode', enabled ? '1' : '0'); } catch (e) {}
}
(function initDarkMode() {
  let saved = '0';
  try { saved = localStorage.getItem('darkMode') || '0'; } catch (e) {}
  applyDarkMode(saved === '1');
})();

// ---------- MODAL ----------
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('show'); });
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js");
    });
}
async function enableNotification() {
    console.log('[push] enableNotification called');
    if (!("Notification" in window)) { console.log('[push] Notification API not supported'); return; }
    const permission = await Notification.requestPermission();
    console.log('[push] permission:', permission);
    if (permission === "granted") {
        const { data: { user }, error: userErr } = await sb.auth.getUser();
        console.log('[push] user:', user, 'error:', userErr);
        if (user) subscribeToPush(user.id);
    }
}
