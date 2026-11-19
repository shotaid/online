/* ==========================================================================
   PresensiPro — Logika Antarmuka, Timer Shift, & Sinkronisasi Lintas Device
   ========================================================================== */

let attendanceRecords = [];
let activeShiftRecord = null;
let lookupDebounceTimer = null;
let checkoutResetTimer = null;
let lastResolvedNip = "";
let lastNotifiedActiveId = "";

// Jalankan jam digital seketika agar tidak bergantung pada proses jaringan
function startLiveClock() {
  const clockEl = document.getElementById("liveClock");
  const dateEl = document.getElementById("liveDate");

  const tick = () => {
    const now = new Date();
    if (clockEl) {
      const h = String(now.getHours()).padStart(2, "0");
      const m = String(now.getMinutes()).padStart(2, "0");
      const s = String(now.getSeconds()).padStart(2, "0");
      clockEl.textContent = `${h}:${m}:${s}`;
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      });
    }
    updateActiveShiftTimer();
  };

  tick();
  setInterval(tick, 1000);
}

// Mulai jam langsung
startLiveClock();

// Inisialisasi data saat halaman siap
document.addEventListener("DOMContentLoaded", async () => {
  const footerYearEl = document.getElementById("footerYear");
  if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

  const codeBoxEl = document.getElementById("appsScriptCodeBox");
  if (codeBoxEl && typeof APPS_SCRIPT_TEMPLATE !== "undefined") {
    codeBoxEl.value = APPS_SCRIPT_TEMPLATE;
  }

  // Pastikan listener aktif pada input NIP & Nama untuk deteksi lintas perangkat
  const nipEl = document.getElementById("inputNip");
  const namaEl = document.getElementById("inputNama");
  if (nipEl) {
    nipEl.addEventListener("blur", () => triggerImmediateCloudLookup());
  }
  if (namaEl) {
    namaEl.addEventListener("focus", () => triggerImmediateCloudLookup());
  }

  updateSyncBadge();

  if (typeof DataService !== "undefined") {
    const result = await DataService.fetchAllRecords();
    attendanceRecords = result.records || [];
    updateSyncBadge(result.source);

    const lastNip = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
    if (lastNip) {
      const todayStr = getTodayDateISO();
      const stillWorking = attendanceRecords.find(
        r => String(r.nip) === String(lastNip) && r.date === todayStr && r.status === "Sedang Bekerja"
      );
      if (stillWorking) {
        document.getElementById("inputNip").value = lastNip;
        evaluateNipStatus(lastNip, true);
      } else {
        localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
      }
    }
  }
});

// ==================== TIMER SHIFT REAL-TIME ====================
function updateActiveShiftTimer() {
  if (!activeShiftRecord) return;

  const endTs = activeShiftRecord.checkOutTs ? activeShiftRecord.checkOutTs : Date.now();
  const diffSeconds = Math.max(0, Math.floor((endTs - activeShiftRecord.checkInTs) / 1000));
  const totalMinutes = Math.floor(diffSeconds / 60);

  const hrs = String(Math.floor(diffSeconds / 3600)).padStart(2, "0");
  const mins = String(Math.floor((diffSeconds % 3600) / 60)).padStart(2, "0");
  const secs = String(diffSeconds % 60).padStart(2, "0");

  document.getElementById("liveDurationTimer").textContent = `${hrs}:${mins}:${secs}`;

  const standardMins = (typeof APP_CONFIG !== "undefined") ? APP_CONFIG.STANDARD_WORK_MINUTES : 540;
  const overtimeMinutes = Math.max(0, totalMinutes - standardMins);
  document.getElementById("liveOvertimeTimer").textContent = formatMinutesToHm(overtimeMinutes);

  const progressPct = Math.min(100, Math.round((totalMinutes / standardMins) * 100));
  const progressBar = document.getElementById("shiftProgressBar");
  document.getElementById("shiftProgressPercent").textContent = `${progressPct}%`;
  progressBar.style.width = `${progressPct}%`;

  if (overtimeMinutes > 0) {
    progressBar.classList.remove("bg-[#003D79]");
    progressBar.classList.add("bg-[#FFB700]");
  } else {
    progressBar.classList.remove("bg-[#FFB700]");
    progressBar.classList.add("bg-[#003D79]");
  }
}

// ==================== DETEKSI OTOMATIS STATUS NIP LINTAS DEVICE ====================
function handleNipLookup() {
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const inputNamaEl = document.getElementById("inputNama");

  if (nip !== lastResolvedNip) {
    inputNamaEl.value = "";
    lastResolvedNip = nip;
    lastNotifiedActiveId = "";
  }

  if (!nip) {
    resetShiftPanel();
    return;
  }

  // Evaluasi cepat dari cache yang sudah dimuat saat halaman dibuka
  evaluateNipStatus(nip, true);

  // Tarik data terbaru dari Google Sheets agar deteksi lintas device selalu akurat
  if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
    document.getElementById("nipLookupSpinner").classList.remove("hidden");
    lookupDebounceTimer = setTimeout(async () => {
      await fetchAndApplyLatestNipStatus(nip);
    }, 350);
  }
}

async function triggerImmediateCloudLookup() {
  const nip = document.getElementById("inputNip").value.trim();
  if (!nip) return;
  if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
    document.getElementById("nipLookupSpinner").classList.remove("hidden");
    await fetchAndApplyLatestNipStatus(nip);
  }
}

async function fetchAndApplyLatestNipStatus(targetNip) {
  try {
    const res = await DataService.fetchAllRecords();
    attendanceRecords = res.records || [];
    updateSyncBadge(res.source);

    const currentNip = document.getElementById("inputNip").value.trim();
    if (currentNip === targetNip) {
      evaluateNipStatus(currentNip, true);
    }
  } finally {
    const spinner = document.getElementById("nipLookupSpinner");
    if (spinner) spinner.classList.add("hidden");
  }
}

function setActionButtonsState(mode) {
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  if (!btnIn || !btnOut) return;

  if (mode === "working") {
    // Tombol Check In menjadi abu-abu nonaktif; hanya tombol Check Out yang aktif
    btnIn.disabled = true;
    btnIn.classList.remove("btn-mandiri-primary", "text-white");
    btnIn.classList.add("bg-slate-300", "text-slate-500", "border-b-2", "border-slate-400", "cursor-not-allowed");

    btnOut.disabled = false;
    btnOut.classList.remove("bg-slate-300", "text-slate-500", "cursor-not-allowed");
    btnOut.classList.add("btn-mandiri-gold", "text-[#002855]");
  } else {
    // Mode siap Check In (belum absen atau sudah selesai shift sebelumnya)
    btnIn.disabled = false;
    btnIn.classList.remove("bg-slate-300", "text-slate-500", "border-b-2", "border-slate-400", "cursor-not-allowed");
    btnIn.classList.add("btn-mandiri-primary", "text-white");

    btnOut.disabled = true;
    btnOut.classList.remove("btn-mandiri-gold", "text-[#002855]");
    btnOut.classList.add("bg-slate-300", "text-slate-500", "cursor-not-allowed");
  }
}

function evaluateNipStatus(nip, notifyIfActive = false) {
  if (!nip) return resetShiftPanel();

  const todayStr = getTodayDateISO();
  const inputNamaEl = document.getElementById("inputNama");

  const historyMatch = [...attendanceRecords].reverse().find(r => String(r.nip) === String(nip));
  if (historyMatch && !inputNamaEl.value.trim()) {
    inputNamaEl.value = historyMatch.name;
    lastResolvedNip = nip;
  }

  const activeToday = attendanceRecords.find(
    r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja"
  );

  const completedToday = [...attendanceRecords].reverse().find(
    r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Selesai"
  );

  const card = document.getElementById("shiftStatusCard");
  const badge = document.getElementById("shiftBadge");

  card.classList.remove("hidden", "bg-blue-50/70", "border-blue-200", "bg-amber-50/80", "border-amber-300", "bg-emerald-50/70", "border-emerald-200");

  if (activeToday) {
    activeShiftRecord = activeToday;
    if (activeToday.name) inputNamaEl.value = activeToday.name;
    document.getElementById("displayCheckInTime").textContent = activeToday.checkInTime;

    card.classList.add("bg-amber-50/80", "border-amber-300");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500 text-slate-950";
    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Belum Check Out (Masuk ${activeToday.checkInTime})`;

    setActionButtonsState("working");
    updateActiveShiftTimer();

    // Tampilkan pemberitahuan sekali untuk sesi aktif ini
    if (notifyIfActive && lastNotifiedActiveId !== activeToday.id) {
      lastNotifiedActiveId = activeToday.id;
      showToast(`NIP ${nip} (${activeToday.name}) tercatat belum Check Out sejak pukul ${activeToday.checkInTime} WIB. Silakan tekan Check Out.`, "warning");
    }
    return;
  }

  if (completedToday) {
    activeShiftRecord = completedToday;
    document.getElementById("displayCheckInTime").textContent = completedToday.checkInTime;

    card.classList.add("bg-emerald-50/70", "border-emerald-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white";
    badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Selesai (${completedToday.checkOutTime}) — Siap Shift Baru`;

    setActionButtonsState("ready");
    updateActiveShiftTimer();
    return;
  }

  activeShiftRecord = null;
  card.classList.add("hidden");
  setActionButtonsState("ready");
}

function resetShiftPanel() {
  activeShiftRecord = null;
  lastNotifiedActiveId = "";
  document.getElementById("shiftStatusCard").classList.add("hidden");
  setActionButtonsState("ready");
}

function clearEmployeeForm() {
  document.getElementById("inputNip").value = "";
  document.getElementById("inputNama").value = "";
  lastResolvedNip = "";
  lastNotifiedActiveId = "";
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

  const todayStr = getTodayDateISO();

  if (type === "checkin") {
    // Sinkronisasi terakhir ke Google Sheets sebelum menyimpan Check In agar tidak bentrok antar device
    if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
      document.getElementById("nipLookupSpinner").classList.remove("hidden");
      const latest = await DataService.fetchAllRecords();
      attendanceRecords = latest.records || attendanceRecords;
      document.getElementById("nipLookupSpinner").classList.add("hidden");
    }

    const activeExisting = attendanceRecords.find(
      r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja"
    );
    if (activeExisting) {
      lastNotifiedActiveId = activeExisting.id;
      evaluateNipStatus(nip, false);
      showToast(`Gagal Check In: Anda belum Check Out dari sesi pukul ${activeExisting.checkInTime} WIB di perangkat sebelumnya.`, "warning");
      return;
    }

    const now = new Date();
    const nowTs = now.getTime();
    const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

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
    lastNotifiedActiveId = newRecord.id;

    evaluateNipStatus(nip, false);
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

    const now = new Date();
    const nowTs = now.getTime();
    const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

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
    evaluateNipStatus(nip, false);
    showToast(`Check Out berhasil (${formatMinutesToHm(durationMinutes)}). Form akan bersih otomatis...`, "success");

    await DataService.pushRecord(record);

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
    if (currentNip) evaluateNipStatus(currentNip, false);
  }
}

async function syncFromCloud(showNotification = true) {
  const icon = document.getElementById("refreshIcon");
  if (icon) icon.classList.add("fa-spin");

  const result = await DataService.fetchAllRecords();
  attendanceRecords = result.records || [];
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
        <td class="py-3 px-4 font-mono font-bold text-[#002855] whitespace-nowrap">${escapeHtml(rec.nip)}</td>
        <td class="py-3 px-4 font-semibold text-slate-800 whitespace-nowrap">${escapeHtml(rec.name)}</td>
        <td class="py-3 px-4 font-mono text-xs whitespace-nowrap">${rec.checkInTime}</td>
        <td class="py-3 px-4 font-mono text-xs whitespace-nowrap">${rec.checkOutTime || "-"}</td>
        <td class="py-3 px-4 font-medium whitespace-nowrap">${formatMinutesToHm(durMins)}</td>
        <td class="py-3 px-4 whitespace-nowrap">${otBadge}</td>
        <td class="py-3 px-4 whitespace-nowrap">${statusBadge}</td>
        <td class="py-3 px-4 text-center whitespace-nowrap">
          <button onclick="deleteRecord('${rec.id}')" title="Hapus catatan" class="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>`;
  }).join("");
}

function resetAdminFilter() {
  document.getElementById("adminSearchInput").value = "";
  document.getElementById("adminDateFilter").value = "";
  renderAdminTable();
}

async function deleteRecord(id) {
  if (!confirm("Hapus catatan absensi ini?")) return;

  attendanceRecords = attendanceRecords.filter(r => String(r.id) !== String(id));
  DataService.saveLocalRecords(attendanceRecords);
  renderAdminTable();
  showToast("Catatan berhasil dihapus.", "success");

  await DataService.deleteRecordCloud(id);
}

// ==================== EKSPOR EXCEL & CSV ====================
function exportData(format) {
  const filtered = getFilteredRecords();
  if (filtered.length === 0) {
    showToast("Tidak ada data untuk diekspor.", "warning");
    return;
  }

  const rows = filtered.map((rec, index) => {
    let durMins = rec.durationMinutes;
    let otMins = rec.overtimeMinutes;
    if (rec.status === "Sedang Bekerja") {
      durMins = Math.max(0, Math.floor((Date.now() - rec.checkInTs) / 60000));
      otMins = Math.max(0, durMins - APP_CONFIG.STANDARD_WORK_MINUTES);
    }

    return {
      "No": index + 1,
      "Tanggal": rec.date,
      "NIP": rec.nip,
      "Nama Lengkap": rec.name,
      "Check In": rec.checkInTime,
      "Check Out": rec.checkOutTime || "-",
      "Total Durasi": formatMinutesToHm(durMins),
      "Durasi (Menit)": durMins,
      "Lembur": formatMinutesToHm(otMins),
      "Lembur (Menit)": otMins,
      "Status": rec.status
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Rekap Absensi");

  const fileStamp = getTodayDateISO();
  if (format === "csv") {
    XLSX.writeFile(workbook, `Rekap_Absensi_${fileStamp}.csv`, { bookType: "csv" });
  } else {
    XLSX.writeFile(workbook, `Rekap_Absensi_${fileStamp}.xlsx`);
  }
  showToast(`File ${format.toUpperCase()} berhasil diunduh.`, "success");
}

// ==================== MODAL KONFIGURASI GOOGLE SHEETS ====================
function openSheetModal() {
  document.getElementById("sheetUrlInput").value = DataService.getActiveSheetUrl();
  document.getElementById("sheetConfigModal").classList.remove("hidden");
}

function closeSheetModal() {
  document.getElementById("sheetConfigModal").classList.add("hidden");
}

function copyAppsScriptCode() {
  const box = document.getElementById("appsScriptCodeBox");
  box.select();
  navigator.clipboard.writeText(box.value);
  showToast("Kode Code.gs berhasil disalin.", "success");
}

async function saveAndTestSheetUrl() {
  const url = document.getElementById("sheetUrlInput").value.trim();
  if (url && !url.startsWith("https://script.google.com/")) {
    showToast("URL harus diawali https://script.google.com/", "error");
    return;
  }

  DataService.setSheetUrl(url);
  if (!url) {
    updateSyncBadge("local");
    closeSheetModal();
    showToast("URL dihapus. Beralih ke mode lokal.", "warning");
    return;
  }

  showToast("Menguji koneksi ke Google Sheets...", "info");
  const result = await DataService.fetchAllRecords();
  attendanceRecords = result.records || [];
  updateSyncBadge(result.source);
  renderAdminTable();

  if (result.source === "cloud") {
    closeSheetModal();
    showToast("Berhasil terhubung ke Google Sheets!", "success");
  } else {
    showToast("URL tersimpan, namun gagal membaca data. Pastikan akses Web App disetel ke 'Anyone'.", "warning");
  }
}

function updateSyncBadge(sourceState) {
  const dot = document.getElementById("syncDot");
  const text = document.getElementById("syncText");
  if (!dot || !text) return;

  const hasUrl = (typeof DataService !== "undefined") && Boolean(DataService.getActiveSheetUrl());

  if (!hasUrl) {
    dot.className = "w-2 h-2 rounded-full bg-amber-400";
    text.textContent = "Mode Lokal";
    return;
  }

  if (sourceState === "offline-cache") {
    dot.className = "w-2 h-2 rounded-full bg-orange-400";
    text.textContent = "Cache Offline";
  } else {
    dot.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse";
    text.textContent = "Cloud Sync Aktif";
  }
}

// ==================== HELPER UTILITIES ====================
function getTodayDateISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatMinutesToHm(totalMins) {
  const mins = Math.max(0, Math.floor(totalMins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}j ${m}m`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const colors = {
    success: "bg-emerald-600 text-white",
    error: "bg-red-600 text-white",
    warning: "bg-amber-500 text-slate-950",
    info: "bg-[#002855] text-white"
  };

  const toast = document.createElement("div");
  toast.className = `toast-enter pointer-events-auto px-4 py-3 rounded-xl shadow-lg text-xs sm:text-sm font-semibold flex items-center justify-between gap-3 ${colors[type] || colors.info}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.25s ease";
    setTimeout(() => toast.remove(), 250);
  }, 4500);
}
