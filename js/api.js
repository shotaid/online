/* ==========================================================================
   PresensiPro — Lapisan Data & Sinkronisasi Google Sheets
   ========================================================================== */

const DataService = {
  getActiveSheetUrl() {
    const saved = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.SHEET_URL);
    if (saved && saved.startsWith("http")) return saved.trim();
    if (APP_CONFIG.DEFAULT_APPS_SCRIPT_URL && APP_CONFIG.DEFAULT_APPS_SCRIPT_URL.startsWith("http")) {
      return APP_CONFIG.DEFAULT_APPS_SCRIPT_URL.trim();
    }
    return "";
  },

  setSheetUrl(url) {
    if (!url) {
      localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.SHEET_URL);
    } else {
      localStorage.setItem(APP_CONFIG.STORAGE_KEYS.SHEET_URL, url.trim());
    }
  },

  getLocalRecords() {
    try {
      const raw = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.RECORDS);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("Gagal membaca localStorage:", err);
      return [];
    }
  },

  saveLocalRecords(records) {
    localStorage.setItem(APP_CONFIG.STORAGE_KEYS.RECORDS, JSON.stringify(records));
  },

  async fetchAllRecords() {
    const url = this.getActiveSheetUrl();
    if (!url) {
      return { source: "local", records: this.getLocalRecords() };
    }

    try {
      const response = await fetch(url, { method: "GET" });
      const data = await response.json();
      if (data && data.status === "ok" && Array.isArray(data.records)) {
        this.saveLocalRecords(data.records);
        return { source: "cloud", records: data.records };
      }
      throw new Error("Format respons tidak valid");
    } catch (error) {
      console.warn("Menggunakan cache lokal karena gagal fetch cloud:", error);
      return { source: "offline-cache", records: this.getLocalRecords() };
    }
  },

  async pushRecord(record) {
    const url = this.getActiveSheetUrl();
    if (!url) return false;

    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "upsert", record })
      });
      return true;
    } catch (error) {
      console.error("Gagal mengirim data ke Google Sheets:", error);
      return false;
    }
  },

  async deleteRecordCloud(id) {
    const url = this.getActiveSheetUrl();
    if (!url) return false;

    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "delete", id })
      });
      return true;
    } catch (error) {
      console.error("Gagal menghapus data di Google Sheets:", error);
      return false;
    }
  }
};