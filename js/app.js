/* ==========================================================================
   PresensiPro — Logika Antarmuka, Siklus Shift Berulang, & Deteksi Lintas Device
   ========================================================================== */

let attendanceRecords = [];
let activeShiftRecord = null;
let lookupDebounceTimer = null;
let checkoutResetTimer = null;
let lastNotifiedActiveId = "";
let isProcessingAttendance = false;

// Helper fetch dengan batas waktu agar tombol tidak pernah macet
async function fetchCloudWithTimeout(timeoutMs = 4000) {
  if (typeof DataService === "undefined" || !DataService.getActiveSheetUrl()) {
    return null;
  }
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cloud timeout")), timeoutMs)
    );
    return await Promise.race([DataService.fetchAllRecords(), timeoutPromise]);
  } catch (err) {
    console.warn("Sinkronisasi cloud dilewati/timeout:", err.message);
    return null;
  }
}

// Normalisasi pengecekan apakah sesi masih aktif (Belum Check Out)
function isRecordActive(rec) {
  if (!rec) return false;
  const st = String(rec.status || "").trim().toLowerCase();
  const hasNoCheckout =
    !rec.checkOutTs &&
    (!rec.checkOutTime ||
      String(rec.checkOutTime).trim() === "-" ||
      String(rec.checkOutTime).trim() === "");
  return st === "sedang bekerja" || (st !== "selesai" && hasNoCheckout && Boolean(rec.checkInTs));
}

// Jalankan jam digital seketika
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

startLiveClock();

// Inisialisasi saat halaman siap
document.addEventListener("DOMContentLoaded", async () => {
  const footerYearEl = document.getElementById("footerYear");
  if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

  const codeBoxEl = document.getElementById("appsScriptCodeBox");
  if (codeBoxEl && typeof APPS_SCRIPT_TEMPLATE !== "undefined") {
    codeBoxEl.value = APPS_SCRIPT_TEMPLATE;
  }

  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  if (btnIn) btnIn.setAttribute("type", "button");
  if (btnOut) btnOut.setAttribute("type", "button");

  const namaEl = document.getElementById("inputNama");
  if (namaEl) {
    namaEl.addEventListener("input", handleNameLookup);
  }

  if (typeof DataService !== "undefined") {
    attendanceRecords = DataService.getLocalRecords() || [];
  }

  updateSyncBadge();

  // Sinkronisasi awal dari Google Sheets (maksimal 4 detik)
  const result = await fetchCloudWithTimeout(4000);
  if (result && Array.isArray(result.records)) {
    attendanceRecords = result.records;
    updateSyncBadge(result.source);

    const lastNip = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
    if (lastNip) {
      const stillWorking = attendanceRecords.find(
        r => String(r.nip).trim() === String(lastNip).trim() && isRecordActive(r)
      );
      if (stillWorking) {
        document.getElementById("inputNip").value = lastNip;
        document.getElementById("inputNama").value = stillWorking.name || "";
        evaluateEmployeeStatus({ notifyToast: true, autoFillPair: true });
      } else {
        localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
      }
    }
  }
});

// ==================== TIMER SHIFT REAL-TIME ====================
function updateActiveShiftTimer() {
  if (!activeShiftRecord) return;

  const endTs = activeShiftRecord.checkOutTs ? Number(activeShiftRecord.checkOutTs) : Date.now();
  const startTs = Number(activeShiftRecord.checkInTs) || Date.now();
  const diffSeconds = Math.max(0, Math.floor((endTs - startTs) / 1000));
  const totalMinutes = Math.floor(diffSeconds / 60);

  const hrs = String(Math.floor(diffSeconds / 3600)).padStart(2, "0");
  const mins = String(Math.floor((diffSeconds % 3600) / 60)).padStart(2, "0");
  const secs = String(diffSeconds % 60).padStart(2, "0");

  const durEl = document.getElementById("liveDurationTimer");
  if (durEl) durEl.textContent = `${hrs}:${mins}:${secs}`;

  const standardMins = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.STANDARD_WORK_MINUTES : 540;
  const overtimeMinutes = Math.max(0, totalMinutes - standardMins);
  const otEl = document.getElementById("liveOvertimeTimer");
  if (otEl) otEl.textContent = formatMinutesToHm(overtimeMinutes);

  const progressPct = Math.min(100, Math.round((totalMinutes / standardMins) * 100));
  const progressBar = document.getElementById("shiftProgressBar");
  const pctEl = document.getElementById("shiftProgressPercent");
  if (pctEl) pctEl.textContent = `${progressPct}%`;

  if (progressBar) {
    progressBar.style.width = `${progressPct}%`;
    if (overtimeMinutes > 0) {
      progressBar.classList.remove("bg-[#003D79]");
      progressBar.classList.add("bg-[#FFB700]");
    } else {
      progressBar.classList.remove("bg-[#FFB700]");
      progressBar.classList.add("bg-[#003D79]");
    }
  }
}

// ==================== DETEKSI LINTAS DEVICE VIA NIP MAUPUN NAMA ====================
function handleNipLookup() {
  if (isProcessingAttendance) return;
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const nama = document.getElementById("inputNama").value.trim();

  if (!nip && !nama) {
    resetShiftPanel();
    return;
  }

  evaluateEmployeeStatus({ notifyToast: true, autoFillPair: true });
  scheduleCloudLookup();
}

function handleNameLookup() {
  if (isProcessingAttendance) return;
  clearTimeout(checkoutResetTimer);
  clearTimeout(lookupDebounceTimer);

  const nip = document.getElementById("inputNip").value.trim();
  const nama = document.getElementById("inputNama").value.trim();

  if (!nip && !nama) {
    resetShiftPanel();
    return;
  }

  evaluateEmployeeStatus({ notifyToast: true, autoFillPair: true });
  scheduleCloudLookup();
}

function scheduleCloudLookup() {
  if (typeof DataService === "undefined" || !DataService.getActiveSheetUrl()) return;

  const spinner = document.getElementById("nipLookupSpinner");
  if (spinner) spinner.classList.remove("hidden");

  lookupDebounceTimer = setTimeout(async () => {
    try {
      if (isProcessingAttendance) return;
      const res = await fetchCloudWithTimeout(4000);
      if (res && Array.isArray(res.records)) {
        attendanceRecords = res.records;
        updateSyncBadge(res.source);
        evaluateEmployeeStatus({ notifyToast: true, autoFillPair: true });
      }
    } finally {
      if (spinner) spinner.classList.add("hidden");
    }
  }, 350);
}

function setActionButtonsState(mode) {
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  if (!btnIn || !btnOut) return;

  if (mode === "working") {
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

function evaluateEmployeeStatus({ notifyToast = false, autoFillPair = true } = {}) {
  const inputNipEl = document.getElementById("inputNip");
  const inputNamaEl = document.getElementById("inputNama");
  const cleanNip = inputNipEl.value.trim();
  const cleanName = inputNamaEl.value.trim();
  const cleanNameLower = cleanName.toLowerCase();

  if (!cleanNip && !cleanNameLower) {
    resetShiftPanel();
    return;
  }

  const todayStr = getTodayDateISO();

  // 1. Cari apakah masih ada sesi aktif (BELUM CHECK OUT) untuk NIP atau Nama ini
  let activeSession = null;
  if (cleanNip) {
    activeSession = attendanceRecords.find(
      r => String(r.nip).trim() === cleanNip && isRecordActive(r)
    );
  }
  if (!activeSession && cleanNameLower.length >= 3) {
    activeSession = attendanceRecords.find(
      r => String(r.name).trim().toLowerCase() === cleanNameLower && isRecordActive(r)
    );
    if (!activeSession) {
      const partialMatches = attendanceRecords.filter(
        r => isRecordActive(r) && String(r.name).trim().toLowerCase().includes(cleanNameLower)
      );
      if (partialMatches.length === 1) {
        activeSession = partialMatches[0];
      }
    }
  }

  // Lengkapi pasangan input yang masih kosong dari riwayat
  if (!activeSession && autoFillPair) {
    if (cleanNip && !cleanNameLower) {
      const histByNip = [...attendanceRecords].reverse().find(r => String(r.nip).trim() === cleanNip);
      if (histByNip) inputNamaEl.value = histByNip.name;
    } else if (!cleanNip && cleanNameLower.length >= 3) {
      const histByName = [...attendanceRecords].reverse().find(
        r => String(r.name).trim().toLowerCase() === cleanNameLower
      );
      if (histByName) inputNipEl.value = histByName.nip;
    }
  }

  const card = document.getElementById("shiftStatusCard");
  const badge = document.getElementById("shiftBadge");

  card.classList.remove("hidden", "bg-blue-50/70", "border-blue-200", "bg-amber-50", "border-amber-400", "bg-emerald-50/70", "border-emerald-200");

  // KONDISI 1: MASIH AKTIF / BELUM CHECK OUT -> Kunci Check In, Wajib Check Out dulu
  if (activeSession) {
    activeShiftRecord = activeSession;

    if (autoFillPair) {
      if (!cleanNip) inputNipEl.value = activeSession.nip;
      if (!cleanNameLower) inputNamaEl.value = activeSession.name;
    }

    const dateNote = activeSession.date !== todayStr ? ` (${activeSession.date})` : "";
    document.getElementById("displayCheckInTime").textContent = `${activeSession.checkInTime}${dateNote}`;

    card.classList.add("bg-amber-50", "border-amber-400");
    badge.className = "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-amber-500 text-slate-950 shadow-sm";
    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> BELUM CHECK OUT — Silakan Check Out`;

    setActionButtonsState("working");
    updateActiveShiftTimer();

    if (notifyToast && lastNotifiedActiveId !== activeSession.id) {
      lastNotifiedActiveId = activeSession.id;
      showToast(`Peringatan: ${activeSession.name} (${activeSession.nip}) belum melakukan Check Out sejak pukul ${activeSession.checkInTime} WIB.`, "warning");
    }
    return;
  }

  // KONDISI 2: SEMUA SESI SEBELUMNYA SUDAH CHECK OUT -> Tampilkan ringkasan sesi terakhir & aktifkan Check In lagi
  const resolvedNipNow = inputNipEl.value.trim();
  const completedSessionsToday = resolvedNipNow
    ? attendanceRecords.filter(
        r => String(r.nip).trim() === resolvedNipNow && r.date === todayStr && !isRecordActive(r)
      )
    : [];

  if (completedSessionsToday.length > 0) {
    const latestCompleted = completedSessionsToday[0];
    activeShiftRecord = latestCompleted;
    lastNotifiedActiveId = "";
    document.getElementById("displayCheckInTime").textContent = latestCompleted.checkInTime;

    card.classList.add("bg-emerald-50/70", "border-emerald-200");
    badge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white";
    badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${completedSessionsToday.length} Sesi Selesai (${latestCompleted.checkOutTime}) — Siap Check In Lagi`;

    setActionButtonsState("ready");
    updateActiveShiftTimer();
    return;
  }

  // KONDISI 3: BELUM ADA ABSENSI HARI INI -> Siap Check In
  activeShiftRecord = null;
  lastNotifiedActiveId = "";
  card.classList.add("hidden");
  setActionButtonsState("ready");
}

function resetShiftPanel() {
  activeShiftRecord = null;
  lastNotifiedActiveId = "";
  const card = document.getElementById("shiftStatusCard");
  if (card) card.classList.add("hidden");
  setActionButtonsState("ready");
}

function clearEmployeeForm() {
  document.getElementById("inputNip").value = "";
  document.getElementById("inputNama").value = "";
  lastNotifiedActiveId = "";
  if (typeof APP_CONFIG !== "undefined") {
    localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP);
  }
  resetShiftPanel();
}

// ==================== PROSES CHECK IN & CHECK OUT BERULANG ====================
async function processAttendance(type) {
  if (isProcessingAttendance) return;

  // Baca input secara menyeluruh (mendukung autofill browser HP & fallback selector)
  const nipEl = document.getElementById("inputNip") || document.querySelector('input[inputmode="numeric"]');
  const namaEl = document.getElementById("inputNama") || document.querySelector('input[autocomplete="name"]');

  const nip = nipEl ? String(nipEl.value || nipEl.getAttribute("value") || "").replace(/\s+/g, " ").trim() : "";
  const name = namaEl ? String(namaEl.value || namaEl.getAttribute("value") || "").replace(/\s+/g, " ").trim() : "";

  if (!nip || !name) {
    showToast("NIP dan Nama Lengkap wajib diisi.", "error");
    if (!nip && nipEl) nipEl.focus();
    else if (!name && namaEl) namaEl.focus();
    return;
  }

  isProcessingAttendance = true;
  clearTimeout(lookupDebounceTimer);
  clearTimeout(checkoutResetTimer);

  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  const spinner = document.getElementById("nipLookupSpinner");

  if (btnIn) btnIn.disabled = true;
  if (btnOut) btnOut.disabled = true;
  if (spinner) spinner.classList.remove("hidden");

  try {
    const todayStr = getTodayDateISO();
    const standardMins = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.STANDARD_WORK_MINUTES : 540;

    // Sinkronisasi cepat dari Cloud sebelum keputusan Check In / Check Out
    const latest = await fetchCloudWithTimeout(4000);
    if (latest && Array.isArray(latest.records)) {
      attendanceRecords = latest.records;
      updateSyncBadge(latest.source);
    }

    if (type === "checkin") {
      // Hanya blokir jika masih ada sesi aktif yang BELUM Check Out
      const activeExisting = attendanceRecords.find(
        r =>
          (String(r.nip).trim() === nip ||
            String(r.name).trim().toLowerCase() === name.toLowerCase()) &&
          isRecordActive(r)
      );

      if (activeExisting) {
        lastNotifiedActiveId = activeExisting.id;
        evaluateEmployeeStatus({ notifyToast: false, autoFillPair: true });
        showToast(
          `Anda belum melakukan Check Out! Sesi masuk pukul ${activeExisting.checkInTime} WIB masih aktif. Silakan tekan tombol Check Out.`,
          "warning"
        );
        return;
      }

      const now = new Date();
      const nowTs = now.getTime();
      const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      // Buat ID unik dengan timestamp sehingga sesi ke-2, ke-3, dst. tercatat sebagai baris terpisah
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
      if (typeof DataService !== "undefined") {
        DataService.saveLocalRecords(attendanceRecords);
      }
      if (typeof APP_CONFIG !== "undefined") {
        localStorage.setItem(APP_CONFIG.STORAGE_KEYS.LAST_NIP, nip);
      }

      lastNotifiedActiveId = newRecord.id;
      evaluateEmployeeStatus({ notifyToast: false, autoFillPair: false });
      showToast(`Check In berhasil pukul ${timeFormatted} WIB`, "success");

      if (typeof DataService !== "undefined") {
        await DataService.pushRecord(newRecord);
      }
    } else if (type === "checkout") {
      const idx = attendanceRecords.findIndex(
        r =>
          (String(r.nip).trim() === nip ||
            String(r.name).trim().toLowerCase() === name.toLowerCase()) &&
          isRecordActive(r)
      );

      if (idx === -1) {
        showToast("Data Check In aktif tidak ditemukan atau sudah Check Out sebelumnya.", "error");
        evaluateEmployeeStatus({ notifyToast: false, autoFillPair: false });
        return;
      }

      const now = new Date();
      const nowTs = now.getTime();
      const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      const record = attendanceRecords[idx];
      const durationMinutes = Math.max(1, Math.floor((nowTs - Number(record.checkInTs)) / 60000));
      const overtimeMinutes = Math.max(0, durationMinutes - standardMins);

      record.checkOutTime = timeFormatted;
      record.checkOutTs = nowTs;
      record.durationMinutes = durationMinutes;
      record.overtimeMinutes = overtimeMinutes;
      record.status = "Selesai";

      attendanceRecords[idx] = record;
      if (typeof DataService !== "undefined") {
        DataService.saveLocalRecords(attendanceRecords);
      }

      evaluateEmployeeStatus({ notifyToast: false, autoFillPair: false });
      showToast(`Check Out berhasil (${formatMinutesToHm(durationMinutes)}). Siap untuk Check In berikutnya...`, "success");

      if (typeof DataService !== "undefined") {
        await DataService.pushRecord(record);
      }

      // Bersihkan input setelah 2 detik agar pegawai langsung bisa Check In ulang bila diperlukan
      checkoutResetTimer = setTimeout(() => {
        clearEmployeeForm();
      }, 2000);
    }
  } catch (error) {
    console.error("Error saat memproses absensi:", error);
    showToast("Terjadi gangguan saat memproses: " + error.message, "error");
    evaluateEmployeeStatus({ notifyToast: false, autoFillPair: false });
  } finally {
    isProcessingAttendance = false;
    if (spinner) spinner.classList.add("hidden");
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
  const validPin = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.ADMIN_PIN : "123456";
  if (entered === validPin) {
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

    evaluateEmployeeStatus({ notifyToast: false, autoFillPair: true });
  }
}

async function syncFromCloud(showNotification = true) {
  const icon = document.getElementById("refreshIcon");
  if (icon) icon.classList.add("fa-spin");

  const result = await fetchCloudWithTimeout(6000);
  if (result && Array.isArray(result.records)) {
    attendanceRecords = result.records;
    updateSyncBadge(result.source);
    renderAdminTable();
    if (showNotification) {
      showToast(
        result.source === "cloud"
          ? "Data tersinkronisasi dengan Google Sheets."
          : "Menampilkan data penyimpanan lokal.",
        "success"
      );
    }
  } else {
    renderAdminTable();
    if (showNotification) {
      showToast("Menampilkan data lokal (koneksi cloud lambat/offline).", "warning");
    }
  }

  if (icon) icon.classList.remove("fa-spin");
}

function getFilteredRecords() {
  const keyword = (document.getElementById("adminSearchInput").value || "").toLowerCase().trim();
  const dateFilter = document.getElementById("adminDateFilter").value;

  return attendanceRecords.filter(rec => {
    const matchKeyword =
      !keyword ||
      String(rec.nip).toLowerCase().includes(keyword) ||
      String(rec.name).toLowerCase().includes(keyword);
    const matchDate = !dateFilter || rec.date === dateFilter;
    return matchKeyword && matchDate;
  });
}

function renderAdminTable() {
  const filtered = getFilteredRecords();
  const tbody = document.getElementById("adminTableBody");
  const standardMins = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.STANDARD_WORK_MINUTES : 540;

  let workingCount = 0;
  let completedCount = 0;
  let totalOvertimeMins = 0;

  filtered.forEach(r => {
    if (isRecordActive(r)) {
      workingCount++;
      const runningMins = Math.max(0, Math.floor((Date.now() - Number(r.checkInTs)) / 60000));
      totalOvertimeMins += Math.max(0, runningMins - standardMins);
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

  tbody.innerHTML = filtered
    .map(rec => {
      let durMins = rec.durationMinutes;
      let otMins = rec.overtimeMinutes;
      const active = isRecordActive(rec);

      if (active) {
        durMins = Math.max(0, Math.floor((Date.now() - Number(rec.checkInTs)) / 60000));
        otMins = Math.max(0, durMins - standardMins);
      }

      const statusBadge = active
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-[#003D79]"><span class="w-1.5 h-1.5 rounded-full bg-[#0072CE] animate-pulse"></span>Aktif</span>`
        : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">Selesai</span>`;

      const otBadge =
        otMins > 0
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
          <button type="button" onclick="deleteRecord('${rec.id}')" title="Hapus catatan" class="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>`;
    })
    .join("");
}

function resetAdminFilter() {
  document.getElementById("adminSearchInput").value = "";
  document.getElementById("adminDateFilter").value = "";
  renderAdminTable();
}

async function deleteRecord(id) {
  if (!confirm("Hapus catatan absensi ini?")) return;

  attendanceRecords = attendanceRecords.filter(r => String(r.id) !== String(id));
  if (typeof DataService !== "undefined") {
    DataService.saveLocalRecords(attendanceRecords);
  }
  renderAdminTable();
  showToast("Catatan berhasil dihapus.", "success");

  if (typeof DataService !== "undefined") {
    await DataService.deleteRecordCloud(id);
  }
}

// ==================== EKSPOR EXCEL & CSV ====================
function exportData(format) {
  const filtered = getFilteredRecords();
  if (filtered.length === 0) {
    showToast("Tidak ada data untuk diekspor.", "warning");
    return;
  }

  const standardMins = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.STANDARD_WORK_MINUTES : 540;

  const rows = filtered.map((rec, index) => {
    let durMins = rec.durationMinutes;
    let otMins = rec.overtimeMinutes;
    if (isRecordActive(rec)) {
      durMins = Math.max(0, Math.floor((Date.now() - Number(rec.checkInTs)) / 60000));
      otMins = Math.max(0, durMins - standardMins);
    }

    return {
      No: index + 1,
      Tanggal: rec.date,
      NIP: rec.nip,
      "Nama Lengkap": rec.name,
      "Check In": rec.checkInTime,
      "Check Out": rec.checkOutTime || "-",
      "Total Durasi": formatMinutesToHm(durMins),
      "Durasi (Menit)": durMins,
      Lembur: formatMinutesToHm(otMins),
      "Lembur (Menit)": otMins,
      Status: isRecordActive(rec) ? "Sedang Bekerja" : "Selesai"
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
  const result = await fetchCloudWithTimeout(6000);
  if (result && Array.isArray(result.records)) {
    attendanceRecords = result.records;
    updateSyncBadge(result.source);
    renderAdminTable();

    if (result.source === "cloud") {
      closeSheetModal();
      showToast("Berhasil terhubung ke Google Sheets!", "success");
      return;
    }
  }
  showToast("URL tersimpan, namun gagal membaca data. Pastikan akses Web App disetel ke 'Anyone'.", "warning");
}

function updateSyncBadge(sourceState) {
  const dot = document.getElementById("syncDot");
  const text = document.getElementById("syncText");
  if (!dot || !text) return;

  const hasUrl = typeof DataService !== "undefined" && Boolean(DataService.getActiveSheetUrl());

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
