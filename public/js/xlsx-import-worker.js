/* SheetJS CE 0.20.3 is vendored locally under Apache-2.0. */
importScripts('../vendor/sheetjs/xlsx.mini.min.js');

const MAX_ROWS = 500;
const FIELD_ALIASES = new Map([
  ['姓名', 'displayName'],
  ['姓名稱呼', 'displayName'],
  ['name', 'displayName'],
  ['displayname', 'displayName'],
  ['fullname', 'displayName'],
  ['聯絡方式', 'contact'],
  ['聯絡', 'contact'],
  ['contact', 'contact'],
  ['contactinfo', 'contact'],
  ['phone', 'contact'],
  ['email', 'contact'],
  ['來源管道', 'channel'],
  ['管道', 'channel'],
  ['channel', 'channel'],
  ['sourcechannel', 'channel'],
  ['唯一來源參考編號', 'sourceReference'],
  ['來源參考編號', 'sourceReference'],
  ['sourcereference', 'sourceReference'],
  ['sourceref', 'sourceReference'],
]);
const REQUIRED_FIELDS = ['displayName', 'contact', 'channel', 'sourceReference'];
const FIELD_LABELS = {
  displayName: '姓名',
  contact: '聯絡方式',
  channel: '來源管道',
  sourceReference: '唯一來源參考編號',
};

function normalizeHeader(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-/（）()]+/g, '');
}

function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function meaningfulCell(cell) {
  if (!cell || cell.t === 'z') return false;
  if (owns(cell, 'f') || owns(cell, 'F') || owns(cell, 'l')) return true;
  if (cell.v === null || cell.v === undefined) return false;
  return cell.t !== 's' || String(cell.v).trim() !== '';
}

function actualCells(worksheet) {
  return Object.entries(worksheet).filter(([address, cell]) => address[0] !== '!' && meaningfulCell(cell));
}

function valuesByRow(cells) {
  const rows = new Map();
  cells.forEach(([address, cell]) => {
    const position = XLSX.utils.decode_cell(address);
    if (!rows.has(position.r)) rows.set(position.r, new Map());
    rows.get(position.r).set(position.c, cell.v);
  });
  return rows;
}

function mapHeaders(headers) {
  const indexes = {};
  const errors = [];
  headers.forEach((header, columnIndex) => {
    const field = FIELD_ALIASES.get(normalizeHeader(header));
    if (!field) return;
    if (indexes[field] !== undefined) errors.push(`標題列重複「${FIELD_LABELS[field]}」欄位。`);
    else indexes[field] = columnIndex;
  });
  REQUIRED_FIELDS.forEach((field) => {
    if (indexes[field] === undefined) errors.push(`標題列缺少「${FIELD_LABELS[field]}」欄位。`);
  });
  return { indexes, errors };
}

function cellAt(worksheet, rowIndex, columnIndex) {
  return worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
}

function normalizeRow(worksheet, values, rowIndex, indexes, seenReferences) {
  const rowNumber = rowIndex + 1;
  const errors = [];
  const output = {};

  for (const field of REQUIRED_FIELDS) {
    const columnIndex = indexes[field];
    const cell = cellAt(worksheet, rowIndex, columnIndex);
    const value = values.get(columnIndex);
    if (field === 'contact' && (cell?.t === 'n' || typeof value === 'number')) errors.push(`第 ${rowNumber} 列「聯絡方式」是數字格式；電話必須設為文字以保留前導零。`);
    if (value !== null && value !== undefined && typeof value !== 'string') {
      if (!(field === 'contact' && typeof value === 'number')) errors.push(`第 ${rowNumber} 列「${FIELD_LABELS[field]}」必須使用文字格式。`);
      output[field] = String(value);
    } else output[field] = String(value ?? '').trim();
    if (!output[field]) errors.push(`第 ${rowNumber} 列缺少「${FIELD_LABELS[field]}」。`);
  }

  const referenceKey = output.sourceReference?.toLocaleLowerCase('en-US');
  if (referenceKey) {
    if (seenReferences.has(referenceKey)) errors.push(`第 ${rowNumber} 列「唯一來源參考編號」在本批重複。`);
    else seenReferences.add(referenceKey);
  }

  if (errors.length) return { errors };
  const contact = output.contact;
  return {
    errors,
    row: {
      displayName: output.displayName,
      contact,
      ...(contact.includes('@') ? { email: contact } : { phone: contact }),
      channel: output.channel,
      sourceReference: output.sourceReference,
    },
  };
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, {
    type: 'array',
    dense: false,
    cellFormula: true,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    bookDeps: false,
    bookVBA: false,
  });
  const populated = workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    return { sheetName, worksheet, cells: actualCells(worksheet) };
  }).filter(({ cells }) => cells.length);

  if (populated.length !== 1) {
    return { rows: [], errors: [`Excel 必須只有一個非空白工作表；目前找到 ${populated.length} 個。`], sheetName: '' };
  }

  const [{ sheetName, worksheet, cells }] = populated;
  if (cells.length > 10_000) return { rows: [], errors: ['Excel 實際儲存格過多；請只保留匯入所需的 4 欄與 500 列。'], sheetName };
  const unsafeCellErrors = cells.flatMap(([address, cell]) => {
    const rowNumber = XLSX.utils.decode_cell(address).r + 1;
    return [
      ...(owns(cell, 'f') || owns(cell, 'F') ? [`第 ${rowNumber} 列儲存格 ${address} 含公式，不可匯入。`] : []),
      ...(owns(cell, 'l') ? [`第 ${rowNumber} 列儲存格 ${address} 含超連結，不可匯入。`] : []),
    ];
  });
  const rows = valuesByRow(cells);
  const header = rows.get(0) || new Map();
  const lastHeaderColumn = Math.max(-1, ...header.keys());
  const headerValues = Array.from({ length: lastHeaderColumn + 1 }, (_value, index) => header.get(index));
  const { indexes, errors } = mapHeaders(headerValues);
  if (errors.length) return { rows: [], errors, sheetName };
  const dataRows = [...rows.entries()].filter(([rowIndex]) => rowIndex > 0).sort(([left], [right]) => left - right);
  if (dataRows.length > MAX_ROWS) return { rows: [], errors: [`Excel 最多可匯入 ${MAX_ROWS} 列；目前為 ${dataRows.length} 列。`], sheetName };

  const validRows = [];
  const rowErrors = [...unsafeCellErrors];
  const seenReferences = new Set();
  dataRows.forEach(([rowIndex, values]) => {
    const result = normalizeRow(worksheet, values, rowIndex, indexes, seenReferences);
    if (result.row) validRows.push(result.row);
    rowErrors.push(...result.errors);
  });
  if (!validRows.length && !rowErrors.length) rowErrors.push('Excel 工作表沒有資料列。');
  return { rows: validRows, errors: rowErrors, sheetName };
}

function writeWorkbook(rows) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true });
}

self.addEventListener('message', (event) => {
  if (!['parse-xlsx', 'write-xlsx'].includes(event.data?.type)) return;
  try {
    if (event.data.type === 'write-xlsx') {
      const buffer = writeWorkbook(event.data.rows || []);
      self.postMessage({ type: 'xlsx-result', requestId: event.data.requestId, buffer }, [buffer]);
    } else self.postMessage({ type: 'xlsx-result', requestId: event.data.requestId, ...parseWorkbook(event.data.buffer) });
  } catch (error) {
    self.postMessage({
      type: 'xlsx-result',
      requestId: event.data.requestId,
      rows: [],
      errors: [`Excel 無法解析：${error instanceof Error ? error.message : String(error)}`],
      sheetName: '',
    });
  }
});
