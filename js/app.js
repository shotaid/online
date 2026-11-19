/* ==========================================================================
   PresensiPro — Logika Antarmuka, Timer Shift, & Deteksi Lintas Device (NIP/Nama)
   ========================================================================== */

let attendanceRecords = [];
let activeShiftRecord = null;
let lookupDebounceTimer = null;
let checkoutResetTimer = null;
let lastResolvedKey = "";
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

  const nipEl = document.getElementById("inputNip");
  const namaEl = document.getElementById("inputNama");

  if (nipEl) {
    nipEl.addEventListener("blur", () => triggerImmediateCloudLookup());
  }
  if (namaEl) {
    // Pasang listener otomatis meskipun belum ditambahkan manual di atribut HTML
    namaEl.addEventListener("input", () => handleNameLookup());
    namaEl.addEventListener("blur", () => triggerImmediateCloudLookup());
  }

  updateSyncBadge();

  if (typeof DataService !== "undefined") {
    const result = await DataService.fetchAllRecords();
    attendanceRecords = result.records || [];
    updateSyncBadge(result.source);

    const lastNip = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
    if (lastNip) {
      const stillWorking = attendanceRecords.find(
        r => String(r.nip).trim() === String(lastNip).trim() && r.status === "Sedang Bekerja"
      );
      if (stillWorking) {
        document.getElementById("inputNip").value = lastNip;
        evaluateEmployeeStatus({ nip: lastNip, notifyIfActive: true, autoFillPair: true });
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

// ==================== DETEKSI LINTAS DEVICE VIA NIP MAUPUN NAMA ====================
function handleNipLookup() {
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const nama = document.getElementById("inputNama").value.trim();

  if (!nip && !nama) {
    lastResolvedKey = "";
    resetShiftPanel();
    return;
  }

  // Jika NIP diganti manual setelah sebelumnya terisi otomatis, bersihkan nama lama agar tidak tertukar
  if (lastResolvedKey && lastResolvedKey.startsWith("nip:") && lastResolvedKey !== `nip:${nip}`) {
    document.getElementById("inputNama").value = "";
    lastNotifiedActiveId = "";
  }

  evaluateEmployeeStatus({ nip, name: document.getElementById("inputNama").value.trim(), notifyIfActive: true, autoFillPair: true });
  scheduleCloudLookup();
}

function handleNameLookup() {
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const nama = document.getElementById("inputNama").value.trim();

  if (!nip && !nama) {
    lastResolvedKey = "";
    resetShiftPanel();
    return;
  }

  // Jika Nama diubah manual dan sebelumnya NIP terisi otomatis dari nama lain, bersihkan NIP lama
  if (lastResolvedKey && lastResolvedKey.startsWith("name:") && lastResolvedKey !== `name:${nama.toLowerCase()}`) {
    document.getElementById("inputNip").value = "";
    lastNotifiedActiveId = "";
  }

  evaluateEmployeeStatus({ nip: document.getElementById("inputNip").value.trim(), name: nama, notifyIfActive: true, autoFillPair: true });
  scheduleCloudLookup();
}

function scheduleCloudLookup() {
  if (typeof DataService === "undefined" || !DataService.getActiveSheetUrl()) return;

  const spinner = document.getElementById("nipLookupSpinner");
  if (spinner) spinner.classList.remove("hidden");

  lookupDebounceTimer = setTimeout(async () => {
    await triggerImmediateCloudLookup();
  }, 350);
}

async function triggerImmediateCloudLookup() {
  const nip = document.getElementById("inputNip").value.trim();
  const name = document.getElementById("inputNama").value.trim();
  if (!nip && !name) return;

  if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
    const spinner = document.getElementById("nipLookupSpinner");
    if (spinner) spinner.classList.remove("hidden");

    try {
      const res = await DataService.fetchAllRecords();
      attendanceRecords = res.records || [];
      updateSyncBadge(res.source);

      const latestNip = document.getElementById("inputNip").value.trim();
      const latestName = document.getElementById("inputNama").value.trim();
      evaluateEmployeeStatus({ nip: latestNip, name: latestName, notifyIfActive: true, autoFillPair: true });
    } finally {
      if (spinner) spinner.classList.add("hidden");
    }
  }
}

function setActionButtonsState(mode) {
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  if (!btnIn || !btnOut) return;

  if (mode === "working") {
    // Tombol Check In abu-abu nonaktif; hanya tombol Check Out yang aktif
    btnIn.disabled = true;
    btnIn.classList.remove("btn-mandiri-primary", "text-white");
    btnIn.classList.add("bg-slate-300", "text-slate-500", "border-b-2", "border-slate-400", "cursor-not-allowed");

    btnOut.disabled = false;
    btnOut.classList.remove("bg-slate-300", "text-slate-500", "cursor-not-allowed");
    btnOut.classList.add("btn-mandiri-gold", "text-[#002855]");
  } else {
    btnIn.disabled = false;
    btnIn.classList.remove("bg-slate-300", "text-slate-500", "border-b-2", "border-slate-400", "cursor-not-allowed");
    btnIn.classList.add("btn-mandiri-primary", "text-white");

    btnOut.disabled = true;
    btnOut.classList.remove("btn-mandiri-gold", "text-[#002855]");
    btnOut.classList.add("bg-slate-300", "text-slate-500", "cursor-not-allowed");
  }
}

function evaluateEmployeeStatus({ nip = "", name = "", notifyIfActive = false, autoFillPair = true } = {}) {
  const cleanNip = String(nip).trim();
  const cleanNameLower = String(name).trim().toLowerCase();

  if (!cleanNip && !cleanNameLower) {
    resetShiftPanel();
    return;
  }

  const inputNipEl = document.getElementById("inputNip");
  const inputNamaEl = document.getElementById("inputNama");
  const todayStr = getTodayDateISO();

  // 1. Cari sesi aktif ("Sedang Bekerja") baik lewat NIP maupun Nama (lintas device & lintas hari)
  let activeSession = null;
  if (cleanNip) {
    activeSession = attendanceRecords.find(
      r => String(r.nip).trim() === cleanNip && r.status === "Sedang Bekerja"
    );
  }
  if (!activeSession && cleanNameLower.length >= 3) {
    // Prioritaskan kecocokan nama persis terlebih dahulu, lalu kecocokan parsial unik
    activeSession = attendanceRecords.find(
      r => String(r.name).trim().toLowerCase() === cleanNameLower && r.status === "Sedang Bekerja"
    );
    if (!activeSession) {
      const partialMatches = attendanceRecords.filter(
        r => r.status === "Sedang Bekerja" && String(r.name).trim().toLowerCase().includes(cleanNameLower)
      );
      if (partialMatches.length === 1) {
        activeSession = partialMatches[0];
      }
    }
  }

  // Auto-complete pasangan NIP / Nama dari riwayat jika belum ketemu sesi aktif
  if (!activeSession && autoFillPair) {
    if (cleanNip && !cleanNameLower) {
      const histByNip = [...attendanceRecords].reverse().find(r => String(r.nip).trim() === cleanNip);
      if (histByNip) {
        inputNamaEl.value = histByNip.name;
        lastResolvedKey = `nip:${cleanNip}`;
      }
    } else if (!cleanNip && cleanNameLower.length >= 3) {
      const exactHistByName = [...attendanceRecords].reverse().find(
        r => String(r.name).trim().toLowerCase() === cleanNameLower
      );
      if (exactHistByName) {
        inputNipEl.value = exactHistByName.nip;
        lastResolvedKey = `name:${cleanNameLower}`;
      }
    }
  }

  const card = document.getElementById("shiftStatusCard");
  const badge = document.getElementById("shiftBadge");

  card.classList.remove("hidden", "bg-blue-50/70", "border-blue-200", "bg-amber-50/80", "border-amber-300", "bg-emerald-50/70", "border-emerald-200");

  // Kondisi A: Ditemukan sesi aktif yang BELUM CHECK OUT
  if (activeSession) {
    activeShiftRecord = activeSession;

    if (autoFillPair) {
      if (!cleanNip) {
        inputNipEl.value = activeSession.nip;
        lastResolvedKey = `name:${cleanNameLower}`;
      }
      if (!cleanNameLower || cleanNameLower !== String(activeSession.name).trim().toLowerCase()) {
        inputNamaEl.value = activeSession.name;
        if (cleanNip) lastResolvedKey = `nip:${cleanNip}`;
      }
    }

    const dateNote = activeSession.date !== todayStr ? ` (${activeSession.date})` : "";
    document.getElementById("displayCheckInTime").textContent = `${activeSession.checkInTime}${dateNote}`;

    card.classList.add("bg-amber-50/80", "border-amber-300");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500 text-slate-950";
    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Belum Check Out (Masuk ${activeSession.checkInTime}${dateNote})`;

    setActionButtonsState("working");
    updateActiveShiftTimer();

    if (notifyIfActive && lastNotifiedActiveId !== activeSession.id) {
      lastNotifiedActiveId = activeSession.id;
      showToast(`Status Belum Check Out: ${activeSession.name} (${activeSession.nip}) sudah Check In pukul ${activeSession.checkInTime} WIB. Silakan tekan Check Out.`, "warning");
    }
    return;
  }

  // Kondisi B: Cek apakah hari ini sudah menyelesaikan shift sebelumnya
  const resolvedNipNow = inputNipEl.value.trim();
  const completedToday = resolvedNipNow
    ? [...attendanceRecords].reverse().find(
        r => String(r.nip).trim() === resolvedNipNow && r.date === todayStr && r.status === "Selesai"
      )
    : null;

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

  // Kondisi C: Belum ada catatan aktif
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
  lastResolvedKey = "";
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
    // Verifikasi real-time terakhir ke Google Sheets sebelum membuat catatan Check In baru
    if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
      const spinner = document.getElementById("nipLookupSpinner");
      if (spinner) spinner.classList.remove("hidden");
      const latest = await DataService.fetchAllRecords();
      attendanceRecords = latest.records || attendanceRecords;
      if (spinner) spinner.classList.add("hidden");
    }

    const activeExisting = attendanceRecords.find(
      r => (String(r.nip).trim() === nip || String(r.name).trim().toLowerCase() === name.toLowerCase()) && r.status === "Sedang Bekerja"
    );

    if (activeExisting) {
      lastNotifiedActiveId = activeExisting.id;
      evaluateEmployeeStatus({ nip: activeExisting.nip, name: activeExisting.name, notifyIfActive: false, autoFillPair: true });
      showToast(`Belum Check Out: ${activeExisting.name} (${activeExisting.nip}) tercatat aktif sejak pukul ${activeExisting.checkInTime} WIB.`, "warning");
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
    lastResolvedKey = `nip:${nip}`;
    lastNotifiedActiveId = newRecord.id;

    evaluateEmployeeStatus({ nip, name, notifyIfActive: false, autoFillPair: false });
    showToast(`Check In berhasil pukul ${timeFormatted} WIB`, "success");

    await DataService.pushRecord(newRecord);
  } else if (type === "checkout") {
    // Pastikan data terbaru termuat jika user langsung menekan Check Out dari device lain
    if (typeof DataService !== "undefined" && DataService.getActiveSheetUrl()) {
      const latest = await DataService.fetchAllRecords();
      attendanceRecords = latest.records || attendanceRecords;
    }

    const idx = attendanceRecords.findIndex(
      r => (String(r.nip).trim() === nip || String(r.name).trim().toLowerCase() === name.toLowerCase()) && r.status === "Sedang Bekerja"
    );
    if (idx === -1) {
      showToast("Data Check In aktif tidak ditemukan atau sudah Check Out sebelumnya.", "error");
      evaluateEmployeeStatus({ nip, name, notifyIfActive: false, autoFillPair: false });
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
    evaluateEmployeeStatus({ nip: record.nip, name: record.name, notifyIfActive: false, autoFillPair: false });
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
    const currentName = document.getElementById("inputNama").value.trim();
    if (currentNip || currentName) {
      evaluateEmployeeStatus({ nip: currentNip, name: currentName, notifyIfActive: false, autoFillPair: true });
    }
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
