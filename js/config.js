/* ==========================================================================
   PresensiPro — Konfigurasi Sistem & Kode Template Google Apps Script
   ========================================================================== */

const APP_CONFIG = {
  // Ganti teks di bawah dengan URL Web App Google Apps Script Anda agar semua HP langsung terhubung
  DEFAULT_APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzojHsL-HKknkiUdO5FL2OL1rFJ4OuWQANnTzpgMQIrrNQEyH4TXd9HXe7r9skG37c-/exec",

  // PIN Default untuk masuk ke Dashboard Admin
  ADMIN_PIN: "123456",

  // Standar waktu kerja normal dalam menit (9 jam = 540 menit)
  STANDARD_WORK_MINUTES: 9 * 60,

  // Kunci penyimpanan lokal browser
  STORAGE_KEYS: {
    RECORDS: "presensipro_records_v2",
    SHEET_URL: "presensipro_sheet_url_v2",
    LAST_NIP: "presensipro_last_nip_v2",
    CUSTOM_ADMIN_PIN: "presensipro_custom_admin_pin_v1"
  }
};

// Template kode Code.gs untuk disalin ke Google Apps Script
const APPS_SCRIPT_TEMPLATE = `const SHEET_NAME = "Absensi";

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["ID", "Tanggal", "NIP", "Nama", "CheckInTime", "CheckOutTime", "CheckInTS", "CheckOutTS", "DurasiMenit", "LemburMenit", "Status"]);
  }
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    rows.push({
      id: String(data[i][0]),
      date: String(data[i][1]),
      nip: String(data[i][2]),
      name: String(data[i][3]),
      checkInTime: String(data[i][4]),
      checkOutTime: String(data[i][5]),
      checkInTs: Number(data[i][6]),
      checkOutTs: data[i][7] ? Number(data[i][7]) : null,
      durationMinutes: Number(data[i][8]) || 0,
      overtimeMinutes: Number(data[i][9]) || 0,
      status: String(data[i][10])
    });
  }
  return ContentService.createTextOutput(JSON.stringify({ status: "ok", records: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["ID", "Tanggal", "NIP", "Nama", "CheckInTime", "CheckOutTime", "CheckInTS", "CheckOutTS", "DurasiMenit", "LemburMenit", "Status"]);
  }
  const payload = JSON.parse(e.postData.contents);
  const data = sheet.getDataRange().getValues();

  if (payload.action === "delete") {
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(payload.id)) {
        sheet.deleteRow(i + 1);
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "deleted" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const rec = payload.record;
  let foundRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(rec.id)) {
      foundRow = i + 1;
      break;
    }
  }

  const rowValues = [
    rec.id,
    rec.date,
    rec.nip,
    rec.name,
    rec.checkInTime,
    rec.checkOutTime || "-",
    rec.checkInTs,
    rec.checkOutTs || "",
    rec.durationMinutes || 0,
    rec.overtimeMinutes || 0,
    rec.status
  ];

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "saved" }))
    .setMimeType(ContentService.MimeType.JSON);
}`;
