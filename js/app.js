/* ==========================================================================
   PresensiPro — Logika Antarmuka, Timer Shift, & Ekspor Laporan
   ========================================================================== */

let attendanceRecords = [];
let activeShiftRecord = null;
let lookupDebounceTimer = null;

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

  // Pulihkan NIP terakhir jika pegawai pernah membuka aplikasi di HP ini
  const lastNip = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
  if (lastNip) {
    document.getElementById("inputNip").value = lastNip;
    evaluateNipStatus(lastNip);
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

// ==================== DETEKSI OTOMATIS STATUS NIP ====================
function handleNipLookup() {
  const nip = document.getElementById("inputNip").value.trim();
  clearTimeout(lookupDebounceTimer);

  if (!nip) {
    resetShiftPanel();
    return;
  }

  localStorage.setItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP, nip);
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
  // Cari nama dari riwayat NIP sebelumnya jika input nama masih kosong
  const historyMatch = [...attendanceRecords].reverse().find(r => String(r.nip) === String(nip));
  const inputNamaEl = document.getElementById("inputNama");
  if (historyMatch && !inputNamaEl.value.trim()) {
    inputNamaEl.value = historyMatch.name;
  }

  // Cek catatan hari ini untuk NIP tersebut
  const todayRecord = attendanceRecords.find(r => String(r.nip) === String(nip) && r.date === todayStr);

  const card = document.getElementById("shiftStatusCard");
  const badge = document.getElementById("shiftBadge");
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");

  if (!todayRecord) {
    activeShiftRecord = null;
    card.classList.add("hidden");
    btnIn.disabled = false;
    btnOut.disabled = true;
    return;
  }

  activeShiftRecord = todayRecord;
  if (todayRecord.name) inputNamaEl.value = todayRecord.name;
  document.getElementById("displayCheckInTime").textContent = todayRecord.checkInTime;

  card.classList.remove("hidden", "bg-blue-50/70", "border-blue-200", "bg-emerald-50/70", "border-emerald-200");

  if (todayRecord.status === "Sedang Bekerja") {
    card.classList.add("bg-blue-50/70", "border-blue-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#003D79] text-white";
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-[#FFB700] animate-ping"></span> Sedang Bekerja`;
    btnIn.disabled = true;
    btnOut.disabled = false;
  } else {
    card.classList.add("bg-emerald-50/70", "border-emerald-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white";
    badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Selesai Shift (${todayRecord.checkOutTime})`;
    btnIn.disabled = true;
    btnOut.disabled = true;
  }

  updateActiveShiftTimer();
}

function resetShiftPanel() {
  activeShiftRecord = null;
  document.getElementById("shiftStatusCard").classList.add("hidden");
  document.getElementById("btnCheckIn").disabled = false;
  document.getElementById("btnCheckOut").disabled = true;
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
    const existing = attendanceRecords.find(r => String(r.nip) === String(nip) && r.date === todayStr);
    if (existing) {
      showToast("Anda sudah melakukan Check In hari ini.", "warning");
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
    evaluateNipStatus(nip);
    showToast(`Check In berhasil pukul ${timeFormatted} WIB`, "success");

    await DataService.pushRecord(newRecord);
  } else if (type === "checkout") {
    const idx = attendanceRecords.findIndex(r => String(r.nip) === String(nip) && r.date === todayStr && r.status === "Sedang Bekerja");
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
    showToast(`Check Out berhasil! Total kerja: ${formatMinutesToHm(durationMinutes)}`, "success");

    await DataService.pushRecord(record);
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

  // Update KPI
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
  attendanceRecords = result.records;
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
  const hasUrl = Boolean(DataService.getActiveSheetUrl());

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
  }, 3200);
}