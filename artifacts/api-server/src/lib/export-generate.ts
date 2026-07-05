import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";
import * as archiverNs from "archiver";
// @ts-expect-error — no bundled types; registers the "zip-encrypted" format.
import archiverZipEncrypted from "archiver-zip-encrypted";
import { AppError } from "../middlewares/errorHandler.js";

// @types/archiver v8 omits the top-level factory (`create`) and `registerFormat`,
// though both exist at runtime. Narrow shim so we keep types for the Archiver
// instance while reaching the untyped module functions.
const archiverModule = archiverNs as unknown as {
  create(format: string, options?: unknown): archiverNs.Archiver;
  registerFormat(format: string, module: unknown): void;
};

// Stage 4B — Export Center file generation. Turns a header + string matrix into
// a CSV / Excel / PDF / JSON buffer, and optionally wraps it in an AES-256
// encrypted ZIP when the export is password-protected. Pure of DB/storage.

export type ExportFormat = "csv" | "excel" | "pdf" | "json";

export function isExportFormat(v: unknown): v is ExportFormat {
  return v === "csv" || v === "excel" || v === "pdf" || v === "json";
}

// Register the encrypted-zip format exactly once per process.
let zipEncryptedRegistered = false;
function ensureZipEncrypted(): void {
  if (zipEncryptedRegistered) return;
  try {
    archiverModule.registerFormat("zip-encrypted", archiverZipEncrypted);
  } catch {
    // Already registered (another module or a prior call) — safe to ignore.
  }
  zipEncryptedRegistered = true;
}

export interface GenerateInput {
  format: ExportFormat;
  title: string;
  columns: string[]; // header labels
  rows: string[][]; // row values aligned to columns
}

const BASE_EXT: Record<ExportFormat, string> = { csv: "csv", excel: "xlsx", pdf: "pdf", json: "json" };
const BASE_MIME: Record<ExportFormat, string> = {
  csv: "text/csv",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  json: "application/json",
};

export function fileExtension(format: ExportFormat, encrypted: boolean): string {
  return encrypted ? "zip" : BASE_EXT[format];
}

export function contentType(format: ExportFormat, encrypted: boolean): string {
  return encrypted ? "application/zip" : BASE_MIME[format];
}

// CSV/Excel formula injection defense: spreadsheet apps evaluate a cell whose
// text begins with = + - @ (or a leading tab/CR) as a formula. Since exported
// values are user-controlled (names, notes, company, etc.), prefix any such
// value with a single quote so it renders as literal text instead of executing.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
export function neutralizeCell(v: string): string {
  return typeof v === "string" && FORMULA_TRIGGER.test(v) ? `'${v}` : v;
}

function generateSpreadsheet(input: GenerateInput, bookType: "csv" | "xlsx"): Buffer {
  const aoa = [input.columns, ...input.rows.map((row) => row.map(neutralizeCell))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Export");
  const out = XLSX.write(wb, { type: "buffer", bookType });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function generateJson(input: GenerateInput): Buffer {
  const records = input.rows.map((row) => {
    const obj: Record<string, string> = {};
    input.columns.forEach((col, i) => {
      obj[col] = row[i] ?? "";
    });
    return obj;
  });
  return Buffer.from(JSON.stringify(records, null, 2), "utf-8");
}

// Simple, robust PDF table. Columns share the page width evenly; long cell text
// wraps within its column; rows that overflow the page start a new page with the
// header re-drawn. Kept intentionally compact rather than pixel-perfect.
async function generatePdf(input: GenerateInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageLeft = doc.page.margins.left;
      const pageRight = doc.page.width - doc.page.margins.right;
      const usableWidth = pageRight - pageLeft;
      const colCount = Math.max(1, input.columns.length);
      const colWidth = usableWidth / colCount;
      const cellPad = 3;
      const fontSize = 7;

      doc.fontSize(14).text(input.title, { align: "left" });
      doc.moveDown(0.5);

      const drawRow = (values: string[], bold: boolean): void => {
        doc.fontSize(fontSize).font(bold ? "Helvetica-Bold" : "Helvetica");
        const cellWidth = colWidth - cellPad * 2;
        let rowHeight = 0;
        for (let i = 0; i < colCount; i++) {
          const text = values[i] ?? "";
          const h = doc.heightOfString(text, { width: cellWidth });
          if (h > rowHeight) rowHeight = h;
        }
        rowHeight = Math.max(rowHeight, fontSize + 2) + cellPad * 2;

        // Page break if the row does not fit.
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
        const top = doc.y;
        for (let i = 0; i < colCount; i++) {
          const x = pageLeft + i * colWidth;
          doc.text(values[i] ?? "", x + cellPad, top + cellPad, { width: cellWidth, height: rowHeight, ellipsis: true });
        }
        doc
          .moveTo(pageLeft, top + rowHeight)
          .lineTo(pageRight, top + rowHeight)
          .strokeColor("#dddddd")
          .lineWidth(0.5)
          .stroke();
        doc.y = top + rowHeight;
      };

      drawRow(input.columns, true);
      for (const row of input.rows) drawRow(row, false);
      if (input.rows.length === 0) {
        doc.moveDown(1).fontSize(10).font("Helvetica").text("No records.", { align: "left" });
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// Produce the inner (unencrypted) file buffer for a format.
export async function generateFile(input: GenerateInput): Promise<Buffer> {
  switch (input.format) {
    case "csv":
      return generateSpreadsheet(input, "csv");
    case "excel":
      return generateSpreadsheet(input, "xlsx");
    case "json":
      return generateJson(input);
    case "pdf":
      return generatePdf(input);
    default:
      throw new AppError(400, "Unsupported export format");
  }
}

// Wrap a produced buffer in a single-entry AES-256 encrypted ZIP.
export async function encryptZip(buffer: Buffer, innerName: string, password: string): Promise<Buffer> {
  ensureZipEncrypted();
  return new Promise<Buffer>((resolve, reject) => {
    // The encrypted format is registered dynamically; options are passed through.
    const archive = archiverModule.create("zip-encrypted", {
      zlib: { level: 9 },
      encryptionMethod: "aes256",
      password,
    });
    const chunks: Buffer[] = [];
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.append(buffer, { name: innerName });
    void archive.finalize();
  });
}
