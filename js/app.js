/* ==========================================================================
   PresensiPro — Logika Antarmuka, Timer Shift, & Ekspor Laporan
   ========================================================================== */

let attendanceRecords = [];
let activeShiftRecord = null;
let lookupDebounceTimer = null;
let checkoutResetTimer = null;
let lastResolvedNip = "";

// Inisialisasi saat halaman dimuat
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("footerYear").textContent = new Date().getFullYear();
  document.getElementById("appsScriptCodeBox").value = APPS_SCRIPT_TEMPLATE;

  updateSyncBadge();
  startLiveClock();

  // Muat data awal dari Cloud / Lokal
  const result = await DataService.fetchAllRecords();
  attendanceRecords = result.records;
  updateSyncBadge(result.source);

  // Pulihkan NIP terakhir hanya jika shift-nya masih aktif (belum Check Out)
  const lastNip = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
  if (lastNip) {
    const todayStr = getTodayDateISO();
    const stillWorking = attendanceRecords.find(
      r => String(r.nip) === String(lastNip) && r.date === todayStr && r.status === "Sedang Bekerja"
    );
    if (stillWorking) {
      document.getElementById("inputNip").value = lastNip;
      evaluateNipStatus(lastNip);
    } else {
      localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
    }
  }
});

// ==================== JAM DIGITAL & TIMER SHIFT REAL-TIME ====================
function startLiveClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById("liveClock").textContent = now.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).replace(/\./g, ":");

    document.getElementById("liveDate").textContent = now.toLocaleDateString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });

    updateActiveShiftTimer();
  };
  tick();
  setInterval(tick, 1000);
}

function updateActiveShiftTimer() {
  if (!activeShiftRecord) return;

  const endTs = activeShiftRecord.checkOutTs ? activeShiftRecord.checkOutTs : Date.now();
  const diffSeconds = Math.max(0, Math.floor((endTs - activeShiftRecord.checkInTs) / 1000));
  const totalMinutes = Math.floor(diffSeconds / 60);

  const hrs = String(Math.floor(diffSeconds / 3600)).padStart(2, "0");
  const mins = String(Math.floor((diffSeconds % 3600) / 60)).padStart(2, "0");
  const secs = String(diffSeconds % 60).padStart(2, "0");

  document.getElementById("liveDurationTimer").textContent = `${hrs}:${mins}:${secs}`;

  const overtimeMinutes = Math.max(0, totalMinutes - APP_CONFIG.STANDARD_WORK_MINUTES);
  document.getElementById("liveOvertimeTimer").textContent = formatMinutesToHm(overtimeMinutes);

  const progressPct = Math.min(100, Math.round((totalMinutes / APP_CONFIG.STANDARD_WORK_MINUTES) * 100));
  const progressBar = document.getElementById("shiftProgressBar");
  document.getElementById("shiftProgressPercent").textContent = `${progressPct}\%`; progressBar.style.width = `${progressPct}%`;

  if (overtimeMinutes > 0) {
    progressBar.classList.remove("bg-[#003D79]");
    progressBar.classList.add("bg-[#FFB700]");
  } else {
    progressBar.classList.remove("bg-[#FFB700]");
    progressBar.classList.add("bg-[#003D79]");
  }
}

// ==================== DETEKSI OTOMATIS STATUS NIP ====================
function handleNipLookup() {
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const inputNamaEl = document.getElementById("inputNama");

  // Bersihkan nama lama jika NIP berubah ke nomor yang berbeda
  if (nip !== lastResolvedNip) {
    inputNamaEl.value = "";
    lastResolvedNip = nip;
  }

  if (!nip) {
    resetShiftPanel();
    return;
  }

  evaluateNipStatus(nip);

  // Sinkronisasi ringan di latar belakang jika terhubung ke Google Sheets
  if (DataService.getActiveSheetUrl()) {
    document.getElementById("nipLookupSpinner").classList.remove("hidden");
    lookupDebounceTimer = setTimeout(async () => {
      const res = await DataService.fetchAllRecords();
      attendanceRecords = res.records;
      updateSyncBadge(res.source);
      evaluateNipStatus(document.getElementById("inputNip").value.trim());
      document.getElementById("nipLookupSpinner").classList.add("hidden");
    }, 600);
  }
}

function evaluateNipStatus(nip) {
  if (!nip) return resetShiftPanel();

  const todayStr = getTodayDateISO();
  const inputNamaEl = document.getElementById("inputNama");

  // Isi nama otomatis dari riwayat jika ditemukan NIP yang sama
  const historyMatch = [...attendanceRecords].reverse().find(r => String(r.nip) === String(nip));
  if (historyMatch && !inputNamaEl.value.trim()) {
    inputNamaEl.value = historyMatch.name;
    lastResolvedNip = nip;
  }

  // Cari sesi yang masih aktif ("Sedang Bekerja") hari ini
  const activeToday = attendanceRecords.find(
    r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja"
  );

  // Cari sesi terakhir yang sudah selesai hari ini (jika ada)
  const completedToday = [...attendanceRecords].reverse().find(
    r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Selesai"
  );

  const card = document.getElementById("shiftStatusCard");
  const badge = document.getElementById("shiftBadge");
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");

  card.classList.remove("hidden", "bg-blue-50/70", "border-blue-200", "bg-emerald-50/70", "border-emerald-200");

  if (activeToday) {
    activeShiftRecord = activeToday;
    if (activeToday.name) inputNamaEl.value = activeToday.name;
    document.getElementById("displayCheckInTime").textContent = activeToday.checkInTime;

    card.classList.add("bg-blue-50/70", "border-blue-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#003D79] text-white";
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-[#FFB700] animate-ping"></span> Sedang Bekerja`;
    btnIn.disabled = true;
    btnOut.disabled = false;
    updateActiveShiftTimer();
    return;
  }

  if (completedToday) {
    activeShiftRecord = completedToday;
    document.getElementById("displayCheckInTime").textContent = completedToday.checkInTime;

    card.classList.add("bg-emerald-50/70", "border-emerald-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white";
    badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Selesai (${completedToday.checkOutTime}) — Siap Shift Baru`;
    btnIn.disabled = false;
    btnOut.disabled = true;
    updateActiveShiftTimer();
    return;
  }

  activeShiftRecord = null;
  card.classList.add("hidden");
  btnIn.disabled = false;
  btnOut.disabled = true;
}

function resetShiftPanel() {
  activeShiftRecord = null;
  document.getElementById("shiftStatusCard").classList.add("hidden");
  document.getElementById("btnCheckIn").disabled = false;
  document.getElementById("btnCheckOut").disabled = true;
}

function clearEmployeeForm() {
  document.getElementById("inputNip").value = "";
  document.getElementById("inputNama").value = "";
  lastResolvedNip = "";
  localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
  resetShiftPanel();
}

// ==================== PROSES CHECK IN & CHECK OUT ====================
async function processAttendance(type) {
  const nip = document.getElementById("inputNip").value.trim();
  const name = document.getElementById("inputNama").value.trim();

  if (!nip || !name) {
    showToast("NIP dan Nama Lengkap wajib diisi.", "error");
    return;
  }

  const now = new Date();
  const nowTs = now.getTime();
  const timeFormatted = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).replace(/\./g, ":");
  const todayStr = getTodayDateISO();

  if (type === "checkin") {
    const activeExisting = attendanceRecords.find(
      r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja"
    );
    if (activeExisting) {
      showToast("Shift Anda masih aktif. Silakan Check Out terlebih dahulu.", "warning");
      evaluateNipStatus(nip);
      return;
    }

    const newRecord = {
      id: `${todayStr}_${nip}_${nowTs}`,
      date: todayStr,
      nip,
      name,
      checkInTime: timeFormatted,
      checkOutTime: "-",
      checkInTs: nowTs,
      checkOutTs: null,
      durationMinutes: 0,
      overtimeMinutes: 0,
      status: "Sedang Bekerja"
    };

    attendanceRecords.unshift(newRecord);
    DataService.saveLocalRecords(attendanceRecords);
    localStorage.setItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP, nip);
    lastResolvedNip = nip;

    evaluateNipStatus(nip);
    showToast(`Check In berhasil pukul ${timeFormatted} WIB`, "success");

    await DataService.pushRecord(newRecord);
  } else if (type === "checkout") {
    const idx = attendanceRecords.findIndex(
      r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja"
    );
    if (idx === -1) {
      showToast("Data Check In aktif hari ini tidak ditemukan.", "error");
      return;
    }

    const record = attendanceRecords[idx];
    const durationMinutes = Math.max(1, Math.floor((nowTs - record.checkInTs) / 60000));
    const overtimeMinutes = Math.max(0, durationMinutes - APP_CONFIG.STANDARD_WORK_MINUTES);

    record.checkOutTime = timeFormatted;
    record.checkOutTs = nowTs;
    record.durationMinutes = durationMinutes;
    record.overtimeMinutes = overtimeMinutes;
    record.status = "Selesai";

    attendanceRecords[idx] = record;
    DataService.saveLocalRecords(attendanceRecords);
    evaluateNipStatus(nip);
    showToast(`Check Out berhasil (${formatMinutesToHm(durationMinutes)}). Form akan bersih otomatis...`, "success");

    await DataService.pushRecord(record);

    // Kosongkan NIP & Nama setelah 2,5 detik agar siap untuk input berikutnya
    clearTimeout(checkoutResetTimer);
    checkoutResetTimer = setTimeout(() => {
      clearEmployeeForm();
    }, 2500);
  }
}

// ==================== NAVIGASI VIEW & DASHBOARD ADMIN ====================
function openAdminGate() {
  const adminView = document.getElementById("adminView");
  if (!adminView.classList.contains("hidden")) return;

  document.getElementById("adminPinInput").value = "";
  document.getElementById("adminPinModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("adminPinInput").focus(), 100);
}

function closeAdminGate() {
  document.getElementById("adminPinModal").classList.add("hidden");
}

function verifyAdminPin() {
  const entered = document.getElementById("adminPinInput").value.trim();
  if (entered === APP_CONFIG.ADMIN_PIN) {
    closeAdminGate();
    switchView("admin");
  } else {
    showToast("PIN Admin salah! (Default: 123456)", "error");
  }
}

async function switchView(viewName) {
  const empView = document.getElementById("employeeView");
  const admView = document.getElementById("adminView");
  const backBtn = document.getElementById("headerBackHomeBtn");
  const adminBtn = document.getElementById("adminNavBtn");

  if (viewName === "admin") {
    empView.classList.add("hidden");
    admView.classList.remove("hidden");
    backBtn.classList.remove("hidden");
    backBtn.classList.add("flex");
    adminBtn.classList.add("hidden");

    await syncFromCloud(false);
    renderAdminTable();
  } else {
    admView.classList.add("hidden");
    empView.classList.remove("hidden");
    backBtn.classList.add("hidden");
    backBtn.classList.remove("flex");
    adminBtn.classList.remove("hidden");

    const currentNip = document.getElementById("inputNip").value.trim();
    if (currentNip) evaluateNipStatus(currentNip);
  }
}

async function syncFromCloud(showNotification = true) {
  const icon = document.getElementById("refreshIcon");
  if (icon) icon.classList.add("fa-spin");

  const result = await DataService.fetchAllRecords();
  attendanceRecords = result.records;
  updateSyncBadge(result.source);
  renderAdminTable();

  if (icon) icon.classList.remove("fa-spin");
  if (showNotification) {
    showToast(result.source === "cloud" ? "Data tersinkronisasi dengan Google Sheets." : "Menampilkan data penyimpanan lokal.", "success");
  }
}

function getFilteredRecords() {
  const keyword = (document.getElementById("adminSearchInput").value || "").toLowerCase().trim();
  const dateFilter = document.getElementById("adminDateFilter").value;

  return attendanceRecords.filter(rec => {
    const matchKeyword = !keyword || String(rec.nip).toLowerCase().includes(keyword) || String(rec.name).toLowerCase().includes(keyword);
    const matchDate = !dateFilter || rec.date === dateFilter;
    return matchKeyword && matchDate;
  });
}

function renderAdminTable() {
  const filtered = getFilteredRecords();
  const tbody = document.getElementById("adminTableBody");

  let workingCount = 0;
  let completedCount = 0;
  let totalOvertimeMins = 0;

  filtered.forEach(r => {
    if (r.status === "Sedang Bekerja") {
      workingCount++;
      const runningMins = Math.max(0, Math.floor((Date.now() - r.checkInTs) / 60000));
      totalOvertimeMins += Math.max(0, runningMins - APP_CONFIG.STANDARD_WORK_MINUTES);
    } else {
      completedCount++;
      totalOvertimeMins += Number(r.overtimeMinutes) || 0;
    }
  });

  document.getElementById("kpiTotal").textContent = filtered.length;
  document.getElementById("kpiWorking").textContent = workingCount;
  document.getElementById("kpiCompleted").textContent = completedCount;
  document.getElementById("kpiOvertime").textContent = formatMinutesToHm(totalOvertimeMins);

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="py-10 text-center text-slate-400 text-sm">
          <i class="fa-regular fa-folder-open text-2xl mb-2 block"></i>
          Belum ada catatan absensi yang sesuai dengan filter.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(rec => {
    let durMins = rec.durationMinutes;
    let otMins = rec.overtimeMinutes;

    if (rec.status === "Sedang Bekerja") {
      durMins = Math.max(0, Math.floor((Date.now() - rec.checkInTs) / 60000));
      otMins = Math.max(0, durMins - APP_CONFIG.STANDARD_WORK_MINUTES);
    }

    const statusBadge = rec.status === "Sedang Bekerja"
      ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-[#003D79]"><span class="w-1.5 h-1.5 rounded-full bg-[#0072CE] animate-pulse"></span>Aktif</span>`
      : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">Selesai</span>`;

    const otBadge = otMins > 0
      ? `<span class="font-bold text-amber-600">+${formatMinutesToHm(otMins)}</span>`
      : `<span class="text-slate-400">0j 0m</span>`;

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap">${rec.date}</td>
        <td class="py-3 px-4 font-mono font-bold text-[#0
